import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  EqualizerApoError,
  parseEqualizerApo,
  serializeEqualizerApo,
} from '../../src/io/equalizer-apo.mjs';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);
const off = () => ({ kind: 'OFF' });
const pad = (bands) => [...bands, ...Array.from({ length: 10 - bands.length }, off)];

// Hand-written examples of the formats emitted by AutoEq and REW, not snapshots
// of this module's own serializer.
const AUTOEQ = `# Parametric EQ
Preamp: -6.2 dB
Filter 1: ON PK Fc 21 Hz Gain -2.1 dB Q 0.70
Filter 2: ON PK Fc 110 Hz Gain 3.4 dB Q 1.20
Filter 3: ON PK Fc 230 Hz Gain -1.5 dB Q 2.00
Filter 4: ON PK Fc 510 Hz Gain 2.2 dB Q 0.90
Filter 5: ON PK Fc 1400 Hz Gain -4.6 dB Q 1.80
Filter 6: ON PK Fc 2700 Hz Gain 1.3 dB Q 2.30
Filter 7: ON PK Fc 4200 Hz Gain -5.0 dB Q 3.00
Filter 8: ON PK Fc 6100 Hz Gain 2.4 dB Q 2.70
Filter 9: ON PK Fc 8300 Hz Gain -1.7 dB Q 1.10
Filter 10: ON PK Fc 12000 Hz Gain 0.8 dB Q 0.60
`;

const REW = `# Filter Settings file
# Equaliser: Generic
Preamp: -3.5 dB

Filter 1: ON LSC Fc 90.0 Hz Gain 3.0 dB Q 0.710
Filter 2: ON PK Fc 2450.0 Hz Gain -4.5 dB Q 2.100
Filter 3: ON HSC Fc 8500.0 Hz Gain -2.0 dB Q 0.650
Filter 4: OFF PK Fc 1000.0 Hz Gain 0.0 dB Q 1.000
`;

const LOCALIZED = [
  '\uFEFF# Exportação de filtros',
  'Preamp: -2,80 dB # headroom',
  '',
  'Filter 1: ON LS Fc 105,5 Hz Gain +3,25 dB',
  'Filter 2: ON HS Fc 7500 Hz Gain -1,50 dB Q 0,9',
  'Filter 3: OFF PK Fc 150,25 Hz Gain -5,5 dB Q 1,2 # disabled',
  ' # end',
].join('\r\n');

test('AutoEq-style Preamp and ten peaking filters', () => {
  const result = parseEqualizerApo(AUTOEQ);
  assert.deepEqual(result, {
    preampDb: -6.2,
    bands: [
      { kind: 'PK', freqHz: 21, gainDb: -2.1, qFactor: 0.7 },
      { kind: 'PK', freqHz: 110, gainDb: 3.4, qFactor: 1.2 },
      { kind: 'PK', freqHz: 230, gainDb: -1.5, qFactor: 2 },
      { kind: 'PK', freqHz: 510, gainDb: 2.2, qFactor: 0.9 },
      { kind: 'PK', freqHz: 1400, gainDb: -4.6, qFactor: 1.8 },
      { kind: 'PK', freqHz: 2700, gainDb: 1.3, qFactor: 2.3 },
      { kind: 'PK', freqHz: 4200, gainDb: -5, qFactor: 3 },
      { kind: 'PK', freqHz: 6100, gainDb: 2.4, qFactor: 2.7 },
      { kind: 'PK', freqHz: 8300, gainDb: -1.7, qFactor: 1.1 },
      { kind: 'PK', freqHz: 12000, gainDb: 0.8, qFactor: 0.6 },
    ],
    warnings: [],
  });
});

test('REW-style LSC/HSC map explicitly to codec shelves and OFF discards parameters', () => {
  assert.deepEqual(parseEqualizerApo(REW), {
    preampDb: -3.5,
    bands: pad([
      { kind: 'LS', freqHz: 90, gainDb: 3, qFactor: 0.71 },
      { kind: 'PK', freqHz: 2450, gainDb: -4.5, qFactor: 2.1 },
      { kind: 'HS', freqHz: 8500, gainDb: -2, qFactor: 0.65 },
      off(),
    ]),
    warnings: [],
  });
});

