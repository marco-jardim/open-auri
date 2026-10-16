import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import fc from 'fast-check';
import {
  finalizeBands,
  oppositeNeighbourScore,
  parameterBox,
  sharpnessCoefficient,
  SOLVER_DEFAULTS,
  solvePeq,
  speedParameters,
  targetFromPoints,
} from '../../src/solver/peq.mjs';
import { curveResponseDb } from '../../src/dsp/distance.mjs';
import { GRID, logGrid } from '../../src/dsp/grid.mjs';
import { gateForWrite } from '../../src/safety/gate.mjs';
import { SOFT_RANGES } from '../../src/safety/policy.mjs';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);
const presets = Object.entries(fixture.presets);

const response = (bands, grid = GRID) => curveResponseDb({ bands }, grid);
const levelMatched = (values) => {
  const window = values.filter((_, i) => GRID[i] >= 300 && GRID[i] <= 3000);
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  return values.map((v) => v - mean);
};
const active = (bands) => bands.filter((b) => b.kind !== 'OFF');
const withoutTime = ({ elapsedMs, ...rest }) => (assert.ok(elapsedMs >= 0), rest);
const bell = (fc, gainDb, octaves) =>
  GRID.map((f) => gainDb * Math.exp(-0.5 * (Math.log2(f / fc) / octaves) ** 2));

/** Checks the invariants every solver result must satisfy. */
function assertValid(result, experimental = false) {
  assertCurve(result, experimental);
  assert.ok(Number.isFinite(result.rmsDb) && Number.isFinite(result.loss));
}

/** Checks a gate-approved, ordered, grid-rounded 10-section curve. */
function assertCurve(result, experimental = false) {
  assert.equal(result.bands.length, 10);
  assert.deepEqual(result.gate, { ok: true, reasons: [] });
  const verdict = gateForWrite(result.bands, result.preampDb, { experimental });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.reasons));
  for (const band of active(result.bands)) {
    assert.ok(['PK', 'LS', ...(experimental ? ['HS'] : [])].includes(band.kind));
    assert.equal(Math.round(band.gainDb * 10) / 10, band.gainDb);
    assert.equal(Math.round(band.freqHz), band.freqHz);
    assert.equal(Math.round(band.qFactor * 100) / 100, band.qFactor);
  }
  const bands = active(result.bands);
  const firstBoost = bands.findIndex((b) => b.gainDb > 0);
  if (firstBoost >= 0) assert.ok(bands.slice(firstBoost).every((b) => b.gainDb > 0));
}

// --- Basic behaviour -------------------------------------------------------------

test('flat target gives the neutral preset', () => {
  const result = solvePeq({ target: GRID.map(() => 0) });
  assertValid(result);
  assert.ok(result.bands.every((b) => b.kind === 'OFF' || Math.abs(b.gainDb) <= 0.1));
  assert.equal(result.stopReason, 'flat');
  assert.equal(result.preampDb, -0.5);
  assert.equal(result.rmsDb, 0);
  assert.equal(result.iterations, 0);
});

test('a constant offset is a flat target (level matching)', () => {
  const result = solvePeq({ target: GRID.map(() => 3) });
  assert.ok(result.bands.every((b) => b.kind === 'OFF'));
  assert.ok(result.rmsDb < 1e-9);
});

test('single PK target is reproduced with RMS < 0.5 dB', () => {
  const target = response([{ kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1.5 }]);
  const result = solvePeq({ target });
  assertValid(result);
  assert.ok(result.rmsDb < 0.5, `rms ${result.rmsDb}`);
  assert.ok(active(result.bands).length >= 1);
});

test('LS + PK target is reproduced with RMS < 0.5 dB', () => {
  const target = response([
    { kind: 'LS', freqHz: 200, gainDb: 4, qFactor: 0.7 },
    { kind: 'PK', freqHz: 3000, gainDb: -5, qFactor: 2 },
  ]);
  const result = solvePeq({ target });
  assertValid(result);
  assert.ok(result.rmsDb < 0.5, `rms ${result.rmsDb}`);
});

for (const [id, preset] of presets) {
  test(`official preset ${id} as target: RMS < 1 dB, gate ok, < 1.5 s`, (t) => {
    const target = levelMatched(response(preset.eqBands));
    const result = solvePeq({ target });
    t.diagnostic(
      `${id}: rms ${result.rmsDb.toFixed(3)} dB, loss ${result.loss.toFixed(3)}, ` +
        `${result.iterations} it, ${result.elapsedMs.toFixed(0)} ms, ${result.stopReason}, ` +
        `${active(result.bands).length} bands, preamp ${result.preampDb}`,
    );
    assertValid(result);
    assert.ok(result.rmsDb < 1, `rms ${result.rmsDb}`);
    assert.ok(result.elapsedMs < 1500, `elapsed ${result.elapsedMs}`);
  });
}

