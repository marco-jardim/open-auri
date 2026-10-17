import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import fc from 'fast-check';
import {
  EnvelopeError,
  normalizeText,
  normalizeEnvelope,
  validateEnvelope,
  serializeEnvelope,
  parseEnvelope,
} from '../../src/share/envelope.mjs';
import { encodeS1 } from '../../src/share/s1.mjs';
import { parseEqualizerApo } from '../../src/io/equalizer-apo.mjs';

const { presets } = JSON.parse(
  readFileSync(new URL('../fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);
const schema = JSON.parse(
  readFileSync(new URL('../../schemas/preset-envelope-1.schema.json', import.meta.url), 'utf8'),
);
// Decimal S1 grids use binary JS numbers; precision avoids false multipleOf failures.
const ajv = new Ajv2020({ allErrors: true, multipleOfPrecision: 8 });
const schemaValidate = ajv.compile(schema);
const base = {
  format: 'open-auri/preset@1',
  name: 'Padrão',
  description: '',
  source: 'preset:padrao',
  license: 'CC0-1.0',
  code: encodeS1({ bands: presets.padrao.eqBands, preampDb: presets.padrao.preampDb }),
  preampDb: presets.padrao.preampDb,
  bands: presets.padrao.eqBands,
  lang: 'pt-BR',
  createdAt: '2026-10-16T12:34:56.789Z',
};
const recipe = {
  measurement: { source: 'local', name: 'My measurement', sha256: 'a'.repeat(64) },
  target: { source: 'custom', name: 'Flat' },
  solver: { name: 'peq', version: '1.0.0' },
  params: { iterations: 30, enabled: true, note: 'reference', unset: null },
};

const copy = () => structuredClone(base);
const withField = (key, value) => ({ ...copy(), [key]: value });
const without = (key) => {
  const value = copy();
  delete value[key];
  return value;
};
const withBand = (band, coherent = false) => {
  const value = copy();
  value.bands[0] = band;
  if (coherent) value.code = encodeS1(value);
  return value;
};
const withRecipe = (value) => withField('recipe', value);

/** @param {string} ascii @returns {string} */
const tagFlag = (ascii) =>
  `🏴${[...ascii]
    .map((character) => String.fromCodePoint(0xe0000 + character.charCodeAt(0)))
    .join('')}\u{e007f}`;

function expectIssue(value, code, path, validate = validateEnvelope) {
  const result = validate(value);
  assert.equal(result.ok, false, JSON.stringify(value));
  assert.ok(
    result.errors.some(
      (error) => error.code === code && (path === undefined || error.path === path),
    ),
    JSON.stringify(result.errors),
  );
  for (const error of result.errors) {
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
  }
  return result.errors;
}

// Shared corpus: structural inputs are already normalized; semantic-only cases
// deliberately pass schema but fail runtime, or normalize to a different length.
const corpus = [];
const structural = (name, value, valid) => corpus.push({ name, value, valid, semantic: false });
const semantic = (name, value, valid) => corpus.push({ name, value, valid, semantic: true });

structural('official padrao', copy(), true);
for (const value of [null, [], 1, 'preset', true]) structural('root type', value, false);
for (const key of [
  'format',
  'name',
  'source',
  'license',
  'code',
  'preampDb',
  'bands',
  'lang',
  'createdAt',
]) {
  structural(`required ${key}`, without(key), false);
}
structural('optional description', without('description'), true);
structural('extra root', withField('unknown', 1), false);
for (const key of [
  'format',
  'name',
  'description',
  'author',
  'source',
  'license',
  'code',
  'lang',
  'createdAt',
]) {
  structural(`${key} type`, withField(key, 42), false);
}
for (const [key, value] of [
  ['format', 'open-auri/preset@2'],
  ['name', ''],
  ['name', 'x'.repeat(49)],
  ['description', 'x'.repeat(281)],
  ['author', 'x'.repeat(25)],
  ['source', 'official'],
  ['source', 'preset:'],
  ['source', 'community:bad.id'],
  ['source', 'custom\n'],
  ['source', `preset:${'x'.repeat(65)}`],
  ['license', 'MIT'],
  ['lang', 'en'],
  ['code', 'Q'.repeat(67)],
  ['code', '+'.repeat(68)],
  ['createdAt', '2026-10-16'],
  ['createdAt', '2026-10-16T12:34:56+00:00'],
  ['createdAt', '2026-13-16T12:34:56Z'],
  ['createdAt', '2026-10-16T24:34:56Z'],
  ['createdAt', '2026-10-16T12:34:56.1234Z'],
  ['createdAt', '2026-10-16T12:34:56Z\n'],
  ['description', '1\n2\n3\n4\n5\n6'],
  ['name', 'Bad\tname'],
  ['author', 'bad\u0085name'],
  ['description', 'bad\rdescription'],
  ['preampDb', '0'],
  ['preampDb', 1],
  ['preampDb', -25.6],
  ['preampDb', -2.85],
  ['bands', {}],
  ['bands', []],
  ['bands', [...base.bands, { kind: 'OFF' }]],
]) {
  structural(`${key}: ${JSON.stringify(value)}`, withField(key, value), false);
}
for (const [key, value] of [
  ['name', 'x'.repeat(48)],
  ['name', '🎧'.repeat(48)],
  ['description', 'x'.repeat(280)],
  ['description', '1\n2\n3\n4\n5'],
  ['author', null],
  ['author', ''],
  ['author', 'x'.repeat(24)],
  ['source', 'custom'],
  ['source', 'import'],
  ['source', 'community:A_b-123'],
  ['source', `community:${'x'.repeat(64)}`],
  ['license', 'CC-BY-4.0'],
  ['lang', 'en-US'],
  ['createdAt', '2024-02-29T00:00:00Z'],
  ['createdAt', '2026-10-16T12:34:56.1Z'],
  ['createdAt', '2026-10-16T12:34:56.12Z'],
]) {
  structural(`${key} valid boundary`, withField(key, value), true);
}

for (const band of [
  null,
  [],
  3,
  {},
  { kind: 'BAD' },
  { kind: 'OFF', gainDb: 0 },
  { kind: 'LP', freqHz: 100, gainDb: 0, qFactor: 1 },
  { kind: 'HP', freqHz: 100, gainDb: 0, qFactor: 1 },
  { kind: 'HP', freqHz: 100 },
  { kind: 'PK', freqHz: 100, qFactor: 1 },
  { kind: 'PK', freqHz: 0, gainDb: 0, qFactor: 1 },
  { kind: 'PK', freqHz: 20001, gainDb: 0, qFactor: 1 },
  { kind: 'PK', freqHz: 25.5, gainDb: 0, qFactor: 1 },
  { kind: 'PK', freqHz: '25', gainDb: 0, qFactor: 1 },
  { kind: 'PK', freqHz: 25, gainDb: -25.7, qFactor: 1 },
  { kind: 'PK', freqHz: 25, gainDb: 12.8, qFactor: 1 },
  { kind: 'PK', freqHz: 25, gainDb: 0.15, qFactor: 1 },
  { kind: 'PK', freqHz: 25, gainDb: 0, qFactor: 0 },
  { kind: 'PK', freqHz: 25, gainDb: 0, qFactor: 20.48 },
  { kind: 'PK', freqHz: 25, gainDb: 0, qFactor: 0.015 },
  { kind: 'PK', freqHz: 25, gainDb: 0, qFactor: 1, extra: true },
]) {
  structural(`invalid band ${JSON.stringify(band)}`, withBand(band), false);
}
for (const band of [
  { kind: 'OFF' },
  { kind: 'LP', freqHz: 1, qFactor: 0.01 },
  { kind: 'HP', freqHz: 20000, qFactor: 20.47 },
  { kind: 'PK', freqHz: 1, gainDb: -25.6, qFactor: 0.01 },
  { kind: 'LS', freqHz: 20000, gainDb: 12.7, qFactor: 20.47 },
  { kind: 'HS', freqHz: 250, gainDb: 1.1, qFactor: 1.23 },
]) {
  structural(`valid band ${band.kind}`, withBand(band, true), true);
}
for (const preampDb of [0, -25.5]) {
  const value = withField('preampDb', preampDb);
  value.code = encodeS1(value);
  structural('preamp boundary', value, true);
}

structural('complete recipe', withRecipe(recipe), true);
structural('empty recipe', withRecipe({}), true);
structural('empty params', withRecipe({ params: {} }), true);
for (const value of [null, [], 'recipe', { extra: true }]) {
  structural('recipe type or extra', withRecipe(value), false);
}
for (const key of ['measurement', 'target', 'solver']) {
  const fields = key === 'solver' ? ['name', 'version'] : ['source', 'name'];
  for (const part of [null, [], 1, {}, { ...recipe[key], extra: 0 }]) {
    structural(`${key} type/required/extra`, withRecipe({ [key]: part }), false);
  }
  for (const field of fields) {
    const max = field === 'version' ? 32 : field === 'name' && key !== 'solver' ? 120 : 64;
    for (const entry of [null, '', 'x'.repeat(max + 1)]) {
      structural(
        `${key}/${field} invalid`,
        withRecipe({ [key]: { ...recipe[key], [field]: entry } }),
        false,
      );
    }
    const missing = { ...recipe[key] };
    delete missing[field];
    structural(`${key}/${field} required`, withRecipe({ [key]: missing }), false);
    const maximum = field === 'version' ? `1.0.0+${'a'.repeat(26)}` : 'x'.repeat(max);
    structural(
      `${key}/${field} max`,
      withRecipe({ [key]: { ...recipe[key], [field]: maximum } }),
      true,
    );
    structural(
      `${key}/${field} over max`,
      withRecipe({ [key]: { ...recipe[key], [field]: `${maximum}a` } }),
      false,
    );
  }
}
for (const key of ['measurement', 'target']) {
  for (const name of [
    'HD600.csv',
    'Sennheiser HD 600 (oratory1990).csv',
    "Medição_東京 １２.0 (+1), O'Brien & Sons-dataset.csv".normalize('NFKC'),
    ...['csv', 'txt', 'json', 'frd', 'zma', 'mdat', 'wav', 'rew'].flatMap((extension) => [
      `HD600.${extension}`,
      `HD600.${extension.toUpperCase()}`,
    ]),
    'x'.repeat(120),
  ]) {
    structural(`${key} filename ${name}`, withRecipe({ [key]: { ...recipe[key], name } }), true);
  }
  for (const name of [
    'evil.com',
    'bit.ly',
    't.me',
    'x evil.com.csv',
    'Promo em evil.com agora',
    'evil.com.CsV',
    'HD600.csv.csv',
    'HD600.csv.txt',
    'HD600.zip',
    'grave.Agudo.csv',
  ]) {
    semantic(
      `${key} filename link ${name}`,
      withRecipe({ [key]: { ...recipe[key], name } }),
      false,
    );
  }
  for (const name of [
    'https://host',
    'custom://host',
    'www.dataset',
    'WWW.dataset',
    'user@host',
    'folder/name.csv',
    'folder\\name.csv',
    'bad:name.csv',
    'bad;name.csv',
    'bad[name].csv',
    'emoji🎧.csv',
    'x'.repeat(121),
  ]) {
    structural(
      `${key} forbidden filename ${name}`,
      withRecipe({ [key]: { ...recipe[key], name } }),
      false,
    );
  }
}
for (const version of [
  '0.0.0',
  '1.0.0-alpha',
  '1.0.0-alpha.0.3.7',
  '1.0.0-beta.12',
  '1.0.0-rc.1',
  '1.0.0-dev',
  '1.0.0-pre.1.2',
  '1.0.0+0',
  '1.0.0+ABCDEF0123456789',
  '1.0.0-beta+5114f85',
]) {
  structural(`SemVer ${version}`, withRecipe({ solver: { ...recipe.solver, version } }), true);
}
for (const version of [
  '1',
  '1.0',
  'v1.0.0',
  '01.0.0',
  '1.01.0',
  '1.0.01',
  '1.0.0-01',
  '1.0.0-alpha.01',
  '1.0.0-alpha.1.01',
  '1.0.0-alpha.1a',
  '1.0.0-alpha.beta',
  '1.0.0-0.3.7',
  '1.0.0-x.7.z.92',
  '1.0.0-1a.01a.-',
  '1.0.0+001.build.01',
  '1.0.0-beta+exp.sha.5114f85',
  '1.0.0-www.evil.com',
  '1.0.0+evil.com',
  '1.0.0-bit.ly',
  '1.0.0-preview',
  '1.0.0-RC.1',
  '1.0.0+g',
  `1.0.0+${'a'.repeat(40)}`, // Preserve the existing 32-code-point total limit.
  `1.0.0+${'a'.repeat(41)}`,
  '1.0.0-',
  '1.0.0-alpha..beta',
  '1.0.0-alpha_beta',
  '1.0.0+',
  '1.0.0+build..1',
  '1.0.0+build_1',
  'https://host',
]) {
  structural(
    `invalid SemVer ${version}`,
    withRecipe({ solver: { ...recipe.solver, version } }),
    false,
  );
}
for (const sha256 of [null, 'a'.repeat(63), 'g'.repeat(64), `${'a'.repeat(64)}\n`]) {
  structural(
    'sha256 invalid',
    withRecipe({ measurement: { ...recipe.measurement, sha256 } }),
    false,
  );
}
structural('sha256 absent', withRecipe({ measurement: { source: 'local', name: 'A' } }), true);
structural(
  'sha256 uppercase',
  withRecipe({ measurement: { ...recipe.measurement, sha256: 'A'.repeat(64) } }),
  true,
);
for (const params of [
  null,
  [],
  { a: {} },
  { a: [] },
  { 'bad.key': 1 },
  { '': 1 },
  { a: 'x'.repeat(129) },
  Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, i])),
]) {
  structural('params invalid', withRecipe({ params }), false);
}
structural('params boundary', withRecipe({ params: { ['a'.repeat(32)]: 'x'.repeat(128) } }), true);
structural(
  'params 32',
  withRecipe({ params: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`p${i}`, i])) }),
  true,
);
structural('params key too long', withRecipe({ params: { ['a'.repeat(33)]: 0 } }), false);

