import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import fc from 'fast-check';
import * as reference from '../../design/analysis/gate.mjs';
import {
  autoPreamp,
  autoPreampForSection,
  gate,
  gateForWrite,
  GRID_INTERVALS,
  levelDb,
  MEAN_FREQUENCIES,
  poleRadius,
  PROVENANCE,
  sectionAnalysis,
  sectionPeaks,
  THRESHOLDS,
} from '../../src/safety/gate.mjs';
import { encodePayload, NEUTRAL_BANDS, preampWord } from '../../src/dsp/eq0xcb.mjs';
import * as level from '../../src/dsp/level.mjs';
import { boundarySearch } from '../../src/safety/policy.mjs';
import {
  computeThresholds,
  GENERATED_BY,
  OUTPUT_PATH,
  renderThresholdsModule,
  SOURCE_PATH,
  sourceSha256,
} from '../../tools/gen-thresholds.mjs';

const root = new URL('../../', import.meta.url);
const readText = async (/** @type {string} */ path) => readFile(new URL(path, root), 'utf8');
const fixture = JSON.parse(await readText('test/fixtures/eq0xcb.reference.json'));
const presets = Object.entries(fixture.presets);
const envelopeText = await readText(SOURCE_PATH);
const limites = JSON.parse(await readText('design/analysis/limites-v2.json'));

const OFF = Object.freeze({ kind: 'OFF' });
const first = (band) => [band, ...NEUTRAL_BANDS.slice(1)];
const codes = (result) => result.reasons.map((r) => r.code);
const byFrequency = (bands) => [...bands].sort((a, b) => a.freqHz - b.freqHz);
const counterexample = [
  { kind: 'PK', freqHz: 100, gainDb: -1, qFactor: 1 },
  { kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 },
  { kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 },
  ...Array.from({ length: 7 }, () => OFF),
];

// --- Reference mapping ---------------------------------------------------------

const PER_SECTION = /^[abc]:/;
/** Maps a reason object to the reference's string code. */
function referenceCode(r) {
  if (r.code === 'd:prefix-peak') return 'd:internal-audible';
  if (r.code === 'g:preamp') return 'g:preamp-range';
  if (r.code === 'f:codec') return `f:codec:${r.value}`;
  if (PER_SECTION.test(r.code)) return `${r.code}:stage-${r.stage}`;
  return r.code;
}
const isPolicyCode = (code) => code.startsWith('k:') || code.startsWith('d7:');

/** Metrics without `grid`, with section reasons mapped to the reference strings. */
function referenceMetrics(metrics) {
  const { grid, ...rest } = metrics;
  assert.ok(grid === 'full' || grid === 'drag');
  if (!rest.sections) return rest;
  return {
    ...rest,
    sections: rest.sections.map((s) => ({ ...s, reasons: s.reasons.map((r) => r.code) })),
  };
}

/** Asserts full-mode bit-identical parity with design/analysis/gate.mjs. */
function assertParity(bands, preampDb, label) {
  const mine = gate(bands, preampDb, { experimental: true });
  const theirs = reference.gate(bands, preampDb);
  assert.equal(mine.metrics.grid, 'full');
  assert.deepEqual(referenceMetrics(mine.metrics), theirs.metrics, label);
  const core = mine.reasons.filter((r) => !isPolicyCode(r.code));
  assert.deepEqual(core.map(referenceCode), theirs.reasons, label);
  assert.equal(core.length === 0, theirs.ok, label);
  assert.equal(mine.ok, theirs.ok && core.length === mine.reasons.length, label);
  return { mine, theirs };
}

/** Runs `fn` on both implementations; both throw the same message or both return. */
function sameOutcome(fn, refFn) {
  let mine;
  let theirs;
  try {
    mine = { value: fn() };
  } catch (error) {
    mine = { error: error.message };
  }
  try {
    theirs = { value: refFn() };
  } catch (error) {
    theirs = { error: error.message };
  }
  return { mine, theirs };
}

const ANALYTIC_CASES = [];
for (const kind of ['PK', 'LS', 'HS', 'LP', 'HP']) {
  for (const freqHz of [20, 1000, 20000]) {
    for (const qFactor of [0.1, 0.707, 20]) {
      for (const gainDb of ['LP', 'HP'].includes(kind) ? [0] : [-24, 0, 9, 15]) {
        ANALYTIC_CASES.push({ kind, freqHz, qFactor, gainDb });
      }
    }
  }
}