test('comma decimals, UTF-8 BOM, CRLF, inline comments, blank lines and LS default Q', () => {
  assert.deepEqual(parseEqualizerApo(LOCALIZED), {
    preampDb: -2.8,
    bands: pad([
      { kind: 'LS', freqHz: 105.5, gainDb: 3.25, qFactor: 0.7071 },
      { kind: 'HS', freqHz: 7500, gainDb: -1.5, qFactor: 0.9 },
      off(),
    ]),
    warnings: [],
  });
});

test('all pass aliases, optional zero pass gain, HS default Q, and explicit LS Q', () => {
  assert.deepEqual(
    parseEqualizerApo(`Filter 1: ON LP Fc 16000 Hz
Filter 2: ON LPQ Fc 12000 Hz Q 0.65
Filter 3: ON HP Fc 20 Hz Gain 0 dB
Filter 4: ON HPQ Fc 30 Hz Gain 0 dB Q 1.1
Filter 5: ON HS Fc 8000 Hz Gain -3 dB
Filter 6: ON LS Fc 100 Hz Gain 2 dB Q 0.8
Filter 7: OFF LPQ Fc 18000 Hz Q 0.7
Filter 8: OFF HP Fc 15 Hz
`).bands,
    pad([
      { kind: 'LP', freqHz: 16000, qFactor: 0.7071 },
      { kind: 'LP', freqHz: 12000, qFactor: 0.65 },
      { kind: 'HP', freqHz: 20, qFactor: 0.7071 },
      { kind: 'HP', freqHz: 30, qFactor: 1.1 },
      { kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7071 },
      { kind: 'LS', freqHz: 100, gainDb: 2, qFactor: 0.8 },
      off(),
      off(),
    ]),
  );
});

for (const type of ['LP', 'LPQ', 'HP', 'HPQ']) {
  test(`${type} omits gainDb for absent or zero gain, including disabled filters`, () => {
    const kind = type.startsWith('LP') ? 'LP' : 'HP';
    for (const gain of ['', ' Gain 0 dB', ' Gain -0 dB', ' Gain +0,0 dB']) {
      for (const status of ['ON', 'OFF']) {
        const { bands } = parseEqualizerApo(`Filter 1: ${status} ${type} Fc 18000 Hz${gain} Q 0.7`);
        assert.deepEqual(
          bands,
          pad([status === 'OFF' ? off() : { kind, freqHz: 18000, qFactor: 0.7 }]),
        );
        assert.equal(Object.hasOwn(bands[0], 'gainDb'), false);
      }
    }
  });
}

test('missing preamp defaults to zero; empty and comment-only files pad to ten OFFs', () => {
  for (const text of ['', '\uFEFF', '\n# no filters\r\n   # comment\n']) {
    assert.deepEqual(parseEqualizerApo(text), { preampDb: 0, bands: pad([]), warnings: [] });
  }
});

test('unknown directives are warnings with original line numbers and stripped comments', () => {
  const result = parseEqualizerApo(`\uFEFF# configuration
Device: Headphones

  Channel: all # channel selection is not part of this format
Preamp: -2 dB
GraphicEQ: 20 -1; 1000 0
Filter 1: ON PK Fc 1000 Hz Gain -2 dB Q 1
PreampExtra: -9 dB
FilterExtra: ON PK
`);
  assert.deepEqual(result.warnings, [
    { line: 2, text: 'Device: Headphones' },
    { line: 4, text: 'Channel: all' },
    { line: 6, text: 'GraphicEQ: 20 -1; 1000 0' },
    { line: 8, text: 'PreampExtra: -9 dB' },
    { line: 9, text: 'FilterExtra: ON PK' },
  ]);
  assert.equal(result.preampDb, -2);
  assert.deepEqual(result.bands, pad([{ kind: 'PK', freqHz: 1000, gainDb: -2, qFactor: 1 }]));
});

test('case-insensitive keywords, flexible spacing/field order, labels retain source order', () => {
  assert.deepEqual(
    parseEqualizerApo(`preamp: -1 db
 PREAMP: +2.50 DB
filter 9: on pk Q .50 Gain -3. DB Fc +1000,0 hz
Filter\t2: oN hs Fc 9000 Hz Gain -,5 dB
`),
    {
      preampDb: 2.5,
      bands: pad([
        { kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 0.5 },
        { kind: 'HS', freqHz: 9000, gainDb: -0.5, qFactor: 0.7071 },
      ]),
      warnings: [],
    },
  );
});

