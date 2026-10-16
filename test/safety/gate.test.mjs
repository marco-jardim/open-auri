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

/**
 * Metrics without `grid`, `bands` and `payload` (not in the reference), with
 * section reasons mapped to the reference strings.
 */
function referenceMetrics(metrics) {
  const { grid, bands, payload, ...rest } = metrics;
  assert.ok(grid === 'full' || grid === 'drag');
  if (!rest.sections) return rest;
  assert.ok(Object.isFrozen(bands) && bands.length === 10);
  assert.equal(payload.length, 220);
  assert.ok(payload instanceof Uint8Array);
  return {
    ...rest,
    sections: rest.sections.map((s) => ({ ...s, reasons: s.reasons.map((r) => r.code) })),
  };
}

const SCAN_PEAKS = ['internalAudible', 'outputAudible', 'outputFull'];
/** Edge-refinement exceptions to exact parity (see GRID_INTERVALS in gate.mjs). */
const parityStats = { cases: 0, raisedCases: 0, raisedPeaks: 0, maxDeltaDb: 0 };

/**
 * Asserts full-mode parity with design/analysis/gate.mjs: bit-identical metrics
 * and reasons, except the documented edge refinement, which may only raise a
 * scan peak (src ≥ reference, never laxer); such peaks are counted in
 * `parityStats` and then compared on the remaining metrics.
 */
function assertParity(bands, preampDb, label) {
  const mine = gate(bands, preampDb, { experimental: true });
  const theirs = reference.gate(bands, preampDb);
  assert.equal(mine.metrics.grid, 'full');
  const metrics = referenceMetrics(mine.metrics);
  parityStats.cases++;
  let raised = 0;
  const adopt = (peak, theirsPeak) => {
    assert.ok(peak.db >= theirsPeak.db, `${label}: src ${peak.db} < reference ${theirsPeak.db}`);
    if (peak.db === theirsPeak.db) return peak;
    raised++;
    parityStats.maxDeltaDb = Math.max(parityStats.maxDeltaDb, peak.db - theirsPeak.db);
    return theirsPeak;
  };
  if (metrics.prefixAudible) {
    metrics.prefixAudible = metrics.prefixAudible.map((p, i) =>
      adopt(p, theirs.metrics.prefixAudible[i]),
    );
    for (const key of SCAN_PEAKS) metrics[key] = adopt(metrics[key], theirs.metrics[key]);
  }
  assert.deepEqual(metrics, theirs.metrics, label);
  const core = mine.reasons.filter((r) => !isPolicyCode(r.code));
  if (raised > 0) {
    parityStats.raisedCases++;
    parityStats.raisedPeaks += raised;
    // Stricter only: every reference reason is still reported.
    const mineCodes = core.map(referenceCode);
    for (const code of theirs.reasons) assert.ok(mineCodes.includes(code), `${label}: ${code}`);
    return { mine, theirs };
  }
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
  // A non-object element cannot be snapshotted: f:codec alone (the snapshot
  // happens before the kind checks, which only ever see the snapshot).
  const notObject = gateForWrite([null, ...NEUTRAL_BANDS.slice(1)], -0.5);
  assert.deepEqual(notObject.reasons, [{ code: 'f:codec', value: 'band 0: not an object' }]);
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
  // LP/HP have no gain: D7 does not apply. Contract change (B7): a non-zero LP/HP
  // gain is no longer silently ignored (S1 and the envelope refuse it): f:codec.
  const experimental = { experimental: true };
  const lp = at({ kind: 'LP', freqHz: 17000, qFactor: 0.7 }, experimental);
  assert.deepEqual(lp, []);
  const lpGain = at({ kind: 'LP', freqHz: 17000, gainDb: 3, qFactor: 0.7 }, experimental);
  assert.deepEqual(
    lpGain.map((r) => r.code),
    ['f:codec'],
  );
});