// --- Thresholds ----------------------------------------------------------------

test('thresholds.mjs is generated, deterministic and matches its source', async () => {
  const committed = (await readText(OUTPUT_PATH)).replace(/\r\n/g, '\n');
  const rendered = renderThresholdsModule(envelopeText);
  assert.equal(rendered, committed);
  assert.equal(renderThresholdsModule(envelopeText), rendered);
  assert.equal(renderThresholdsModule(envelopeText.replace(/\n/g, '\r\n')), rendered);
  assert.equal(PROVENANCE.sha256, sourceSha256(envelopeText));
  assert.match(PROVENANCE.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(PROVENANCE, {
    source: 'design/analysis/envelope.json',
    sha256: PROVENANCE.sha256,
    generatedBy: GENERATED_BY,
  });
  assert.doesNotMatch(committed, /[A-Za-z]:[\\/]|\/(Users|home)\//);
  assert.doesNotMatch(committed, /\d{4}-\d{2}-\d{2}T/);
  assert.ok(Object.isFrozen(THRESHOLDS) && Object.isFrozen(PROVENANCE));
  assert.ok(Object.isFrozen(THRESHOLDS.coefficientAbs));
});

test('threshold values equal limites-v2.json and the reference exactly', () => {
  assert.deepEqual({ ...THRESHOLDS }, limites.thresholds);
  assert.deepEqual(THRESHOLDS, reference.THRESHOLDS);
  assert.deepEqual(computeThresholds(JSON.parse(envelopeText)), limites.thresholds);
  const envelope = JSON.parse(envelopeText);
  assert.equal(Object.values(envelope.presets).flatMap((p) => p.sections).length, 110);
  assert.equal(THRESHOLDS.sectionPeakDb, 9.200000050722664);
  assert.equal(THRESHOLDS.preampMaxDb, -0.5);
  assert.equal(THRESHOLDS.preampMinDb, -25.5);
  assert.deepEqual([...THRESHOLDS.coefficientPositions], ['b0', 'b2', '-a1', 'b1', '-a2']);
});

// --- Official presets and orderings ----------------------------------------------

test('the 11 official presets pass (no experimental kind, no D7 violation)', () => {
  assert.equal(presets.length, 11);
  for (const [id, p] of presets) {
    for (const band of p.eqBands) assert.ok(['PK', 'LS'].includes(band.kind), id);
    const result = gateForWrite(p.eqBands, p.preampDb);
    assert.deepEqual(result.reasons, [], id);
    assert.ok(result.ok, id);
    const payload = p.payload;
    const crc = `0x${payload.at(-1).toString(16).padStart(2, '0')}${payload
      .at(-2)
      .toString(16)
      .padStart(2, '0')}`;
    assert.equal(result.metrics.payloadCrc, crc, id);
    assert.deepEqual(encodePayload(p.eqBands, p.preampDb), payload, id);
  }
});

test('the 11 reversed presets fail on d:prefix-peak', () => {
  for (const [id, p] of presets) {
    const result = gateForWrite([...p.eqBands].reverse(), p.preampDb);
    assert.ok(!result.ok, id);
    assert.ok(codes(result).includes('d:prefix-peak'), id);
  }
});

test('exactly 8 of the 11 presets sorted by frequency fail, all on d:prefix-peak', () => {
  const failures = presets.filter(([, p]) => !gateForWrite(byFrequency(p.eqBands), p.preampDb).ok);
  assert.equal(failures.length, 8);
  for (const [id, p] of failures) {
    const sorted = gateForWrite(byFrequency(p.eqBands), p.preampDb);
    assert.ok(codes(sorted).includes('d:prefix-peak'), id);
  }
});

test('counterexample "cuts first but 11.49 dB" fails', () => {
  const result = gateForWrite(counterexample, -0.5);
  assert.deepEqual(codes(result), ['d:prefix-peak', 'e:output-audible', 'e:output-full']);
  const expected = limites.examples.cutsFirstStillCanFail.metrics.internalAudible.db;
  assert.ok(Math.abs(result.metrics.internalAudible.db - expected) <= 1e-9);
  assert.ok(Math.abs(result.metrics.internalAudible.db - 11.489886937) < 1e-9);
  assert.equal(result.reasons[0].value, result.metrics.internalAudible.db);
  assert.equal(result.reasons[0].limit, THRESHOLDS.internalAudibleDb);
});

test('Neutro (10 × OFF, preamp −0.5 dB) passes with payload CRC 0x4FFF', () => {
  const result = gateForWrite(NEUTRAL_BANDS, -0.5);
  assert.ok(result.ok);
  assert.equal(result.metrics.payloadCrc, '0x4fff');
  assert.equal(result.metrics.outputFull.db, result.metrics.quantizedPreampDb);
  assert.ok(gateForWrite(NEUTRAL_BANDS, -25.5).ok);
});

// --- Specific boundaries --------------------------------------------------------

test('HP 30 Hz Q 0.5 passes (experimental); HP 20–25 Hz fails on a:b2', () => {
  const hp = (freqHz) => first({ kind: 'HP', freqHz, qFactor: 0.5 });
  assert.ok(gateForWrite(hp(30), -0.5, { experimental: true }).ok);
  assert.deepEqual(gateForWrite(hp(30), -0.5).reasons, [
    { code: 'k:kind-not-allowed', stage: 1, value: 'HP' },
  ]);
  assert.deepEqual(
    gateForWrite(hp(25), -0.5, { experimental: true }).reasons.map((r) => [r.code, r.stage]),
    [['a:b2', 1]],
  );
  const at20 = gateForWrite(hp(20), -0.5, { experimental: true });
  assert.deepEqual(codes(at20), ['a:b2', 'a:-a1', 'a:b1', 'a:-a2']);
  assert.equal(at20.reasons[0].limit, THRESHOLDS.coefficientAbsWords[1]);
  assert.ok(at20.reasons[0].value > at20.reasons[0].limit);
});

test('HS +4.52 dB at 20 kHz Q 0.1 sits on the a:b0 boundary (experimental)', () => {
  const hs = (gainDb) => ({ kind: 'HS', freqHz: 20000, gainDb, qFactor: 0.1 });
  assert.deepEqual(sectionAnalysis(hs(4.52)).reasons, []);
  assert.deepEqual(codes(sectionAnalysis(hs(4.522))), ['a:b0']);
  const accepted = (gainDb) => !codes(sectionAnalysis(hs(gainDb))).includes('a:b0');
  const edge = boundarySearch(4.52, 4.53, accepted, { iterations: 40 });
  assert.ok(accepted(edge));
  assert.ok(Math.abs(edge - 4.521471066746) < 1e-9, String(edge));
  const preamp = autoPreamp(first(hs(4.52)), { experimental: true });
  assert.equal(typeof preamp, 'number');
  assert.ok(gateForWrite(first(hs(4.52)), preamp, { experimental: true }).ok);
  assert.equal(autoPreamp(first(hs(4.52))), null);
});

test('PK +12 dB Q 4 with preamp −12.6 dB fails only on c:section-peak', () => {
  const result = gateForWrite(first({ kind: 'PK', freqHz: 1000, gainDb: 12, qFactor: 4 }), -12.6);
  assert.deepEqual(result.reasons, [
    {
      code: 'c:section-peak',
      stage: 1,
      value: result.metrics.sections[0].fullPeak.db,
      limit: THRESHOLDS.sectionPeakDb,
    },
  ]);
});

test('single-section auto-preamp sits exactly on the output boundary (reference test)', () => {
  const band = { kind: 'PK', freqHz: 1000, qFactor: 4, gainDb: 9 };
  const preamp = autoPreampForSection(sectionAnalysis(band));
  assert.equal(preamp, reference.autoPreampForSection(reference.analyseSection(band)));
  const atBoundary = gateForWrite(first(band), preamp);
  assert.ok(atBoundary.ok);
  const nextWordDb = 20 * Math.log10((preampWord(preamp) + 1) / 2 ** 23);
  assert.ok(codes(gateForWrite(first(band), nextWordDb)).includes('e:output-audible'));
  assert.equal(autoPreampForSection(sectionAnalysis(OFF)), -0.5);
  const peaks = (db) => ({ audiblePeak: { db, frequencyHz: 1 }, fullPeak: { db, frequencyHz: 1 } });
  assert.equal(autoPreampForSection(peaks(40)), null);
  assert.equal(autoPreampForSection(peaks(NaN)), null);
  assert.equal(autoPreampForSection(peaks(-24.9)), -0.5);
});

// --- Kinds, D7, codec, preamp, reason order ----------------------------------------

test('HS/LP/HP need experimental; unknown kinds and non-objects are always refused', () => {
  const bands = {
    HS: { kind: 'HS', freqHz: 10000, gainDb: -3, qFactor: 0.7 },
    LP: { kind: 'LP', freqHz: 18000, qFactor: 0.7 },
    HP: { kind: 'HP', freqHz: 40, qFactor: 0.5 },
  };
  for (const [kind, band] of Object.entries(bands)) {
    const plain = gateForWrite(first(band), -3);
    assert.deepEqual(plain.reasons, [{ code: 'k:kind-not-allowed', stage: 1, value: kind }], kind);
    assert.ok(gateForWrite(first(band), -3, { experimental: true }).ok, kind);
  }
  for (const kind of ['PK', 'LS']) {
    assert.ok(gateForWrite(first({ kind, freqHz: 1000, gainDb: -3, qFactor: 0.7 }), -3).ok, kind);
  }
  const unknown = gateForWrite(first({ kind: 'XX' }), -0.5, { experimental: true });
  assert.deepEqual(codes(unknown), ['k:kind-not-allowed', 'f:codec']);
  assert.match(unknown.reasons[1].value, /unknown filter kind/);
  const notObject = gateForWrite([null, ...NEUTRAL_BANDS.slice(1)], -0.5);
  assert.deepEqual(codes(notObject), ['k:kind-not-allowed', 'f:codec']);
  assert.deepEqual(notObject.metrics, { thresholds: THRESHOLDS, grid: 'full' });
  const notArray = gateForWrite('nope', -0.5);
  assert.deepEqual(codes(notArray), ['f:codec']);
  assert.deepEqual(codes(gateForWrite(NEUTRAL_BANDS.slice(1), -0.5)), ['f:codec']);
});

test('D7: no PK boost above 16 kHz, boost Q ≤ 4', () => {
  const at = (band, opts) => gateForWrite(first(band), -10, opts).reasons;
  assert.deepEqual(at({ kind: 'PK', freqHz: 16001, gainDb: 1, qFactor: 1 }), [
    { code: 'd7:pk-boost-above-16k', stage: 1, value: 16001, limit: 16000 },
  ]);
  assert.deepEqual(at({ kind: 'PK', freqHz: 16000, gainDb: 1, qFactor: 1 }), []);
  assert.deepEqual(at({ kind: 'PK', freqHz: 18000, gainDb: -6, qFactor: 1 }), []);
  assert.deepEqual(at({ kind: 'PK', freqHz: 18000, gainDb: 0, qFactor: 1 }), []);
  assert.deepEqual(at({ kind: 'LS', freqHz: 200, gainDb: 1, qFactor: 4.01 }), [
    { code: 'd7:boost-q', stage: 1, value: 4.01, limit: 4 },
  ]);
  assert.deepEqual(at({ kind: 'LS', freqHz: 2000, gainDb: 1, qFactor: 4 }), []);
  assert.deepEqual(at({ kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 8 }), []);
  assert.deepEqual(
    at({ kind: 'HS', freqHz: 12000, gainDb: 1, qFactor: 5 }, { experimental: true }).map(
      (r) => r.code,
    ),
    ['d7:boost-q'],
  );
  assert.deepEqual(
    at({ kind: 'PK', freqHz: 17000, gainDb: 1, qFactor: 5 }).map((r) => r.code),
    ['d7:pk-boost-above-16k', 'd7:boost-q'],
  );
  // LP/HP have no gain: D7 does not apply.
  const lp = at({ kind: 'LP', freqHz: 17000, gainDb: 3, qFactor: 0.7 }, { experimental: true });
  assert.deepEqual(lp, []);
});

test('reasons follow the documented order', () => {
  const bands = [
    { kind: 'PK', freqHz: 17000, gainDb: 1, qFactor: 5 },
    { kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 },
    { kind: 'PK', freqHz: 1000, gainDb: 12, qFactor: 4 },
    { kind: 'HP', freqHz: 20, qFactor: 0.5 },
    ...Array.from({ length: 6 }, () => OFF),
  ];
  const result = gateForWrite(bands, -0.2);
  assert.deepEqual(
    result.reasons.map((r) => (r.stage ? `${r.code}@${r.stage}` : r.code)),
    [
      'k:kind-not-allowed@2',
      'k:kind-not-allowed@4',
      'd7:pk-boost-above-16k@1',
      'd7:boost-q@1',
      'g:preamp',
      'c:section-peak@3',
      'a:b2@4',
      'a:-a1@4',
      'a:b1@4',
      'a:-a2@4',
      'd:prefix-peak',
      'e:output-audible',
      'e:output-full',
    ],
  );
  assert.equal(result.reasons[4].limit, -0.5);
  assert.equal(gateForWrite(NEUTRAL_BANDS, -26).reasons[0].limit, -25.5);
});

test('preamp range and codec errors', () => {
  assert.deepEqual(codes(gateForWrite(NEUTRAL_BANDS, 0)), [
    'g:preamp',
    'd:prefix-peak',
    'e:output-audible',
  ]);
  assert.ok(codes(gateForWrite(NEUTRAL_BANDS, -25.6)).includes('g:preamp'));
  assert.deepEqual(codes(gateForWrite(NEUTRAL_BANDS, 0.1)), ['f:codec']);
  assert.throws(() => gate(NEUTRAL_BANDS, -1, { grid: 'coarse' }), RangeError);
  assert.throws(() => gate(NEUTRAL_BANDS, -1, { grid: 'toString' }), RangeError);
});

test('NaN, ±Infinity, −0 and subnormal inputs never pass by accident', () => {
  const base = { kind: 'PK', freqHz: 1000, gainDb: 0, qFactor: 1 };
  const weird = [NaN, Infinity, -Infinity, -0, 5e-324, -5e-324, 0];
  for (const key of ['freqHz', 'qFactor']) {
    for (const value of weird) {
      const result = gateForWrite(first({ ...base, [key]: value }), -0.5);
      assert.ok(!result.ok, `${key}=${value}`);
    }
  }
  const reference0 = gateForWrite(first(base), -0.5);
  assert.ok(reference0.ok);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.ok(!gateForWrite(first({ ...base, gainDb: value }), -0.5).ok, `gainDb=${value}`);
    assert.ok(!gateForWrite(first({ ...base, gainDb: value, qFactor: 5 }), -0.5).ok);
  }
  // −0 and ±subnormal gains design exactly the 0 dB section: same verdict and metrics.
  for (const value of [-0, 5e-324, -5e-324]) {
    const result = gateForWrite(first({ ...base, gainDb: value }), -0.5);
    assert.deepEqual(result, reference0, `gainDb=${value}`);
  }
  for (const value of [NaN, Infinity, -Infinity, -0, 0, 5e-324, -5e-324, -1e-300]) {
    const result = gateForWrite(NEUTRAL_BANDS, value);
    assert.ok(!result.ok, `preamp=${value}`);
    assert.ok(
      codes(result).some((c) => c === 'g:preamp' || c === 'f:codec'),
      `preamp=${value}`,
    );
  }
  assert.equal(autoPreamp(first({ ...base, freqHz: NaN })), null);
  assert.equal(autoPreamp(first({ ...base, qFactor: Infinity })), null);
});

// --- Parity with design/analysis/gate.mjs -------------------------------------------

test('parity: 126 analytic single-section cases (analysis, auto preamp, full gate)', () => {
  assert.equal(ANALYTIC_CASES.length, 126);
  let encodable = 0;
  for (const band of ANALYTIC_CASES) {
    const label = JSON.stringify(band);
    const { mine, theirs } = sameOutcome(
      () => sectionAnalysis(band),
      () => reference.analyseSection(band),
    );
    assert.equal(mine.error, theirs.error, label);
    assertParity(first(band), -0.5, label);
    if (mine.error) continue;
    encodable++;
    const s = mine.value;
    assert.deepEqual({ ...s, reasons: s.reasons.map((r) => r.code) }, theirs.value, label);
    assert.equal(poleRadius(s.section), reference.poleRadius(s.section), label);
    assert.deepEqual(sectionPeaks(s.section), reference.sectionPeaks(s.section), label);
    const preamp = autoPreampForSection(s);
    assert.equal(preamp, reference.autoPreampForSection(theirs.value), label);
    if (preamp !== null) assertParity(first(band), preamp, `${label} @ ${preamp}`);
  }
  assert.ok(encodable > 100);
});

test('parity: 11 presets, reversed and sorted by frequency (full gate)', () => {
  for (const [id, p] of presets) {
    assertParity(p.eqBands, p.preampDb, id);
    assertParity([...p.eqBands].reverse(), p.preampDb, `${id} reversed`);
    assertParity(byFrequency(p.eqBands), p.preampDb, `${id} sorted`);
  }
  assertParity(counterexample, -0.5, 'counterexample');
  assertParity(NEUTRAL_BANDS, -0.5, 'neutro');
  assertParity(NEUTRAL_BANDS, 0, 'neutro @ 0');
  assertParity(NEUTRAL_BANDS, 0.1, 'neutro @ 0.1');
  assertParity(first({ kind: 'XX' }), -0.5, 'unknown kind');
});

test('parity: sectionPeaks and poleRadius on hand-made sections (degenerate branches)', () => {
  const sections = [
    { b0: 1, b1: 0, b2: 0.5, a1: 0, a2: 0 }, // FIR: linear stationary equation
    { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }, // identity
    { b0: 0.5, b1: 0.2, b2: 0.1, a1: -0.3, a2: 0.2 },
    { b0: 1.2, b1: -1.9, b2: 0.8, a1: -1.95, a2: 0.96 },
    { b0: 0.3, b1: 0.6, b2: 0.3, a1: -0.4, a2: -0.2 }, // real poles
  ];
  for (const s of sections) {
    assert.deepEqual(sectionPeaks(s), reference.sectionPeaks(s), JSON.stringify(s));
    assert.equal(poleRadius(s), reference.poleRadius(s), JSON.stringify(s));
  }
});

test('re-exports levelDb and MEAN_FREQUENCIES from src/dsp/level.mjs', () => {
  assert.equal(levelDb, level.levelDb);
  assert.equal(MEAN_FREQUENCIES, level.MEAN_FREQUENCIES);
});

// --- Drag versus full ------------------------------------------------------------

const PEAK_KEYS = ['internalAudible', 'outputAudible', 'outputFull'];

const bandArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant(OFF) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constantFrom('PK', 'LS', 'HS'),
      freqHz: fc.double({ min: Math.log(20), max: Math.log(20000), noNaN: true }).map(Math.exp),
      gainDb: fc.double({ min: -12, max: 9, noNaN: true }),
      qFactor: fc.double({ min: Math.log(0.3), max: Math.log(60), noNaN: true }).map(Math.exp),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constantFrom('LP', 'HP'),
      freqHz: fc.double({ min: Math.log(30), max: Math.log(20000), noNaN: true }).map(Math.exp),
      qFactor: fc.double({ min: 0.5, max: 2, noNaN: true }),
    }),
  },
);
const curveArb = fc.array(bandArb, { minLength: 10, maxLength: 10 });

