import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  OFFICIAL_PRESETS,
  PRESETS_BY_ID,
  NEUTRO,
  PADRAO_AURI,
  PADRAO_AURI_CREDIT,
  getPreset,
  presetsByGroup,
} from '../../src/catalog/presets.mjs';
import { encodePayload, encodeReports } from '../../src/dsp/eq0xcb.mjs';
import { levelDb } from '../../src/dsp/level.mjs';
import { gateForWrite } from '../../src/safety/gate.mjs';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);

// Independent expectations, in official UI order (not derived from the catalog).
const expectedPresets = [
  ['padrao', 'Auri', 'preferencia', 'A assinatura do Auri, inspirada pela comunidade.', 0x1970],
  [
    'pref6',
    'Natural',
    'preferencia',
    'Subgrave presente, médios limpos e agudos arejados.',
    0x85b8,
  ],
  ['emv', 'Em V', 'preferencia', 'Alvo com graves e agudos levantados.', 0x14a9],
  ['basshead', 'Basshead', 'preferencia', 'Para os amantes de graves.', 0x932b],
  ['energico', 'Enérgico', 'preferencia', 'Sonoridade intensa, pensada para rock.', 0xbe4e],
  [
    'musical',
    'Musical',
    'preferencia',
    'Graves fortes, médios comedidos e agudos delicados.',
    0x7ea6,
  ],
  ['analitico', 'Analítico', 'preferencia', 'Para quem prioriza detalhamento e clareza.', 0x836c],
  ['referencia', 'JM-1', 'referencia', 'Sonoridade fiel à JM-1.', 0xec19],
  [
    'harman',
    'Harman IE 2019',
    'referencia',
    'A curva de preferência mais estudada do mundo.',
    0xc738,
  ],
  [
    'vdsf',
    'VDSF',
    'referencia',
    'Meio-termo entre campo difuso e Harman, com graves discretos.',
    0x5c6a,
  ],
  [
    'etymotic',
    'Etymotic',
    'referencia',
    'Graves contidos e muita definição nos médios e agudos.',
    0xb68e,
  ],
];

test('official labels, order, groups, descriptions and attribution are exact', () => {
  assert.equal(OFFICIAL_PRESETS.length, 11);
  assert.deepEqual(
    OFFICIAL_PRESETS.map(({ id }) => id),
    expectedPresets.map(([id]) => id),
  );
  expectedPresets.forEach(([id, label, group, description, crc], order) => {
    const preset = OFFICIAL_PRESETS[order];
    assert.deepEqual(preset, {
      id,
      label,
      group,
      order,
      description,
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: fixture.presets[id].preampDb,
      bands: fixture.presets[id].eqBands,
      crc,
    });
  });
});

for (const [id, , , , crc] of expectedPresets) {
  test(`catalog payload is byte-identical to the official fixture: ${id}`, () => {
    const preset = getPreset(id);
    const payload = encodePayload(preset.bands, preset.preampDb);
    assert.deepEqual(payload, fixture.presets[id].payload);
    assert.equal(payload[218] | (payload[219] << 8), preset.crc);
    assert.equal(preset.crc, crc);
  });

  test(`catalog reports are byte-identical to the official fixture: ${id}`, () => {
    const preset = getPreset(id);
    const reports = encodeReports(preset.bands, preset.preampDb).map((report) =>
      Array.from(report),
    );
    assert.deepEqual(reports, fixture.presets[id].reports);
  });
}

test('Neutro is ten OFF sections at -0.5 dB with CRC 0x4FFF', () => {
  assert.deepEqual(NEUTRO, {
    id: 'neutro',
    label: 'Neutro',
    preampDb: -0.5,
    bands: Array.from({ length: 10 }, () => ({ kind: 'OFF' })),
    crc: 0x4fff,
  });
  const payload = encodePayload(NEUTRO.bands, NEUTRO.preampDb);
  assert.equal(payload[218] | (payload[219] << 8), 0x4fff);
});

for (const preset of [...OFFICIAL_PRESETS, NEUTRO]) {
  test(`catalog curve passes gateForWrite: ${preset.id}`, () => {
    const verdict = gateForWrite(preset.bands, preset.preampDb);
    assert.equal(verdict.ok, true, JSON.stringify(verdict.reasons));
  });

  test(`catalog curve is deeply frozen: ${preset.id}`, () => {
    assert.ok(Object.isFrozen(preset));
    assert.ok(Object.isFrozen(preset.bands));
    assert.throws(() => {
      preset.preampDb = 0;
    }, TypeError);
    assert.throws(() => preset.bands.pop(), TypeError);
    assert.throws(() => {
      preset.bands[0] = { kind: 'OFF' };
    }, TypeError);
    for (const band of preset.bands) {
      assert.ok(Object.isFrozen(band));
      assert.throws(() => {
        band.kind = 'OFF';
      }, TypeError);
    }
  });
}

test('Padrão Auri aliases the official padrao object and credits Leonardo verbatim', () => {
  assert.equal(PADRAO_AURI, OFFICIAL_PRESETS[0]);
  assert.equal(PADRAO_AURI, getPreset('padrao'));
  assert.equal(PADRAO_AURI.id, 'padrao');
  assert.equal(
    PADRAO_AURI_CREDIT,
    'filtros do Leonardo (segundo comentário no código da página oficial)',
  );
});

test('the frozen ID map and lookup share the official and Neutro object references', () => {
  assert.deepEqual(Object.keys(PRESETS_BY_ID), [...expectedPresets.map(([id]) => id), 'neutro']);
  for (const preset of [...OFFICIAL_PRESETS, NEUTRO]) {
    assert.equal(PRESETS_BY_ID[preset.id], preset);
    assert.equal(getPreset(preset.id), preset);
  }
  assert.equal(getPreset('x'), null);
  assert.equal(getPreset(''), null);
  assert.equal(getPreset('__proto__'), null);
  assert.equal(getPreset('constructor'), null);
  assert.equal(getPreset('toString'), null);
  assert.ok(Object.isFrozen(PRESETS_BY_ID));
  assert.throws(() => {
    PRESETS_BY_ID.padrao = NEUTRO;
  }, TypeError);
  assert.throws(() => {
    PRESETS_BY_ID.x = NEUTRO;
  }, TypeError);
  assert.throws(() => {
    delete PRESETS_BY_ID.neutro;
  }, TypeError);
});

test('official and grouped arrays are frozen and preserve official object order', () => {
  assert.ok(Object.isFrozen(OFFICIAL_PRESETS));
  assert.throws(() => OFFICIAL_PRESETS.pop(), TypeError);
  assert.throws(() => {
    OFFICIAL_PRESETS[0] = NEUTRO;
  }, TypeError);
  for (const [group, expected] of [
    ['preferencia', OFFICIAL_PRESETS.slice(0, 7)],
    ['referencia', OFFICIAL_PRESETS.slice(7)],
    ['x', []],
    ['neutro', []],
  ]) {
    const actual = presetsByGroup(group);
    assert.deepEqual(actual, expected);
    actual.forEach((preset, index) => assert.equal(preset, expected[index]));
    assert.ok(Object.isFrozen(actual));
    assert.throws(() => actual.push(PADRAO_AURI), TypeError);
  }
});

test('Auri and Em V retain their reference effective levels', () => {
  for (const [id, expected] of [
    ['padrao', -3.5468069512111837],
    ['emv', -9.05022231105811],
  ]) {
    const preset = getPreset(id);
    const actual = levelDb(preset.bands, preset.preampDb);
    assert.ok(Math.abs(actual - expected) <= 1e-9, `${id}: ${actual} versus ${expected}`);
  }
});