test('trebleDetail: pure AutoEq averaging ignores the treble shape', (t) => {
  const target = levelMatched(response(fixture.presets.energico.eqBands));
  const autoEq = solvePeq({ target, trebleDetail: 0 });
  const detailed = solvePeq({ target });
  t.diagnostic(
    `energico rms: trebleDetail 0 → ${autoEq.rmsDb.toFixed(3)} dB, ` +
      `0.5 → ${detailed.rmsDb.toFixed(3)} dB`,
  );
  assertValid(autoEq);
  assert.ok(detailed.rmsDb < autoEq.rmsDb);
});

test('deterministic: same input gives the same output', () => {
  const target = levelMatched(response(presets[0][1].eqBands));
  const a = solvePeq({ target, seed: 7 });
  const b = solvePeq({ target, seed: 7 });
  assert.notEqual(a.stopReason, 'time');
  assert.deepEqual(withoutTime(a), withoutTime(b));
});

test('measurement: the correction is target - measurement', () => {
  const measurement = response([{ kind: 'PK', freqHz: 2500, gainDb: 5, qFactor: 2 }]);
  const curve = GRID.map(() => 1);
  const direct = solvePeq({ target: measurement.map((m, i) => curve[i] - m) });
  const viaMeasurement = solvePeq({ target: curve, measurement });
  assert.deepEqual(withoutTime(direct), withoutTime(viaMeasurement));
  assert.ok(direct.rmsDb < 0.5);
  assert.ok(active(direct.bands).some((b) => b.gainDb < 0));
});

// --- Gate feasibility (property) ------------------------------------------------

test('property: random smooth targets always pass gateForWrite', () => {
  const bellArb = fc.record({
    logF: fc.double({ min: Math.log10(20), max: Math.log10(20000), noNaN: true }),
    gainDb: fc.double({ min: -12, max: 12, noNaN: true }),
    octaves: fc.double({ min: 0.15, max: 2, noNaN: true }),
  });
  fc.assert(
    fc.property(fc.array(bellArb, { minLength: 1, maxLength: 4 }), (bells) => {
      const target = GRID.map((_, i) =>
        bells.reduce((s, b) => s + bell(10 ** b.logF, b.gainDb, b.octaves)[i], 0),
      );
      const result = solvePeq({ target, maxTimeMs: 120 });
      assertValid(result);
    }),
    { numRuns: 30, seed: 20261016 },
  );
});

test('huge boosts are projected into the gate (cascade check)', () => {
  const target = bell(1000, 40, 1.5);
  const result = solvePeq({ target, maxTimeMs: 600, speed: 100 });
  assertValid(result);
  assert.ok(active(result.bands).filter((b) => b.gainDb > 0).length >= 3);
});

test('plateaus and steps in the target seed filters', () => {
  const target = targetFromPoints([
    { freqHz: 100, gainDb: 0 },
    { freqHz: 300, gainDb: 3 },
    { freqHz: 600, gainDb: 3 },
    { freqHz: 2000, gainDb: 6 },
    { freqHz: 6000, gainDb: 0 },
  ]);
  const result = solvePeq({ target, maxTimeMs: 400 });
  assertValid(result);
  assert.ok(result.rmsDb < 1, `rms ${result.rmsDb}`);
});

test('low-frequency features stay inside the gate', () => {
  const target = bell(25, 9, 0.3).map((v, i) => v + bell(60, -9, 0.2)[i]);
  const result = solvePeq({ target, maxTimeMs: 400, weights: 'flat' });
  assertValid(result);
});

// --- Options ---------------------------------------------------------------------

test('D5 reduces opposite neighbours', () => {
  const target = bell(2000, 6, 0.25).map((v, i) => v + bell(2900, -6, 0.25)[i]);
  const plain = solvePeq({ target, d5Weight: 0 });
  const d5 = solvePeq({ target, d5Weight: 1 });
  assertValid(plain);
  assertValid(d5);
  const before = oppositeNeighbourScore(plain.bands);
  const after = oppositeNeighbourScore(d5.bands);
  assert.ok(before > 1, `score without D5 ${before}`);
  assert.ok(after < before / 2, `score ${after} vs ${before}`);
});