// Sanity bound for the sampled corpus below (not a guarantee: see the next test).
const DRAG_CORPUS_BOUND_DB = 1e-4;

test('drag tracks full on a sampled corpus; gateForWrite always runs full', (t) => {
  const corpus = [
    ...presets.flatMap(([, p]) => [
      [p.eqBands, p.preampDb],
      [[...p.eqBands].reverse(), p.preampDb],
      [byFrequency(p.eqBands), p.preampDb],
    ]),
    [counterexample, -0.5],
    ...fc.sample(curveArb, { numRuns: 200, seed: 20261016 }).map((bands) => [bands, -12]),
  ];
  let worst = 0;
  let compared = 0;
  let verdictsDiffer = 0;
  for (const [bands, preampDb] of corpus) {
    const full = gate(bands, preampDb, { experimental: true });
    const drag = gate(bands, preampDb, { experimental: true, grid: 'drag' });
    assert.equal(drag.metrics.grid, 'drag');
    const write = gateForWrite(bands, preampDb, { experimental: true, grid: 'drag' });
    assert.equal(write.metrics.grid, 'full');
    assert.deepEqual(write, full);
    if (!full.metrics.sections) continue;
    compared++;
    for (const key of PEAK_KEYS) {
      const laxness = full.metrics[key].db - drag.metrics[key].db;
      worst = Math.max(worst, laxness);
      assert.ok(laxness <= DRAG_CORPUS_BOUND_DB, `${key}: ${laxness}`);
    }
    if (codes(drag).join() !== codes(full).join()) verdictsDiffer++;
  }
  assert.ok(compared > 150);
  assert.equal(verdictsDiffer, 0);
  t.diagnostic(`drag vs full: ${compared} curves, worst laxness ${worst} dB, same verdicts`);
});