test('B7: LP/HP gain must be absent or exactly 0; zero is dropped from the snapshot', () => {
  const opts = { experimental: true };
  for (const kind of ['LP', 'HP']) {
    const freqHz = kind === 'LP' ? 17000 : 40;
    const absent = gateForWrite(first({ kind, freqHz, qFactor: 0.7 }), -1, opts);
    assert.ok(absent.ok, kind);
    for (const zero of [0, -0]) {
      const result = gateForWrite(first({ kind, freqHz, gainDb: zero, qFactor: 0.7 }), -1, opts);
      assert.deepEqual(result, absent, `${kind} gainDb=${Object.is(zero, -0) ? '-0' : '0'}`);
      assert.ok(!Object.hasOwn(result.metrics.bands[0], 'gainDb'));
    }
    for (const bad of [6, -3, 1e-9, NaN, Infinity, '0', null, true, 0n, {}, Symbol('g')]) {
      const result = gateForWrite(first({ kind, freqHz, gainDb: bad, qFactor: 0.7 }), -1, opts);
      assert.deepEqual(codes(result), ['f:codec'], `${kind} gainDb=${typeof bad}`);
      assert.equal(result.metrics.bands, undefined);
      assert.equal(result.metrics.payload, undefined);
    }
  }
});

test('N2: the gate never coerces caller values, not even to format codec errors', () => {
  let calls = 0;
  const trap = () => ({
    [Symbol.toPrimitive]() {
      calls++;
      throw new Error('ran');
    },
    toString() {
      calls++;
      return 'ran';
    },
    valueOf() {
      calls++;
      return 0;
    },
    toJSON() {
      calls++;
      return 'ran';
    },
  });
  const base = { kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 };
  for (const field of ['kind', 'freqHz', 'gainDb', 'qFactor']) {
    const result = gateForWrite(first({ ...base, [field]: trap() }), -1);
    assert.equal(codes(result).at(-1), 'f:codec', field);
    assert.ok(!JSON.stringify(result.reasons).includes('ran'), field);
  }
  const lpBand = { kind: 'LP', freqHz: 1000, gainDb: trap(), qFactor: 1 };
  const lp = gateForWrite(first(lpBand), -1, { experimental: true });
  assert.deepEqual(codes(lp), ['f:codec']);
  assert.deepEqual(codes(gateForWrite(NEUTRAL_BANDS, trap())), ['f:codec']);
  // Reasons carry only JSON-safe primitives, never the caller's objects.
  for (const [kind, value] of [
    [undefined, undefined],
    [null, null],
    [true, true],
    [7n, '7n'],
    [() => 'PK', '(function)'],
    [trap(), '(object)'],
  ]) {
    const result = gateForWrite(first({ kind, freqHz: 1000, gainDb: -3, qFactor: 1 }), -1);
    assert.deepEqual(result.reasons[0], { code: 'k:kind-not-allowed', stage: 1, value });
    assert.equal(typeof JSON.stringify(result.reasons), 'string');
  }
  const symbolKind = gateForWrite(first({ kind: Symbol('k'), freqHz: 1000, qFactor: 1 }), -1);
  assert.equal(symbolKind.reasons[0].value, '(symbol)');
  const boostBand = { kind: 'PK', freqHz: trap(), gainDb: 3, qFactor: trap() };
  const boost = gateForWrite(first(boostBand), -6);
  assert.deepEqual(boost.reasons.slice(0, 2), [
    { code: 'd7:pk-boost-above-16k', stage: 1, value: '(object)', limit: 16000 },
    { code: 'd7:boost-q', stage: 1, value: '(object)', limit: 4 },
  ]);
  assert.equal(codes(boost).at(-1), 'f:codec');
  assert.equal(calls, 0);
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
  // −0 and ±subnormal gains design exactly the 0 dB section: same verdict and
  // metrics (and bytes); only the snapshot in metrics.bands keeps the gain as given.
  for (const value of [-0, 5e-324, -5e-324]) {
    const result = gateForWrite(first({ ...base, gainDb: value }), -0.5);
    assert.ok(Object.is(result.metrics.bands[0].gainDb, value));
    const withoutBands = (r) => ({ ...r, metrics: { ...r.metrics, bands: undefined } });
    assert.deepEqual(withoutBands(result), withoutBands(reference0), `gainDb=${value}`);
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

test('parity: 11 presets, reversed and sorted by frequency (full gate)', (t) => {
  for (const [id, p] of presets) {
    const { mine } = assertParity(p.eqBands, p.preampDb, id);
    assert.ok(mine.ok, id); // edge refinement does not make any official preset fail
    assertParity([...p.eqBands].reverse(), p.preampDb, `${id} reversed`);
    assertParity(byFrequency(p.eqBands), p.preampDb, `${id} sorted`);
  }
  assertParity(counterexample, -0.5, 'counterexample');
  assert.ok(assertParity(NEUTRAL_BANDS, -0.5, 'neutro').mine.ok);
  assertParity(NEUTRAL_BANDS, 0, 'neutro @ 0');
  assertParity(NEUTRAL_BANDS, 0.1, 'neutro @ 0.1');
  assertParity(first({ kind: 'XX' }), -0.5, 'unknown kind');
  // Sanity bound on how much stricter the edge refinement may be on this corpus.
  assert.ok(parityStats.maxDeltaDb <= 1e-6, String(parityStats.maxDeltaDb));
  t.diagnostic(
    `parity corpus so far: ${parityStats.cases} cases, ${parityStats.raisedCases} with an ` +
      `edge-refined peak (${parityStats.raisedPeaks} peaks), max src − reference ` +
      `${parityStats.maxDeltaDb} dB`,
  );
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
  let maxAbs = 0;
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
      maxAbs = Math.max(maxAbs, Math.abs(laxness));
      assert.ok(laxness <= DRAG_CORPUS_BOUND_DB, `${key}: ${laxness}`);
    }
    if (codes(drag).join() !== codes(full).join()) verdictsDiffer++;
  }
  assert.ok(compared > 150);
  assert.equal(verdictsDiffer, 0);
  t.diagnostic(
    `drag vs full: ${compared} curves, worst laxness ${worst} dB, ` +
      `max |full − drag| ${maxAbs} dB, same verdicts`,
  );
});

// LP Q 2 peaks at ≈0.95 × fc here (fc 20000 → 19024 Hz, fc 21000 → 20007 Hz).
const lpPeakHz = (freqHz) =>
  sectionAnalysis({ kind: 'LP', freqHz, qFactor: 2 }).fullPeak.frequencyHz;
/** Smallest fc (0.25 Hz steps from 20900) whose LP Q 2 peak lies in [lo, hi]. */
function lpWithPeakIn(lo, hi) {
  let fcHz = 20900;
  while (fcHz < 21200 && !(lpPeakHz(fcHz) >= lo && lpPeakHz(fcHz) <= hi)) fcHz += 0.25;
  assert.ok(lpPeakHz(fcHz) >= lo && lpPeakHz(fcHz) <= hi, String(fcHz));
  return fcHz;
}

test('edge refinement: drag no longer misses a peak next to the 20 kHz edge', (t) => {
  // Contract change: drag used to report the 20 kHz edge value for a resonant
  // LP peaking between its last grid point (≈19932.6 Hz) and 20 kHz, approving
  // a curve full rejected. Both modes now refine the edge intervals.
  const fcHz = lpWithPeakIn(19975, 19995);
  const curve = [
    { kind: 'PK', freqHz: 1000, gainDb: -1, qFactor: 1 },
    { kind: 'LP', freqHz: fcHz, qFactor: 2 },
    ...Array.from({ length: 8 }, () => OFF),
  ];
  const opts = { experimental: true };
  const full = gateForWrite(curve, -6, opts);
  const drag = gate(curve, -6, { ...opts, grid: 'drag' });
  assert.ok(drag.metrics.outputAudible.frequencyHz < 20000);
  assert.ok(full.metrics.outputAudible.frequencyHz < 20000);
  const gap = Math.abs(full.metrics.outputAudible.db - drag.metrics.outputAudible.db);
  assert.ok(gap <= 1e-9, String(gap));
  // At the largest Q23 preamp full approves, drag agrees; one word above, both refuse.
  const rel = full.metrics.outputAudible.db - full.metrics.quantizedPreampDb;
  let word = Math.floor(10 ** ((THRESHOLDS.outputAudibleDb - rel) / 20) * 2 ** 23) + 3;
  while (!gateForWrite(curve, 20 * Math.log10(word / 2 ** 23), opts).ok) word--;
  const atEdge = 20 * Math.log10(word / 2 ** 23);
  const above = 20 * Math.log10((word + 1) / 2 ** 23);
  assert.ok(gate(curve, atEdge, { ...opts, grid: 'drag' }).ok);
  assert.deepEqual(codes(gateForWrite(curve, above, opts)), ['e:output-audible']);
  assert.deepEqual(codes(gate(curve, above, { ...opts, grid: 'drag' })), ['e:output-audible']);
  t.diagnostic(`LP ${fcHz} Hz Q 2: drag and full peaks ${gap} dB apart`);
});

test('edge refinement: a peak in the last full-grid interval is found (stricter)', (t) => {
  // Two identical LPs: the cascade peaks exactly where one LP does.
  const lastGridHz = 20 * 1000 ** (16383 / 16384); // ≈19991.57 Hz
  const fcHz = lpWithPeakIn(19997.5, 19999.5);
  const lp = { kind: 'LP', freqHz: fcHz, qFactor: 2 };
  const curve = [lp, lp, ...Array.from({ length: 8 }, () => OFF)];
  const mine = gateForWrite(curve, -6, { experimental: true });
  const theirs = reference.gate(curve, -6);
  // The reference sees a monotone rise on its grid and reports the edge value.
  assert.equal(theirs.metrics.outputAudible.frequencyHz, 20000);
  const peakHz = mine.metrics.outputAudible.frequencyHz;
  assert.ok(peakHz > lastGridHz && peakHz < 20000, String(peakHz));
  const delta = mine.metrics.outputAudible.db - theirs.metrics.outputAudible.db;
  assert.ok(delta > 0 && delta < 1e-3, String(delta));
  assert.ok(mine.metrics.internalAudible.db >= theirs.metrics.internalAudible.db);
  assert.ok(mine.metrics.outputFull.db >= theirs.metrics.outputFull.db);
  t.diagnostic(`LP ${fcHz} Hz ×2: src peak ${peakHz} Hz, ${delta} dB above the reference`);
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

/**
 * gate.ok ⇒ the codec accepts the curve, the gate's payload is those bytes and
 * every quantized |coef| is within limit a. Returns whether the gate accepted.
 */
function assertAcceptedIsEncodable(bands, preampDb, opts) {
  const result = gateForWrite(bands, preampDb, opts);
  if (!result.ok) return false;
  const payload = encodePayload(bands, preampDb);
  assert.deepEqual([...result.metrics.payload], payload);
  const view = new DataView(Uint8Array.from(payload).buffer);
  for (let band = 0; band < 10; band++) {
    for (let i = 0; i < 5; i++) {
      const word = view.getInt32(18 + (band * 5 + i) * 4, true);
      assert.ok(Math.abs(word) <= THRESHOLDS.coefficientAbsWords[i]);
      assert.ok(Math.abs(word / 2 ** 27) <= THRESHOLDS.coefficientAbs[i]);
    }
  }
  return true;
}

// Minimum accepted curves for the 10-band property (seed 7, 40 runs); set
// from the observed count so the property can never pass vacuously.
const ACCEPTED_MINIMUM_10_BAND = 10;

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

test('property: 10-band curves, gate.ok ⇒ encodable within limit a', (t) => {
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
  // Count the accepted curves: the implication is only exercised on those.
  let accepted = 0;
  fc.assert(
    fc.property(softArb, fc.integer({ min: -255, max: -5 }), (bands, tenths) => {
      if (assertAcceptedIsEncodable(bands, tenths / 10, {})) accepted++;
    }),
    { numRuns: 40, seed: 7 },
  );
  assert.ok(accepted >= ACCEPTED_MINIMUM_10_BAND, `only ${accepted} of 40 curves accepted`);
  t.diagnostic(`10-band property: ${accepted} of 40 curves accepted`);
});

// --- C1: one read per band field ----------------------------------------------------

const offTail = () => Array.from({ length: 9 }, () => ({ kind: 'OFF' }));

test('C1: a getter gain is read once; D7 cannot be bypassed', () => {
  // Reviewer repro: cut on the first read, +3 dB at 18 kHz afterwards.
  let reads = 0;
  const cutFirst = {
    kind: 'PK',
    freqHz: 18000,
    qFactor: 1,
    get gainDb() {
      return reads++ === 0 ? -1 : 3;
    },
  };
  const verdict = gateForWrite([cutFirst, ...offTail()], -4);
  assert.equal(reads, 1);
  assert.ok(verdict.ok, JSON.stringify(verdict.reasons));
  const seen = { kind: 'PK', freqHz: 18000, gainDb: -1, qFactor: 1 };
  assert.deepEqual(verdict.metrics.bands[0], seen);
  assert.ok(Object.isFrozen(verdict.metrics.bands[0]));
  // What was approved is the −1 dB cut, byte for byte; never the +3 dB boost.
  assert.deepEqual([...verdict.metrics.payload], encodePayload([seen, ...offTail()], -4));
  assert.notDeepEqual(
    [...verdict.metrics.payload],
    encodePayload([{ ...seen, gainDb: 3 }, ...offTail()], -4),
  );
  // Boost on the first read: D7 refuses.
  let boostReads = 0;
  const boostFirst = { ...cutFirst };
  Object.defineProperty(boostFirst, 'gainDb', {
    get: () => (boostReads++ === 0 ? 3 : -1),
  });
  const refused = gateForWrite([boostFirst, ...offTail()], -4);
  assert.equal(boostReads, 1);
  assert.deepEqual(codes(refused), ['d7:pk-boost-above-16k']);
});

test('C1: a getter kind is read once; HS cannot pass without experimental', () => {
  let reads = 0;
  const pkFirst = {
    get kind() {
      return reads++ === 0 ? 'PK' : 'HS';
    },
    freqHz: 8000,
    gainDb: -6,
    qFactor: 0.7,
  };
  const verdict = gateForWrite([pkFirst, ...offTail()], -1);
  assert.equal(reads, 1);
  assert.ok(verdict.ok);
  const asPk = { kind: 'PK', freqHz: 8000, gainDb: -6, qFactor: 0.7 };
  assert.deepEqual(verdict.metrics.bands[0], asPk);
  assert.deepEqual([...verdict.metrics.payload], encodePayload([asPk, ...offTail()], -1));
  let hsReads = 0;
  const hsFirst = { ...asPk };
  Object.defineProperty(hsFirst, 'kind', { get: () => (hsReads++ === 0 ? 'HS' : 'PK') });
  const refused = gateForWrite([hsFirst, ...offTail()], -1);
  assert.equal(hsReads, 1);
  assert.deepEqual(refused.reasons, [{ code: 'k:kind-not-allowed', stage: 1, value: 'HS' }]);
  assert.equal(refused.metrics.bands[0].kind, 'HS');
});

test('C1: a Proxy band with per-read random values is read once per field', () => {
  let seed = 20261016;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let run = 0; run < 20; run++) {
    const log = [];
    const band = new Proxy(
      {},
      {
        get(_, key) {
          const value = {
            kind: 'PK',
            freqHz: 200 + 5000 * random(),
            gainDb: -6 * random(),
            qFactor: 0.5 + random(),
          }[key];
          log.push([key, value]);
          return value;
        },
      },
    );
    const verdict = gateForWrite([band, ...offTail()], -3);
    assert.deepEqual(
      log.map(([key]) => key),
      ['kind', 'freqHz', 'gainDb', 'qFactor'],
    );
    const plain = Object.fromEntries(log);
    assert.ok(verdict.ok);
    assert.deepEqual(verdict.metrics.bands[0], plain);
    assert.deepEqual([...verdict.metrics.payload], encodePayload([plain, ...offTail()], -3));
    assert.deepEqual(verdict, gateForWrite([plain, ...offTail()], -3));
  }
});

test('C1: autoPreamp reads the bands once', () => {
  let reads = 0;
  const band = {
    kind: 'PK',
    freqHz: 1000,
    qFactor: 1,
    get gainDb() {
      reads += 1;
      return reads === 1 ? 6 : -6;
    },
  };
  const preamp = autoPreamp([band, ...offTail()]);
  assert.equal(reads, 1);
  const plain = { kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 };
  assert.equal(preamp, autoPreamp([plain, ...offTail()]));
  assert.ok(preamp < -0.5);
});

// --- M2: sparse and malformed band lists -------------------------------------------

test('M2: sparse arrays, non-arrays and throwing getters give f:codec, never a throw', () => {
  const bare = { thresholds: THRESHOLDS, grid: 'full' };
  for (const index of [0, 5, 9]) {
    const sparse = [...NEUTRAL_BANDS];
    delete sparse[index];
    const result = gateForWrite(sparse, -0.5);
    assert.deepEqual(result, {
      ok: false,
      reasons: [{ code: 'f:codec', value: `band ${index}: missing (hole in a sparse array)` }],
      metrics: bare,
    });
  }
  assert.deepEqual(codes(gateForWrite(new Array(10), -0.5)), ['f:codec']);
  for (const value of [undefined, null, 42, 'x', {}, { length: 10 }, new Uint8Array(10)]) {
    const result = gateForWrite(value, -0.5);
    assert.deepEqual(result.reasons, [{ code: 'f:codec', value: 'bands must be an array' }]);
  }
  const thrower = (thrown) => [
    {
      get kind() {
        throw thrown;
      },
    },
    ...offTail(),
  ];
  assert.deepEqual(gateForWrite(thrower(new Error('boom')), -0.5).reasons, [
    { code: 'f:codec', value: 'boom' },
  ]);
  assert.deepEqual(gateForWrite(thrower(42), -0.5).reasons, [{ code: 'f:codec', value: '42' }]);
  const unprintable = {
    toString() {
      throw new Error('no');
    },
  };
  assert.deepEqual(gateForWrite(thrower(unprintable), -0.5).reasons, [
    { code: 'f:codec', value: 'the bands could not be read' },
  ]);
  const trapped = new Proxy([...NEUTRAL_BANDS], {
    get(target, key) {
      if (key === 'length') throw new Error('length trap');
      return Reflect.get(target, key);
    },
  });
  assert.deepEqual(codes(gateForWrite(trapped, -0.5)), ['f:codec']);
  // Non-number fields are never coerced (no valueOf/Symbol conversion runs).
  let coerced = 0;
  const sneaky = {
    valueOf() {
      coerced++;
      return -1;
    },
  };
  const objectGain = gateForWrite(
    [{ kind: 'PK', freqHz: 1000, gainDb: sneaky, qFactor: 1 }, ...offTail()],
    -1,
  );
  assert.equal(coerced, 0);
  assert.ok(codes(objectGain).includes('f:codec'));
  const symbolGain = gateForWrite(
    [{ kind: 'PK', freqHz: 1000, gainDb: Symbol('g'), qFactor: 1 }, ...offTail()],
    -1,
  );
  assert.ok(codes(symbolGain).includes('f:codec'));
  assert.equal(autoPreamp(new Array(10)), null);
});

test('gate is pure: same input, same output; arguments are not mutated', () => {
  const bands = structuredClone(fixture.presets.harman.eqBands);
  const snapshot = structuredClone(bands);
  assert.deepEqual(gate(bands, -3, { grid: 'drag' }), gate(bands, -3, { grid: 'drag' }));
  assert.deepEqual(bands, snapshot);
});