semantic('URL name', withField('name', 'https://example.com'), false);
semantic('domain description', withField('description', 'Read example.ORG'), false);
semantic('URL recipe', withRecipe({ target: { source: 'www.example', name: 'Flat' } }), false);
semantic('normalized expanded name', withField('name', 'ﬃ'.repeat(17)), false);
semantic('normalized collapsed name', withField('name', `  ${'x'.repeat(48)}  `), true);
semantic('normalized empty name', withField('name', '\u202e\u200d'), false);
semantic('calendar day', withField('createdAt', '2026-02-30T00:00:00Z'), false);
semantic('wrong S1 version', withField('code', 'A'.repeat(68)), false);
semantic('wrong S1 CRC', withField('code', `${base.code.slice(0, -1)}A`), false);
semantic('different band', withBand({ ...base.bands[0], freqHz: 26 }), false);
semantic('different preamp', withField('preampDb', -2.9), false);
const reversed = copy();
reversed.bands.reverse();
semantic('different wire order', reversed, false);

test('shared structural corpus agrees with Ajv 2020; semantic exclusions are explicit', (t) => {
  const structuralCases = corpus.filter((entry) => !entry.semantic);
  assert.ok(structuralCases.length >= 30, String(structuralCases.length));
  assert.equal(corpus.filter((entry) => entry.semantic).length, 32);
  t.diagnostic(`${structuralCases.length} structural cases; 32 tagged semantic exclusions`);
  for (const { name, value, valid, semantic: excluded } of corpus) {
    const result = validateEnvelope(value);
    assert.equal(result.ok, valid, `${name}: ${JSON.stringify(result)}`);
    if (result.ok) assert.deepEqual(parseEnvelope(serializeEnvelope(value)), result, name);
    if (!excluded) {
      const schemaOk = schemaValidate(value);
      assert.equal(schemaOk, valid, `${name}: ${ajv.errorsText(schemaValidate.errors)}`);
      assert.equal(result.ok, schemaOk, name);
    }
  }
});