test('full prevails: a curve that drag approves and full (gateForWrite) rejects', (t) => {
  // A resonant LP whose peak lies between the last drag grid point (≈19932.6 Hz)
  // and the 20 kHz edge: the coarse scan sees a monotone rise, does not refine,
  // and reports the edge value; the full grid brackets and refines the peak.
  // (LP Q 2 peaks at ≈0.95 × fc here: fc 20000 → 19024 Hz, fc 21000 → 20007 Hz.)
  const lpPeakHz = (freqHz) =>
    sectionAnalysis({ kind: 'LP', freqHz, qFactor: 2 }).fullPeak.frequencyHz;
  let fcHz = 20900;
  while (fcHz < 21000 && !(lpPeakHz(fcHz) >= 19975 && lpPeakHz(fcHz) <= 19995)) fcHz += 2;
  assert.ok(lpPeakHz(fcHz) >= 19975 && lpPeakHz(fcHz) <= 19995);
  const curve = [
    { kind: 'PK', freqHz: 1000, gainDb: -1, qFactor: 1 },
    { kind: 'LP', freqHz: fcHz, qFactor: 2 },
    ...Array.from({ length: 8 }, () => OFF),
  ];
  const opts = { experimental: true };
  const probeFull = gate(curve, -6, opts);
  const probeDrag = gate(curve, -6, { ...opts, grid: 'drag' });
  assert.equal(probeDrag.metrics.outputAudible.frequencyHz, 20000);
  assert.ok(probeFull.metrics.outputAudible.frequencyHz < 20000);
  const relDrag = probeDrag.metrics.outputAudible.db - probeDrag.metrics.quantizedPreampDb;
  // Largest Q23 preamp word for which drag still approves.
  const word = Math.floor(10 ** ((THRESHOLDS.outputAudibleDb - relDrag) / 20) * 2 ** 23) + 3;
  let preampDb = 0;
  let drag = probeDrag;
  for (let i = 0; i < 10; i++) {
    preampDb = 20 * Math.log10((word - i) / 2 ** 23);
    drag = gate(curve, preampDb, { ...opts, grid: 'drag' });
    if (drag.ok) break;
  }
  assert.ok(drag.ok, JSON.stringify(drag.reasons));
  const full = gateForWrite(curve, preampDb, opts);
  assert.deepEqual(codes(full), ['e:output-audible']);
  assert.ok(!gate(curve, preampDb, opts).ok);
  const laxness = full.metrics.outputAudible.db - drag.metrics.outputAudible.db;
  t.diagnostic(`LP ${fcHz} Hz Q 2, preamp ${preampDb} dB: drag laxer by ${laxness} dB`);
});