test('HS only with allowExperimental and the engenharia layer', () => {
  const target = targetFromPoints([
    { freqHz: 60, gainDb: 6 },
    { freqHz: 200, gainDb: 0 },
    { freqHz: 5000, gainDb: 0 },
    { freqHz: 12000, gainDb: -6 },
  ]);
  const engineering = solvePeq({ target, allowExperimental: true, layer: 'engenharia' });
  assertValid(engineering, true);
  assert.ok(engineering.bands.some((b) => b.kind === 'HS'));
  for (const options of [
    { allowExperimental: true, layer: 'ajustar' },
    { allowExperimental: false, layer: 'engenharia' },
    { allowExperimental: true, layer: 'ouvir' },
    {},
  ]) {
    const result = solvePeq({ target, maxTimeMs: 300, ...options });
    assertValid(result);
    assert.ok(result.bands.every((b) => b.kind !== 'HS'));
  }
});

test('soft ranges keep every section inside SOFT_RANGES', () => {
  const target = levelMatched(response(presets[1][1].eqBands));
  const result = solvePeq({ target, ranges: 'soft', maxTimeMs: 500 });
  assertValid(result);
  for (const band of active(result.bands)) {
    const box = parameterBox(band.kind, true, band.qFactor, band.gainDb);
    assert.ok(band.freqHz >= box.fMin && band.freqHz <= box.fMax);
    assert.ok(band.qFactor >= box.qMin && band.qFactor <= box.qMax);
    assert.ok(band.gainDb >= box.gMin && band.gainDb <= box.gMax);
  }
  const hs = solvePeq({
    target: GRID.map((f) => (f > 9000 ? 2 : f < 200 ? -4 : 0)),
    ranges: 'soft',
    allowExperimental: true,
    layer: 'engenharia',
    maxTimeMs: 300,
  });
  assertValid(hs, true);
});

test('speed: slower correction uses no larger gains and prunes more', () => {
  const target = levelMatched(response(presets[2][1].eqBands));
  const fast = solvePeq({ target, speed: 100, maxTimeMs: 400 });
  const slow = solvePeq({ target, speed: 0, maxTimeMs: 400 });
  assertValid(fast);
  assertValid(slow);
  const energy = (r) => active(r.bands).reduce((s, b) => s + b.gainDb ** 2, 0);
  assert.ok(energy(slow) <= energy(fast));
  assert.ok(active(slow.bands).every((b) => Math.abs(b.gainDb) >= 0.9));
  assert.deepEqual(speedParameters(50), { regularization: 0.02, pruneDb: 0.5 });
  assert.deepEqual(speedParameters(100), { regularization: 0, pruneDb: 0.1 });
});

test('stopping rules: targetLoss, maxIterations, maxTimeMs', () => {
  const target = levelMatched(response(presets[3][1].eqBands));
  assert.equal(solvePeq({ target, targetLoss: 100 }).stopReason, 'targetLoss');
  const capped = solvePeq({ target, maxIterations: 3 });
  assert.equal(capped.stopReason, 'iterations');
  assert.equal(capped.iterations, 3);
  assertValid(capped);
  const timed = solvePeq({ target, maxTimeMs: 1 });
  assert.equal(timed.stopReason, 'time');
  assertValid(timed);
});

test('maxBands limits the number of sections', () => {
  const target = levelMatched(response(presets[4][1].eqBands));
  assert.ok(solvePeq({ target, maxBands: 0 }).bands.every((b) => b.kind === 'OFF'));
  const two = solvePeq({ target, maxBands: 2, maxTimeMs: 300 });
  assertValid(two);
  assert.ok(active(two.bands).length <= 2);
});

test('flat weights, no level matching and custom grids', () => {
  const grid = logGrid(97, 20, 20000);
  const target = response([{ kind: 'PK', freqHz: 500, gainDb: -4, qFactor: 1 }], grid);
  const result = solvePeq({ target, grid, weights: 'flat', levelMatch: false, maxTimeMs: 300 });
  assertValid(result);
  assert.ok(result.rmsDb < 0.5);
  const low = logGrid(60, 20, 9000);
  const lowTarget = response([{ kind: 'PK', freqHz: 300, gainDb: 5, qFactor: 2 }], low);
  const lowResult = solvePeq({ target: lowTarget, grid: low, maxTimeMs: 300 });
  assertValid(lowResult);
  assert.ok(lowResult.rmsDb < 0.5);
  const high = logGrid(20, 10000, 30000);
  const highTarget = high.map((f) => (f > 14000 ? -3 : 0));
  assertValid(solvePeq({ target: highTarget, grid: high, weights: 'flat', maxTimeMs: 200 }));
});