test('official base and complete recipe round-trip; optional description is defaulted', () => {
  assert.equal(base.code, 'QABn8AeACW8QRQIvc4I0EPzhksBNe1pEAcCs4SwKzfOEsAIID4UQL5hyJcF2sRA7HLwv');
  for (const input of [
    copy(),
    withRecipe(recipe),
    without('description'),
    withField('author', null),
  ]) {
    const result = validateEnvelope(input);
    assert.equal(result.ok, true);
    assert.equal(result.value.description, '');
    assert.deepEqual(parseEnvelope(serializeEnvelope(input)), result);
  }
});

test('recipe names keep one approved extension but refuse domains and link text', () => {
  for (const key of ['measurement', 'target']) {
    const input = withRecipe({ [key]: { ...recipe[key], name: '  ＨＤ６００.CsV  ' } });
    const result = validateEnvelope(input);
    assert.equal(result.ok, true);
    assert.equal(result.value.recipe[key].name, 'HD600.CsV');
    assert.equal(schemaValidate(result.value), true);
    assert.deepEqual(parseEnvelope(serializeEnvelope(input)), result);
    for (const name of [
      'evil.com',
      'bit.ly',
      't.me',
      'x evil.com.csv',
      'Promo em evil.com agora',
      'evil.com.CsV',
      'HD600.csv.csv',
      'HD600.csv.txt',
      'evil.c\u200dom.csv',
      'ｅｖｉｌ．ｃｏｍ.csv',
    ]) {
      const linked = withRecipe({ [key]: { ...recipe[key], name } });
      expectIssue(linked, 'env:url', `/recipe/${key}/name`);
      expectIssue(JSON.stringify(linked), 'env:url', `/recipe/${key}/name`, parseEnvelope);
      assert.throws(() => normalizeEnvelope(linked), EnvelopeError);
      assert.throws(() => serializeEnvelope(linked), EnvelopeError);
    }
  }
});