const ERROR_MESSAGES = {
  'apo:lsq-hsq': 'LSQ and HSQ are not supported: their Q semantics differ from the codec.',
  'apo:pass-gain': 'Pass filters cannot represent non-zero gain.',
  'apo:too-many-filters': 'At most 10 filters are supported; no filters were truncated.',
  'apo:malformed': 'Malformed EqualizerAPO directive.',
  'apo:unknown-type': 'Unsupported EqualizerAPO filter type.',
  'apo:number': 'Expected a finite decimal number.',
  'apo:missing-field': 'A required EqualizerAPO field is missing.',
};

function expectError(action, code, line) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error instanceof EqualizerApoError);
    assert.equal(error.name, 'EqualizerApoError');
    assert.equal(error.code, code);
    assert.equal(error.message, ERROR_MESSAGES[code]);
    assert.equal(error.line, line);
    return true;
  });
}

for (const type of ['LP', 'LPQ', 'HP', 'HPQ']) {
  test(`${type} refuses non-zero gain with the original line number, even when disabled`, () => {
    for (const gain of ['3', '-3', '0.1', '-0,1']) {
      for (const status of ['ON', 'OFF']) {
        const text = `# pass filter\r\nPreamp: -3 dB\r\nFilter 1: ${status} ${type} Fc 18000 Hz Gain ${gain} dB Q 0.7`;
        expectError(() => parseEqualizerApo(text), 'apo:pass-gain', 3);
      }
    }
  });
}

for (const type of ['LSQ', 'HSQ', 'lsq', 'hsq']) {
  test(`refuses ${type} Q semantics, even when disabled`, () => {
    for (const status of ['ON', 'OFF']) {
      const text = `# REW export
Preamp: -3 dB
Filter 1: ${status} ${type} Fc 100 Hz Gain 3 dB Q 0.7`;
      expectError(() => parseEqualizerApo(text), 'apo:lsq-hsq', 3);
    }
  });
}

test('eleven filters refuse without silent truncation, including disabled filters', () => {
  const text = `${AUTOEQ}Filter 11: OFF PK Fc 1000 Hz Gain 0 dB Q 1\n`;
  expectError(() => parseEqualizerApo(text), 'apo:too-many-filters', 13);
  expectError(
    () => serializeEqualizerApo({ preampDb: 0, bands: Array.from({ length: 11 }, off) }),
    'apo:too-many-filters',
    12,
  );
});

for (const text of [
  'Preamp -3 dB',
  'Preamp: -3 watts',
  'Preamp: -3 dB extra',
  'Filter: ON PK Fc 100 Hz Gain 1 dB Q 1',
  'Filter 0: ON PK Fc 100 Hz Gain 1 dB Q 1',
  'Filter x: ON PK Fc 100 Hz Gain 1 dB Q 1',
  'Filter 1 ON PK Fc 100 Hz Gain 1 dB Q 1',
  'Filter 1: MAYBE PK Fc 100 Hz Gain 1 dB Q 1',
  'Filter 1: ON PK Fc 100 kHz Gain 1 dB Q 1',
  'Filter 1: ON PK Fc 100 Hz Gain 1 watts Q 1',
  'Filter 1: ON PK Fc 100 Hz Gain 1 dB Q 1 extra',
  'Filter 1: ON PK Fc 100 Hz Gain 1 dB Q 1 Q 2',
  'Filter 1: ON PK Fc 100 Hz Fc 200 Hz Gain 1 dB Q 1',
  'Filter 1: OFF PK Fc 100 Hz Gain 1 dB Q 1 BW 2',
]) {
  test(`malformed known directive is not downgraded to warning: ${text}`, () => {
    expectError(() => parseEqualizerApo(`# header\r\n\r\n${text}`), 'apo:malformed', 3);
  });
}

for (const type of ['AP', 'BP', 'None', 'toString', 'OFF']) {
  test(`unknown filter type: ${type}`, () => {
    expectError(
      () => parseEqualizerApo(`Filter 1: ON ${type} Fc 1000 Hz Gain 0 dB Q 1`),
      'apo:unknown-type',
      1,
    );
  });
}