test('timing: drag vs full for a 10-band PK curve', (t) => {
  const [, p] = presets.find(([, preset]) => preset.eqBands.every((b) => b.kind === 'PK'));
  const time = (grid) => {
    gate(p.eqBands, p.preampDb, { grid });
    const runs = 5;
    const start = performance.now();
    for (let i = 0; i < runs; i++) gate(p.eqBands, p.preampDb, { grid });
    return (performance.now() - start) / runs;
  };
  const full = time('full');
  const drag = time('drag');
  t.diagnostic(`10-band PK: drag ${drag.toFixed(2)} ms, full ${full.toFixed(2)} ms per gate()`);
  assert.ok(drag < full);
  assert.equal(GRID_INTERVALS.drag, 2048);
  assert.equal(GRID_INTERVALS.full, 16384);
});

// --- autoPreamp ------------------------------------------------------------------

test('autoPreamp: highest 0.1 dB preamp accepted by gateForWrite', () => {
  const check = (bands, opts, label) => {
    const p = autoPreamp(bands, opts);
    assert.equal(typeof p, 'number', label);
    assert.equal(Math.round(p * 10) / 10, p, label);
    assert.ok(p >= -25.5 && p <= -0.5, label);
    assert.ok(gateForWrite(bands, p, opts).ok, label);
    if (p < -0.5) assert.ok(!gateForWrite(bands, Math.round(p * 10 + 1) / 10, opts).ok, label);
    return p;
  };
  for (const [id, p] of presets) {
    assert.ok(check(p.eqBands, {}, id) >= p.preampDb, id);
    check([...p.eqBands].reverse(), {}, `${id} reversed`);
  }
  assert.equal(check(NEUTRAL_BANDS, {}, 'neutro'), -0.5);
  check(counterexample, {}, 'counterexample');
  check(first({ kind: 'LP', freqHz: 1000, qFactor: 2.5 }), { experimental: true }, 'LP');
  assert.equal(autoPreamp(first({ kind: 'PK', freqHz: 1000, gainDb: 12, qFactor: 4 })), null);
  assert.equal(autoPreamp(first({ kind: 'PK', freqHz: 17000, gainDb: 1, qFactor: 1 })), null);
  assert.equal(autoPreamp('nope'), null);
  // Ten +9 dB boosts need more than 25.5 dB of attenuation.
  const boost = { kind: 'PK', freqHz: 1000, gainDb: 9, qFactor: 1 };
  const loud = Array.from({ length: 10 }, () => boost);
  assert.equal(autoPreamp(loud), null);
});