test('recipe solver versions refuse arbitrary prerelease/build text with env:pattern', () => {
  for (const version of [
    '1.0.0-www.evil.com',
    '1.0.0+evil.com',
    '1.0.0-bit.ly',
    '1.0.0-alpha.beta',
    '1.0.0-beta+exp.sha.5114f85',
    '1.0.0-alpha.01',
    '1.0.0+gg',
  ]) {
    const input = withRecipe({ solver: { ...recipe.solver, version } });
    const errors = expectIssue(input, 'env:pattern', '/recipe/solver/version');
    assert.deepEqual(
      errors.map((error) => error.code),
      ['env:pattern'],
    );
    assert.equal(schemaValidate(input), false);
    expectIssue(JSON.stringify(input), 'env:pattern', '/recipe/solver/version', parseEnvelope);
    assert.throws(() => serializeEnvelope(input), EnvelopeError);
  }
  expectIssue(
    withRecipe({ solver: { ...recipe.solver, version: `1.0.0+${'a'.repeat(27)}` } }),
    'env:length',
    '/recipe/solver/version',
  );
});

test('APO pass filters fit the envelope without gainDb; even zero gain is an extra field', () => {
  const parsed = parseEqualizerApo(
    [
      'Preamp: -3 dB',
      'Filter 1: ON LPQ Fc 18000 Hz Gain 0 dB Q 0.71',
      'Filter 2: ON HPQ Fc 20 Hz Gain 0 dB Q 0.71',
    ].join('\n'),
  );
  const value = { ...copy(), bands: parsed.bands, preampDb: parsed.preampDb };
  value.code = encodeS1(value);
  assert.deepEqual(value.bands.slice(0, 2), [
    { kind: 'LP', freqHz: 18000, qFactor: 0.71 },
    { kind: 'HP', freqHz: 20, qFactor: 0.71 },
  ]);
  assert.equal(validateEnvelope(value).ok, true);
  assert.equal(schemaValidate(value), true);
  assert.deepEqual(parseEnvelope(serializeEnvelope(value)).value, value);
  for (const index of [0, 1]) {
    const extra = structuredClone(value);
    extra.bands[index].gainDb = 0;
    assert.equal(encodeS1(extra), value.code); // S1 is less strict than publication data.
    expectIssue(extra, 'env:extra', `/bands/${index}/gainDb`);
    assert.equal(schemaValidate(extra), false);
  }
});

test('text strips every listed invisible and applies NFKC before URL checking', () => {
  const invisibles = [
    0x00ad,
    0x034f,
    0x0600,
    0x061c,
    0x180e,
    0x200b,
    0x200c,
    0x200d,
    0x200e,
    0x200f,
    0x202a,
    0x202b,
    0x202c,
    0x202d,
    0x202e,
    0x2060,
    0x2066,
    0x2067,
    0x2068,
    0x2069,
    0xfe0f,
    0xfe0e,
    0xfeff,
    0xe0001,
    ...Array.from({ length: 4 }, (_, i) => 0x2061 + i),
    ...Array.from({ length: 6 }, (_, i) => 0x206a + i),
    ...Array.from({ length: 96 }, (_, i) => 0xe0020 + i),
  ];
  for (const point of invisibles) {
    const invisible = String.fromCodePoint(point);
    assert.equal(normalizeText(`Pa${invisible}drão`), 'Padrão');
    assert.equal(normalizeText(`a${invisible}\nb`, { multiline: true }), 'a\nb');
    expectIssue(withField('name', `example.c${invisible}om`), 'env:url', '/name');
    expectIssue(withField('description', `https${invisible}://x`), 'env:url', '/description');
  }
  assert.equal(normalizeText('  Ｐａｄｒａ̃ｏ　  mix  '), 'Padrão mix');
  assert.equal(normalizeText('e\u0301'), 'é');
  assert.equal(normalizeText('q\u0301'), 'q\u0301');
  assert.equal(
    normalizeText('  one　 two \n  three  four  ', { multiline: true }),
    'one two\nthree four',
  );
  assert.throws(() => normalizeText('ｅｘａｍｐｌｅ．ｃｏｍ'), EnvelopeError);
  assert.throws(() => normalizeText('exa\u200dmple.com'), EnvelopeError);
  assert.throws(() => normalizeText(1), EnvelopeError);
});