for (const token of ['NaN', 'Infinity', '-Infinity', '1e3', '0x10', '1,2.3', '--1', '1_000']) {
  test(`invalid decimal: ${token}`, () => {
    expectError(() => parseEqualizerApo(`Preamp: ${token} dB`), 'apo:number', 1);
    expectError(
      () => parseEqualizerApo(`Filter 1: ON PK Fc ${token} Hz Gain 0 dB Q 1`),
      'apo:number',
      1,
    );
  });
}

test('decimal overflow and invalid gain/Q are number errors, including OFF lines', () => {
  for (const text of [
    `Preamp: ${'9'.repeat(310)} dB`,
    'Filter 1: ON PK Fc 100 Hz Gain NaN dB Q 1',
    'Filter 1: OFF PK Fc 100 Hz Gain 0 dB Q Infinity',
  ]) {
    expectError(() => parseEqualizerApo(text), 'apo:number', 1);
  }
});

for (const text of [
  'Preamp:',
  'Preamp: -3',
  'Filter 1:',
  'Filter 1: ON',
  'Filter 1: ON PK',
  'Filter 1: ON PK Fc',
  'Filter 1: ON PK Fc 100',
  'Filter 1: ON PK Fc 100 Hz Gain',
  'Filter 1: ON PK Fc 100 Hz Gain 0',
  'Filter 1: ON PK Fc 100 Hz Gain 0 dB Q',
  'Filter 1: ON PK Fc 100 Hz Gain 0 dB',
  'Filter 1: ON PK Fc 100 Hz Q 1',
  'Filter 1: ON PK Gain 0 dB Q 1',
  'Filter 1: ON LS Fc 100 Hz',
  'Filter 1: ON LSC Fc 100 Hz Gain 0 dB',
  'Filter 1: ON HSC Fc 100 Hz Gain 0 dB',
  'Filter 1: ON LPQ Fc 100 Hz',
  'Filter 1: ON HPQ Fc 100 Hz',
  'Filter 1: OFF PK Fc 100 Hz Q 1',
]) {
  test(`missing required field: ${text}`, () => {
    expectError(() => parseEqualizerApo(`\n${text}`), 'apo:missing-field', 2);
  });
}

test('canonical export maps every kind, pads OFF, trims zeros and uses LF', () => {
  /** @type {import('../../src/io/equalizer-apo.mjs').EqualizerApoPreset} */
  const preset = {
    preampDb: -2.8,
    bands: [
      { kind: 'PK', freqHz: 1000.5, gainDb: -3.25, qFactor: 1 },
      { kind: 'LS', freqHz: 100, gainDb: 2.5, qFactor: 0.7071 },
      { kind: 'HS', freqHz: 8000, gainDb: -1, qFactor: 0.8 },
      { kind: 'LP', freqHz: 16000, qFactor: 0.7 },
      { kind: 'HP', freqHz: 30, qFactor: 1.1 },
      { kind: 'LP', freqHz: 15000, qFactor: 0.9 },
      { kind: 'HP', freqHz: 25, qFactor: 0.6 },
      off(),
    ],
  };
  const expected = `Preamp: -2.8 dB
Filter 1: ON PK Fc 1000.5 Hz Gain -3.25 dB Q 1
Filter 2: ON LSC Fc 100 Hz Gain 2.5 dB Q 0.7071
Filter 3: ON HSC Fc 8000 Hz Gain -1 dB Q 0.8
Filter 4: ON LPQ Fc 16000 Hz Q 0.7
Filter 5: ON HPQ Fc 30 Hz Q 1.1
Filter 6: ON LPQ Fc 15000 Hz Q 0.9
Filter 7: ON HPQ Fc 25 Hz Q 0.6
Filter 8: OFF PK Fc 1000 Hz Gain 0 dB Q 1
Filter 9: OFF PK Fc 1000 Hz Gain 0 dB Q 1
Filter 10: OFF PK Fc 1000 Hz Gain 0 dB Q 1
`;
  const before = structuredClone(preset);
  assert.equal(serializeEqualizerApo(preset), expected);
  assert.equal(serializeEqualizerApo(preset), expected);
  assert.deepEqual(preset, before);
  assert.deepEqual(parseEqualizerApo(expected), {
    preampDb: preset.preampDb,
    bands: pad(preset.bands),
    warnings: [],
  });
  assert.equal(serializeEqualizerApo(parseEqualizerApo(expected)), expected);
});