test('invalid options are rejected', () => {
  const target = GRID.map(() => 0);
  const bad = [
    { target: [1, 2] },
    { target, grid: [1] },
    { target, grid: [...GRID].reverse() },
    { target: GRID.map(() => NaN) },
    { target, measurement: [0] },
    { target, maxBands: 11 },
    { target, maxBands: 1.5 },
    { target, layer: 'root' },
    { target, weights: 'loud' },
    { target, ranges: 'wide' },
    { target, d5Weight: -1 },
    { target, sharpnessWeight: NaN },
    { target, trebleDetail: 2 },
    { target, speed: 101 },
    { target, maxTimeMs: 0 },
    { target, maxIterations: 0 },
    { target, minStd: -1 },
    { target, targetLoss: -1 },
    { target, seed: 0.5 },
    { target: [0, 0], grid: [1, 2] },
  ];
  for (const options of bad) assert.throws(() => solvePeq(options), RangeError);
});

// --- Finalization ------------------------------------------------------------------

test('finalizeBands shrinks boosts the gate cannot hold', () => {
  const boost = { kind: 'PK', freqHz: 1000, gainDb: 9.2, qFactor: 1 };
  const cut = { kind: 'PK', freqHz: 300, gainDb: -3, qFactor: 1 };
  const result = finalizeBands([boost, boost, boost, cut]);
  assertCurve(result);
  const gains = active(result.bands).map((b) => b.gainDb);
  assert.equal(gains[0], -3);
  assert.ok(gains.slice(1).reduce((s, g) => s + g, 0) < 27.6);
});

test('finalizeBands drops sections when even the cuts fail the gate', () => {
  const resonant = { kind: 'LS', freqHz: 1000, gainDb: -24, qFactor: 20 };
  const result = finalizeBands(Array.from({ length: 10 }, () => resonant));
  assertCurve(result);
  assert.ok(active(result.bands).length < 10);
});

test('finalizeBands repairs, drops and orders sections', () => {
  const result = finalizeBands([
    { kind: 'PK', freqHz: 20.4, gainDb: 6, qFactor: 4 },
    { kind: 'PK', freqHz: 5000, gainDb: 0.02, qFactor: 2 },
    { kind: 'LP', freqHz: 10000, qFactor: 0.7 },
    { kind: 'OFF' },
    { kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 },
    { kind: 'PK', freqHz: 18000, gainDb: 3, qFactor: 25 },
    { kind: 'LS', freqHz: 100.26, gainDb: -2.04, qFactor: 0.704 },
  ]);
  assertCurve(result);
  const bands = active(result.bands);
  assert.ok(bands.every((b) => b.kind === 'PK' || b.kind === 'LS'));
  assert.deepEqual(bands[0], { kind: 'LS', freqHz: 100, gainDb: -2, qFactor: 0.7 });
  const pk = bands.find((b) => b.freqHz <= 30);
  assert.ok(pk === undefined || (pk.gainDb > 0 && pk.gainDb < 6));
  assert.ok(bands.every((b) => !(b.gainDb > 0 && b.freqHz > 16000)));
  const many = finalizeBands(
    Array.from({ length: 12 }, (_, i) => ({
      kind: 'PK',
      freqHz: 200 * (i + 1),
      gainDb: -(i + 1) / 2,
      qFactor: 2,
    })),
  );
  assertCurve(many);
  assert.equal(active(many.bands).length, 10);
  assert.ok(active(many.bands).every((b) => b.gainDb <= -1.5));
  const hs = finalizeBands([{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }], {
    experimental: true,
    ranges: 'soft',
  });
  assertCurve(hs, true);
  assert.equal(hs.bands[0].kind, 'HS');
  assert.deepEqual(
    finalizeBands([]).bands,
    Array.from({ length: 10 }, () => ({ kind: 'OFF' })),
  );
});

// --- Helpers -------------------------------------------------------------------------