test('emoji selectors, ZWJ families, keycaps and RGI subdivision flags survive byte-exact', () => {
  for (const emoji of [
    '❤️',
    '❤\ufe0e',
    '👨‍👩‍👧',
    '👩🏽‍💻',
    '👩‍❤️‍👩',
    '🏴‍☠️',
    '1️⃣',
    '#️⃣',
    '*\ufe0e\u20e3',
    ...['gbeng', 'gbsct', 'gbwls'].map(tagFlag),
  ]) {
    assert.deepEqual(Buffer.from(normalizeText(emoji)), Buffer.from(emoji));
    const input = withField('name', emoji);
    const result = validateEnvelope(input);
    assert.equal(result.ok, true, emoji);
    assert.equal(result.value.name, emoji);
    assert.deepEqual(parseEnvelope(serializeEnvelope(input)), result);
    assert.equal(normalizeText(normalizeText(emoji)), emoji);
  }
  for (const stray of [
    'ex\u200dample',
    'ex\ufe0fample',
    'ex\ufe0eample',
    'ex\u{e0067}\u{e007f}ample',
  ]) {
    assert.equal(normalizeText(stray), 'example');
    expectIssue(withField('name', `${stray}.com`), 'env:url', '/name');
  }
  assert.equal(normalizeText('🏴\u{e0067}\u{e0062}'), '🏴'); // Unterminated tags.
  assert.equal(normalizeText('❤\u{e0067}\u{e007f}'), '❤'); // Not a tag-flag base.
  assert.equal(normalizeText('a\u200d👩'), 'a👩');
  assert.equal(normalizeText('👩\u200da'), '👩a');
  assert.equal(normalizeText('❤\ufe0f\ufe0f'), '❤️');
  // Valid emoji selectors must not create a detection-only boundary in a domain.
  expectIssue(withField('name', '1\ufe0f.com'), 'env:url', '/name');
});

test('non-RGI emoji tags cannot publish hidden ASCII or change visible URL detection', () => {
  for (const ascii of [
    'https://evil.example/claim',
    'a'.repeat(278),
    'gb',
    'gba',
    'gb12',
    'gb123',
    'gbengx',
    'useng',
    'GBENG',
    'gbenghttps://evil.example/claim',
  ]) {
    const hidden = tagFlag(ascii);
    assert.equal(normalizeText(hidden), '🏴', ascii);
    const input = withField('description', hidden);
    const result = validateEnvelope(input);
    assert.equal(result.ok, true, ascii);
    assert.equal(result.value.description, '🏴', ascii);
    assert.equal(JSON.parse(serializeEnvelope(input)).description, '🏴', ascii);
    assert.deepEqual(parseEnvelope(JSON.stringify(input)), result);
    expectIssue(withField('description', `${hidden} evil.com`), 'env:url', '/description');
    // All tag characters are stripped for detection, even inside a visible domain.
    expectIssue(withField('description', `evil.c${hidden.slice(2)}om`), 'env:url', '/description');
  }
  for (const flag of ['gbeng', 'gbsct', 'gbwls'].map(tagFlag)) {
    expectIssue(withField('name', `evil.c${flag.slice(2)}om`), 'env:url', '/name');
  }
  const long = tagFlag('g'.repeat(32766));
  assert.equal(long.length, 65536);
  assert.equal(normalizeText(long), '🏴');
});

test('limits count normalized code points, including combining marks and NFKC expansion', () => {
  for (const [key, max] of [
    ['name', 48],
    ['description', 280],
    ['author', 24],
  ]) {
    const exact = `  ${'ｅ\u0301'.repeat(max)}  `;
    assert.equal(validateEnvelope(withField(key, exact)).ok, true, key);
    assert.equal([...normalizeText(exact)].length, max);
    expectIssue(withField(key, `${exact}e\u0301`), 'env:length', `/${key}`);
    assert.equal(validateEnvelope(withField(key, '🎧'.repeat(max))).ok, true);
    expectIssue(withField(key, '🎧'.repeat(max + 1)), 'env:length', `/${key}`);
  }
  assert.equal(validateEnvelope(withField('name', 'q\u0301'.repeat(24))).ok, true);
  expectIssue(withField('name', `${'q\u0301'.repeat(24)}x`), 'env:length', '/name');
  expectIssue(withField('name', 'ﬃ'.repeat(17)), 'env:length', '/name');
  expectIssue(withField('description', 'ﬃ'.repeat(94)), 'env:length', '/description');
});

test('all C0/C1 controls are refused; description alone allows LF and at most five lines', () => {
  for (const point of [
    ...Array.from({ length: 32 }, (_, i) => i),
    ...Array.from({ length: 33 }, (_, i) => i + 127),
  ]) {
    const character = String.fromCodePoint(point);
    expectIssue(withField('name', `a${character}b`), 'env:pattern', '/name');
    if (point === 10) assert.equal(validateEnvelope(withField('description', 'a\nb')).ok, true);
    else expectIssue(withField('description', `a${character}b`), 'env:pattern', '/description');
  }
  expectIssue(withField('description', 'a\nb\nc\nd\ne\nf'), 'env:length', '/description');
  // Preserve internal blank lines; trim external empty whitespace.
  assert.equal(normalizeText('\na\n\nb\n', { multiline: true }), 'a\n\nb');
});