test('explicit zero pass gains normalize to an exact gain-free LP/HP round trip', () => {
  /** @type {import('../../src/io/equalizer-apo.mjs').EqualizerApoPreset} */
  const preset = {
    preampDb: -3,
    bands: [
      { kind: 'LP', freqHz: 18000, gainDb: 0, qFactor: 0.7 },
      { kind: 'HP', freqHz: 30, gainDb: 0, qFactor: 1.1 },
    ],
  };
  const parsed = parseEqualizerApo(serializeEqualizerApo(preset));
  assert.deepEqual(parsed, {
    preampDb: -3,
    bands: pad([
      { kind: 'LP', freqHz: 18000, qFactor: 0.7 },
      { kind: 'HP', freqHz: 30, qFactor: 1.1 },
    ]),
    warnings: [],
  });
  const canonical = serializeEqualizerApo(parsed);
  assert.match(canonical, /Filter 1: ON LPQ Fc 18000 Hz Q 0\.7\n/);
  assert.match(canonical, /Filter 2: ON HPQ Fc 30 Hz Q 1\.1\n/);
  assert.deepEqual(parseEqualizerApo(canonical), parsed);
  assert.equal(serializeEqualizerApo(parseEqualizerApo(canonical)), canonical);
});

test('all eleven official presets round-trip exactly', () => {
  assert.equal(Object.keys(fixture.presets).length, 11);
  for (const [id, { preampDb, eqBands }] of Object.entries(fixture.presets)) {
    const preset = { preampDb, bands: eqBands };
    const { warnings, ...parsed } = parseEqualizerApo(serializeEqualizerApo(preset));
    assert.deepEqual(parsed, preset, id);
    assert.deepEqual(warnings, [], id);
  }
});

test('shortest decimal formatting expands exponents without losing numeric precision', () => {
  for (const value of [
    0,
    -0,
    1e-6,
    1e-7,
    -1.2345678901234567e-8,
    1e21,
    -1.2345678901234568e25,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    0.30000000000000004,
  ]) {
    const preset = {
      preampDb: value,
      bands: pad([{ kind: 'PK', freqHz: value, gainDb: value, qFactor: value }]),
    };
    const text = serializeEqualizerApo(preset);
    assert.doesNotMatch(text, /\d[eE][+-]?\d/);
    assert.doesNotMatch(text, /,|\r/);
    assert.deepEqual(parseEqualizerApo(text), { ...preset, warnings: [] });
  }
  assert.match(serializeEqualizerApo({ preampDb: 1e-7, bands: [] }), /^Preamp: 0\.0000001 dB\n/);
  assert.match(
    serializeEqualizerApo({ preampDb: 1e21, bands: [] }),
    /^Preamp: 1000000000000000000000 dB\n/,
  );
});

test('serialization performs no acoustic or device safety validation', () => {
  const preset = {
    preampDb: 6,
    bands: pad([
      { kind: 'PK', freqHz: 0, gainDb: 100, qFactor: -1 },
      { kind: 'HP', freqHz: 96000, qFactor: 0 },
    ]),
  };
  assert.deepEqual(parseEqualizerApo(serializeEqualizerApo(preset)), { ...preset, warnings: [] });
});

test('serializer format errors carry typed codes, stable messages and output lines', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    expectError(() => serializeEqualizerApo({ preampDb: value, bands: [] }), 'apo:number', 1);
    for (const field of ['freqHz', 'gainDb', 'qFactor']) {
      expectError(
        () =>
          serializeEqualizerApo({
            preampDb: 0,
            bands: [off(), { kind: 'PK', freqHz: 100, gainDb: 0, qFactor: 1, [field]: value }],
          }),
        'apo:number',
        3,
      );
    }
  }
  for (const kind of ['AP', 'LSQ', 'toString']) {
    expectError(
      () =>
        serializeEqualizerApo({
          preampDb: 0,
          bands: [{ kind, freqHz: 100, gainDb: 0, qFactor: 1 }],
        }),
      'apo:unknown-type',
      2,
    );
  }
  expectError(() => serializeEqualizerApo({ bands: [] }), 'apo:missing-field', 1);
  for (const field of ['freqHz', 'gainDb', 'qFactor']) {
    const band = { kind: 'PK', freqHz: 100, gainDb: 0, qFactor: 1 };
    delete band[field];
    expectError(
      () => serializeEqualizerApo({ preampDb: 0, bands: [band] }),
      'apo:missing-field',
      2,
    );
  }
});