test('sharpness coefficient and opposition score', () => {
  assert.ok(sharpnessCoefficient(-10, 4) < 1e-12);
  assert.ok(sharpnessCoefficient(10, 4) > 0.999);
  const limitAtQ1 = -0.09503189270199464 + 20.575128011847003;
  assert.ok(Math.abs(sharpnessCoefficient(limitAtQ1, 1) - 0.5) < 1e-12);
  assert.equal(
    oppositeNeighbourScore([
      { kind: 'PK', freqHz: 1000, gainDb: 4, qFactor: 1 },
      { kind: 'OFF' },
      { kind: 'PK', freqHz: 2000 * Math.SQRT2, gainDb: -3, qFactor: 1 },
      { kind: 'PK', freqHz: 2000, gainDb: -2, qFactor: 1 },
    ]),
    0,
  );
  const half = oppositeNeighbourScore([
    { kind: 'PK', freqHz: 1000, gainDb: 4, qFactor: 1 },
    { kind: 'PK', freqHz: 1000 * Math.SQRT2, gainDb: -3, qFactor: 1 },
  ]);
  assert.ok(Math.abs(half - 0.25 * 12) < 1e-12);
  assert.equal(SOLVER_DEFAULTS.maxTimeMs, 1200);
  assert.deepEqual(parameterBox('LS', true, 0.6, 2), {
    fMin: SOFT_RANGES.LS.freqHz.min,
    fMax: SOFT_RANGES.LS.freqHz.max,
    qMin: 0.5,
    qMax: 0.7,
    gMin: -24,
    gMax: 6,
  });
  assert.equal(parameterBox('HS', true, 0.6, 1).fMin, SOFT_RANGES['HS-boost'].freqHz.min);
  assert.equal(parameterBox('PK', true, 3, 1).gMax, SOFT_RANGES['PK-narrow'].gainDb.max);
  assert.equal(parameterBox('PK', false, 3, 1).fMax, 16000);
});

// --- C2: drawn target ------------------------------------------------------------------

test('C2 spline interpolates the points and is monotone between them', () => {
  const points = [
    { freqHz: 8000, gainDb: -4 },
    { freqHz: 50, gainDb: 6 },
    { freqHz: 300, gainDb: 0 },
    { freqHz: 1000, gainDb: 0 },
    { freqHz: 3000, gainDb: 3 },
  ];
  const freqs = points.map((p) => p.freqHz);
  const grid = [...new Set([...GRID, ...freqs])].sort((a, b) => a - b);
  const curve = targetFromPoints(points, grid);
  for (const p of points) assert.ok(Math.abs(curve[grid.indexOf(p.freqHz)] - p.gainDb) < 1e-12);
  const sorted = [...points].sort((a, b) => a.freqHz - b.freqHz);
  for (let k = 1; k < sorted.length; k++) {
    const a = sorted[k - 1];
    const b = sorted[k];
    const segment = grid
      .map((f, i) => [f, curve[i]])
      .filter(([f]) => f >= a.freqHz && f <= b.freqHz)
      .map(([, v]) => v);
    const sign = Math.sign(b.gainDb - a.gainDb);
    for (let i = 1; i < segment.length; i++) {
      assert.ok(sign * (segment[i] - segment[i - 1]) >= -1e-12);
    }
  }
  assert.equal(curve[0], 6);
  assert.equal(curve[curve.length - 1], -4);
  const target = targetFromPoints(points);
  assert.equal(target.length, GRID.length);
  assertValid(solvePeq({ target, maxTimeMs: 400 }));
});

test('C2 spline: property and edge cases', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.integer({ min: 20, max: 20000 }), { minLength: 2, maxLength: 8 }),
      fc.array(fc.double({ min: -12, max: 12, noNaN: true }), { minLength: 8, maxLength: 8 }),
      (freqs, gains) => {
        const points = freqs.map((freqHz, i) => ({ freqHz, gainDb: gains[i] }));
        const curve = targetFromPoints(points);
        const lo = Math.min(...gains.slice(0, freqs.length)) - 1e-9;
        const hi = Math.max(...gains.slice(0, freqs.length)) + 1e-9;
        assert.ok(curve.every((v) => v >= lo && v <= hi));
      },
    ),
    { numRuns: 100, seed: 7 },
  );
  assert.deepEqual(targetFromPoints([{ freqHz: 1000, gainDb: 2 }], [100, 1000, 10000]), [2, 2, 2]);
  const steep = targetFromPoints(
    [
      { freqHz: 100, gainDb: 0 },
      { freqHz: 110, gainDb: 10 },
      { freqHz: 10000, gainDb: 11 },
    ],
    [100, 105, 110, 1000, 10000],
  );
  assert.ok(steep[1] > 0 && steep[1] < 10 && steep[3] > 10 && steep[3] < 11);
  assert.throws(() => targetFromPoints([]), RangeError);
  assert.throws(() => targetFromPoints([{ freqHz: 0, gainDb: 1 }]), RangeError);
  assert.throws(() => targetFromPoints([null]), RangeError);
  assert.throws(
    () =>
      targetFromPoints([
        { freqHz: 100, gainDb: 1 },
        { freqHz: 100, gainDb: 2 },
      ]),
    RangeError,
  );
  assert.throws(() => targetFromPoints([{ freqHz: 100, gainDb: 1 }], [2, 1]), RangeError);
});