test('schemes, obfuscated dots and general domains are refused across all free-text fields', () => {
  const domains = [
    'com',
    'net',
    'org',
    'io',
    'br',
    'app',
    'dev',
    'xyz',
    'ly',
    'me',
    'co',
    'tv',
  ].map((tld) => `example.${tld}`);
  const dotted = ['。', '．', '｡', '․', '﹒'].flatMap((dot) => [
    `evil${dot}com`,
    `www${dot}evil${dot}com`,
  ]);
  for (const text of [
    'http://host',
    'HTTPS://host',
    'ftp://host',
    'git+ssh://host',
    'custom.scheme-2://x',
    'hxxp://host',
    'HXXPS://host',
    'www.host',
    'entre em discord.gg/abc',
    'evil.tv',
    'loja.shop',
    'x.co',
    '(abc-123.online)',
    '123.ab',
    `x.${'a'.repeat(24)}`,
    '_evil.com',
    'x_evil.com',
    'evil.com_',
    'evil.com-',
    'evil.c\u0332om',
    'example.xn--p1ai',
    '1.1.1.1',
    '1.1.1.1:80',
    'www.p.ex.',
    'p.ex.com',
    'p.ex.-com',
    '1.http://host',
    // Issue #13: whatever is glued before a scheme or hxxp cannot hide it.
    '1http://localhost',
    'xhttps://a.b',
    '_http://host',
    '9ftp://host',
    'abc1git+ssh://host',
    'çhttp://host',
    '例http://host',
    '1hxxp host',
    '_hxxps host',
    ...domains,
    ...dotted,
  ]) {
    for (const key of ['name', 'description', 'author']) {
      expectIssue(withField(key, text), 'env:url', `/${key}`);
    }
    for (const key of ['measurement', 'target', 'solver']) {
      const fields = key === 'solver' ? ['name'] : ['source', 'name'];
      for (const field of fields) {
        expectIssue(
          withRecipe({ [key]: { ...recipe[key], [field]: text } }),
          'env:url',
          `/recipe/${key}/${field}`,
        );
      }
    }
    expectIssue(withRecipe({ params: { note: text } }), 'env:url', '/recipe/params/note');
  }
});

test('ambiguous missing sentence spaces are refused with helpful env:url-like, never allowed', () => {
  for (const text of ['grave.Agudo', 'Sr.João', 'ação.música', '例子.中国', 'EXAMPLE.COM']) {
    for (const key of ['name', 'description', 'author']) {
      const errors = expectIssue(withField(key, text), 'env:url-like', `/${key}`);
      assert.ok(errors.some((error) => error.message.includes('space after the period')));
      assert.ok(errors.every((error) => error.code !== 'env:url'));
    }
    expectIssue(
      withRecipe({ solver: { ...recipe.solver, name: text } }),
      'env:url-like',
      '/recipe/solver/name',
    );
    expectIssue(withRecipe({ params: { note: text } }), 'env:url-like', '/recipe/params/note');
    for (const key of ['measurement', 'target']) {
      expectIssue(
        withRecipe({ [key]: { ...recipe[key], name: `${text}.csv` } }),
        'env:url-like',
        `/recipe/${key}/name`,
      );
    }
  }
  for (const text of [
    'https://grave.Agudo',
    'www.Sr.João',
    'hxxp Sr.João',
    'foo.Sr.João',
    'x.c.Sr.João',
    'Sr.João.com',
    'grave.Agudo other.Word',
    '_bad-name.Com',
    '123.Com',
  ]) {
    expectIssue(withField('description', text), 'env:url', '/description');
  }
  // A caller-provided issue path cannot exempt public prose normalization.
  assert.throws(() => normalizeText('example.com', { path: '/recipe/target/name' }), EnvelopeError);
});

test('decimals, abbreviations and punctuation without domain labels remain allowed', () => {
  for (const text of [
    '1.5 dB',
    'v2.0',
    'A warm mix, version 1.2; no advertising',
    'Sr. Silva',
    'Dra.',
    'etc.',
    '1,5',
    'Hz.',
    'dB.',
    'versão 2.1.3',
    'evil . com',
    'evil·com',
    'e.g. graves',
    'i.e. médios',
    ...['p.ex.', 'p. ex.', 'a.C.', 'd.C.', 'S.A.', 'Ltda.', 'e.g.', 'i.e.', 'a.m.', 'p.m.', 'vs.']
      .flatMap((abbreviation) => [
        abbreviation,
        abbreviation.toUpperCase(),
        abbreviation.toLowerCase(),
      ])
      .flatMap((abbreviation) => [abbreviation, `${abbreviation} graves`]),
    'x.c',
    `x.${'a'.repeat(25)}`,
    'a。 b｡ c． d․ e﹒',
  ]) {
    assert.equal(validateEnvelope(withField('description', text)).ok, true, text);
  }
  assert.equal(normalizeText('a。 b｡'), 'a。 b。'); // NFKC applies; URL-only mapping does not.
  assert.equal(
    normalizeText('p.ex. graves, S.A. e e.g. médios'),
    'p.ex. graves, S.A. e e.g. médios',
  );
});

test('64 KiB adversarial dotted tokens, marks and emoji tags normalize in under 200 ms', () => {
  // Warm the normalization paths before measuring; these used to make a scheme
  // regex retry its unbounded tail at every dotted word boundary.
  normalizeText('a.b a\u0332 🏴\u{e0067}');
  for (const input of [
    `${'a.'.repeat(32767)}a!`,
    `${'-'.repeat(65535)}!`,
    `${'a'.repeat(32768)}${'\u0332'.repeat(32768)}`,
    `🏴${'\u{e0067}'.repeat(32767)}`,
    tagFlag('g'.repeat(32766)),
  ]) {
    assert.equal(input.length, 65536);
    const start = performance.now();
    assert.equal(normalizeText(input).length > 0, true);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 200, `${elapsed.toFixed(1)} ms for 64 KiB adversarial input`);
  }
});

test('#13: 64 KiB adversarial glued scheme candidates normalize in under 200 ms', () => {
  // Without a leading boundary every letter after a digit, `_` or `:` may start
  // a candidate; each must still consume its run once, never retry it.
  normalizeText('1a:/ _a a+');
  for (const input of [
    `${'1a'.repeat(32767)}:!`,
    `${'a:/'.repeat(21845)}a`,
    '_a'.repeat(32768),
    `${'9'.repeat(65535)}!`,
    `${'a+'.repeat(32767)}:/`,
  ]) {
    assert.equal(input.length, 65536);
    const start = performance.now();
    assert.equal(normalizeText(input).length > 0, true);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 200, `${elapsed.toFixed(1)} ms for 64 KiB adversarial input`);
  }
});