// --- Properties ------------------------------------------------------------------

/** gate.ok ⇒ the codec accepts the curve and every quantized |coef| is within limit a. */
function assertAcceptedIsEncodable(bands, preampDb, opts) {
  const result = gateForWrite(bands, preampDb, opts);
  if (!result.ok) return;
  const payload = encodePayload(bands, preampDb);
  const view = new DataView(Uint8Array.from(payload).buffer);
  for (let band = 0; band < 10; band++) {
    for (let i = 0; i < 5; i++) {
      const word = view.getInt32(18 + (band * 5 + i) * 4, true);
      assert.ok(Math.abs(word) <= THRESHOLDS.coefficientAbsWords[i]);
      assert.ok(Math.abs(word / 2 ** 27) <= THRESHOLDS.coefficientAbs[i]);
    }
  }
}

test('property: single section with auto preamp, gate.ok ⇒ encodable within limit a', () => {
  const singleArb = fc.record({
    kind: fc.constantFrom('PK', 'LS', 'HS', 'LP', 'HP'),
    freqHz: fc.double({ min: Math.log(20), max: Math.log(20000), noNaN: true }).map(Math.exp),
    gainDb: fc.double({ min: -24, max: 12, noNaN: true }),
    qFactor: fc.double({ min: Math.log(0.1), max: Math.log(20), noNaN: true }).map(Math.exp),
  });
  let accepted = 0;
  fc.assert(
    fc.property(singleArb, (band) => {
      const analysis = sectionAnalysis(band);
      const preamp = autoPreampForSection(analysis) ?? -25.5;
      const bands = first(band);
      if (gateForWrite(bands, preamp, { experimental: true }).ok) accepted++;
      assertAcceptedIsEncodable(bands, preamp, { experimental: true });
    }),
    { numRuns: 300, seed: 42 },
  );
  assert.ok(accepted > 50);
});

test('property: 10-band curves, gate.ok ⇒ encodable within limit a', () => {
  const softArb = fc.array(
    fc.oneof(
      fc.constant(OFF),
      fc.record({
        kind: fc.constantFrom('PK', 'LS'),
        freqHz: fc.double({ min: Math.log(30), max: Math.log(16000), noNaN: true }).map(Math.exp),
        gainDb: fc.double({ min: -6, max: 3, noNaN: true }),
        qFactor: fc.double({ min: 0.5, max: 2, noNaN: true }),
      }),
    ),
    { minLength: 10, maxLength: 10 },
  );
  fc.assert(
    fc.property(softArb, fc.integer({ min: -255, max: -5 }), (bands, tenths) => {
      assertAcceptedIsEncodable(bands, tenths / 10, {});
    }),
    { numRuns: 40, seed: 7 },
  );
});

test('gate is pure: same input, same output; arguments are not mutated', () => {
  const bands = structuredClone(fixture.presets.harman.eqBands);
  const snapshot = structuredClone(bands);
  assert.deepEqual(gate(bands, -3, { grid: 'drag' }), gate(bands, -3, { grid: 'drag' }));
  assert.deepEqual(bands, snapshot);
});