test('#13: four-part dotted versions read as IPv4 and are refused (accepted false positive)', () => {
  // Pinned decision: shared text must not carry links (plan §0.12), so a
  // version such as "firmware 1.2.3.4" stays refused as env:url.
  for (const text of ['firmware 1.2.3.4', 'v. 10.0.0.1', 'firmware 1.2.3.4 beta']) {
    for (const key of ['name', 'description', 'author']) {
      expectIssue(withField(key, text), 'env:url', `/${key}`);
    }
    expectIssue(withRecipe({ params: { note: text } }), 'env:url', '/recipe/params/note');
  }
  // Fewer than four parts is not an address and stays allowed.
  for (const text of ['firmware 1.2.3', 'versão 2.1.3']) {
    assert.equal(validateEnvelope(withField('description', text)).ok, true, text);
  }
});

test('normalization is nonmutating and clones every supported object level', () => {
  const input = withRecipe(structuredClone(recipe));
  input.name = '  Ｐａｄｒａ̃ｏ  ';
  input.description = ' First  line \n Second  line ';
  input.author = '  Ａｕｔｏｒ ';
  input.recipe.measurement.source = ' local  source ';
  input.recipe.target.name = ' Flat  target ';
  input.recipe.solver.version = ' １．０．０-alpha.1 ';
  input.recipe.params.note = ' nice  curve ';
  const before = structuredClone(input);
  const output = normalizeEnvelope(input);
  assert.deepEqual(input, before);
  assert.equal(output.name, 'Padrão');
  assert.equal(output.description, 'First line\nSecond line');
  assert.equal(output.author, 'Autor');
  assert.equal(output.recipe.measurement.source, 'local source');
  assert.equal(output.recipe.target.name, 'Flat target');
  assert.equal(output.recipe.solver.version, '1.0.0-alpha.1');
  assert.equal(output.recipe.params.note, 'nice curve');
  for (const key of ['measurement', 'target', 'solver', 'params']) {
    assert.notEqual(output.recipe[key], input.recipe[key]);
  }
  assert.notEqual(output.bands, input.bands);
  output.bands[0].freqHz = 30;
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeEnvelope(output), output);
  for (const value of [null, [], 1]) assert.equal(normalizeEnvelope(value), value);
  const missing = normalizeEnvelope(without('description'));
  assert.equal(missing.description, '');
  assert.throws(() => normalizeEnvelope(withField('name', 'example.com')), EnvelopeError);
});

test('validation collects text, nested, required and extra errors with JSON Pointer paths', () => {
  const value = withRecipe({
    target: { source: 'example.com', name: '', extra: true },
    params: { 'a/b~': {} },
  });
  delete value.name;
  value.license = 'MIT';
  value.description = 'example.org\u0000';
  value['a/b~'] = 0;
  const errors = expectIssue(value, 'env:required', '/name');
  for (const [path, code] of [
    ['/license', 'env:enum'],
    ['/description', 'env:url'],
    ['/description', 'env:pattern'],
    ['/a~1b~0', 'env:extra'],
    ['/recipe/target/source', 'env:url'],
    ['/recipe/target/name', 'env:length'],
    ['/recipe/target/extra', 'env:extra'],
    ['/recipe/params/a~1b~0', 'env:pattern'],
    ['/recipe/params/a~1b~0', 'env:type'],
  ]) {
    assert.ok(
      errors.some((error) => error.path === path && error.code === code),
      `${path} ${code}`,
    );
  }
});

test('S1 retains stable errors; coherence checks exact numbers and wire order', () => {
  for (const [code, s1code] of [
    ['!', 's1:charset'],
    ['Q', 's1:length'],
    ['A'.repeat(68), 's1:version'],
    ['U'.repeat(68), 's1:variant'],
    [`${base.code.slice(0, -1)}A`, 's1:crc'],
  ]) {
    const errors = expectIssue(withField('code', code), 'env:s1', '/code');
    assert.ok(
      errors.some((error) => error.message.includes(s1code)),
      s1code,
    );
  }
  expectIssue(withBand({ ...base.bands[0], gainDb: -0.9 }), 'env:code-mismatch', '/code');
  expectIssue(withField('preampDb', -2.9), 'env:code-mismatch', '/code');
  expectIssue(reversed, 'env:code-mismatch', '/code');
  // encodeS1 tolerates tiny grid noise, but envelope coherence requires exact numbers.
  expectIssue(withBand({ ...base.bands[0], qFactor: 0.3 + 1e-12 }), 'env:code-mismatch', '/code');
  expectIssue(withField('preampDb', -2.8 + 1e-12), 'env:code-mismatch', '/code');
});

test('nonfinite numbers, undefined fields, sparse bands and nonprimitive params fail', () => {
  for (const value of [NaN, Infinity, -Infinity, null, undefined]) {
    expectIssue(withField('preampDb', value), 'env:type', '/preampDb');
    expectIssue(withBand({ ...base.bands[0], freqHz: value }), 'env:type', '/bands/0/freqHz');
  }
  for (const entry of [NaN, Infinity, undefined, () => 1, 1n]) {
    const result = validateEnvelope(withRecipe({ params: { invalid: entry } }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'env:type'));
  }
  expectIssue(withField('description', undefined), 'env:type', '/description');
  const sparse = copy();
  delete sparse.bands[0];
  expectIssue(sparse, 'env:bands', '/bands/0');
});

test('serialization fixes envelope/band/recipe order and recursively sorts params keys', () => {
  const input = withRecipe({
    params: { z: 1, a: 2 },
    solver: recipe.solver,
    target: recipe.target,
    measurement: recipe.measurement,
  });
  input.author = 'Autor';
  const shuffled = Object.fromEntries(Object.entries(input).reverse());
  shuffled.bands = input.bands.map((band) => Object.fromEntries(Object.entries(band).reverse()));
  const serialized = serializeEnvelope(shuffled);
  assert.equal(serialized, serializeEnvelope(input));
  const parsed = JSON.parse(serialized);
  assert.deepEqual(Object.keys(parsed), [
    'format',
    'name',
    'description',
    'author',
    'source',
    'license',
    'code',
    'preampDb',
    'bands',
    'recipe',
    'lang',
    'createdAt',
  ]);
  assert.deepEqual(Object.keys(parsed.bands[0]), ['kind', 'freqHz', 'gainDb', 'qFactor']);
  assert.deepEqual(Object.keys(parsed.recipe), ['measurement', 'target', 'solver', 'params']);
  assert.deepEqual(Object.keys(parsed.recipe.measurement), ['source', 'name', 'sha256']);
  assert.deepEqual(Object.keys(parsed.recipe.solver), ['name', 'version']);
  assert.deepEqual(Object.keys(parsed.recipe.params), ['a', 'z']);
  assert.ok(!serialized.includes('\n'));
  assert.equal(serialized, JSON.stringify(parsed));
  assert.throws(
    () => serializeEnvelope(withField('name', '')),
    (error) => {
      assert.ok(error instanceof EnvelopeError);
      assert.equal(error.name, 'EnvelopeError');
      assert.ok(error.errors.some((entry) => entry.code === 'env:length'));
      return true;
    },
  );
});

test('parse reports JSON errors, normalizes text and enforces the UTF-8 size limit', () => {
  for (const json of ['', '{', '{"name":}', 'undefined']) {
    expectIssue(json, 'env:json', '', parseEnvelope);
  }
  expectIssue(1, 'env:type', '', parseEnvelope);
  expectIssue('null', 'env:type', '', parseEnvelope);
  const result = parseEnvelope(JSON.stringify(withField('name', ' Ｐａｄｒａ̃ｏ ')));
  assert.equal(result.ok, true);
  assert.equal(result.value.name, 'Padrão');
  const large = withRecipe({
    params: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`p${i}`, '🎧'.repeat(128)])),
  });
  expectIssue(large, 'env:size', '');
  assert.throws(() => serializeEnvelope(large), EnvelopeError);
  expectIssue(JSON.stringify(large), 'env:size', '', parseEnvelope);
  const json = serializeEnvelope(base);
  const exact = `${json}${' '.repeat(8192 - Buffer.byteLength(json))}`;
  assert.equal(Buffer.byteLength(exact), 8192);
  assert.equal(parseEnvelope(exact).ok, true);
  assert.equal(parseEnvelope(`${exact} `).ok, true);
  // The limit is serialized normalized bytes, not raw insignificant whitespace.
  assert.equal(parseEnvelope(` ${exact} `).ok, true);
});

test('raw JSON is capped at 65536 UTF-16 units before parsing, independently of UTF-8 size', () => {
  const json = serializeEnvelope(base);
  const exact = `${json}${' '.repeat(65536 - json.length)}`;
  assert.equal(exact.length, 65536);
  assert.equal(parseEnvelope(exact).ok, true);
  expectIssue(`${exact} `, 'env:size', '', parseEnvelope);
  // Invalid JSON must hit the raw-size refusal, not the JSON parser.
  const errors = expectIssue('{'.repeat(65537), 'env:size', '', parseEnvelope);
  assert.deepEqual(
    errors.map((error) => error.code),
    ['env:size'],
  );
  expectIssue('{'.repeat(65536), 'env:json', '', parseEnvelope);
  const escaped = json.replace('Padrão', '\\u0050'.repeat(48));
  const padded = `${escaped}${' '.repeat(65536 - escaped.length)}`;
  assert.equal(parseEnvelope(padded).ok, true);
  const astral = JSON.stringify(withField('name', '🎧'));
  const astralExact = `${astral}${' '.repeat(65536 - astral.length)}`;
  assert.equal(astralExact.length, 65536);
  assert.equal(Buffer.byteLength(astralExact) > 65536, true);
  assert.equal(parseEnvelope(astralExact).ok, true);
  expectIssue(`${astralExact} `, 'env:size', '', parseEnvelope);
});

test('the serialized UTF-8 limit is inclusive at exactly 8192 bytes', () => {
  const value = withRecipe({
    params: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`p${i}`, 'a'.repeat(128)])),
  });
  let extraBytes = 8192 - Buffer.byteLength(serializeEnvelope(value));
  assert.ok(extraBytes > 0 && extraBytes < 32 * 128);
  for (const key of Object.keys(value.recipe.params)) {
    const count = Math.min(extraBytes, 128);
    value.recipe.params[key] = 'é'.repeat(count) + 'a'.repeat(128 - count);
    extraBytes -= count;
  }
  const exact = serializeEnvelope(value);
  assert.equal(Buffer.byteLength(exact), 8192);
  assert.equal(validateEnvelope(value).ok, true);
  assert.equal(parseEnvelope(exact).ok, true);
  const key = Object.keys(value.recipe.params).find((key) =>
    value.recipe.params[key].includes('a'),
  );
  value.recipe.params[key] = value.recipe.params[key].replace('a', 'é');
  expectIssue(value, 'env:size', '');
});

test('arbitrary JSON never throws or mutates; valid results serialize and revalidate', () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const before = structuredClone(value);
      const result = validateEnvelope(value);
      assert.deepEqual(value, before);
      if (result.ok) assert.deepEqual(parseEnvelope(serializeEnvelope(result.value)), result);
      else assert.ok(result.errors.length > 0);
    }),
    { numRuns: 1000 },
  );
});
