import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { curveResponseDb, distance } from '../../src/dsp/distance.mjs';
import { designSection, magnitudeDb, NEUTRAL_BANDS } from '../../src/dsp/eq0xcb.mjs';
import { GRID, logGrid } from '../../src/dsp/grid.mjs';
import { perceptualWeights } from '../../src/dsp/iso226.mjs';

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('curveResponseDb uses the canonical grid and adds a default or explicit preamp', () => {
  assert.deepEqual(
    curveResponseDb({ bands: [] }),
    GRID.map(() => 0),
  );
  assert.deepEqual(
    curveResponseDb({ bands: NEUTRAL_BANDS, preampDb: -4.5 }),
    GRID.map(() => -4.5),
  );
  assert.deepEqual(curveResponseDb({ bands: [], preampDb: 3 }, [1000]), [3]);
});

test('curve responses sum the shared designer/evaluator for every section kind', () => {
  const bands = [
    { kind: 'PK', freqHz: 800, gainDb: 4, qFactor: 2 },
    { kind: 'LS', freqHz: 100, gainDb: 3, qFactor: 0.7 },
    { kind: 'HS', freqHz: 8000, gainDb: -2, qFactor: 0.7 },
    { kind: 'LP', freqHz: 16000, qFactor: Math.SQRT1_2 },
    { kind: 'HP', freqHz: 30, qFactor: Math.SQRT1_2 },
    { kind: 'OFF' },
  ];
  const grid = logGrid(17);
  const response = curveResponseDb({ bands, preampDb: -5 }, grid);
  grid.forEach((freqHz, index) => {
    close(response[index], magnitudeDb(bands, freqHz) - 5);
    const sectionsDb = bands.reduce((sum, band) => {
      const { b0, b1, b2, a1, a2 } = designSection(band);
      const omega = (2 * Math.PI * freqHz) / 96000;
      const real = b0 + b1 * Math.cos(omega) + b2 * Math.cos(2 * omega);
      const imaginary = -b1 * Math.sin(omega) - b2 * Math.sin(2 * omega);
      const denominatorReal = 1 + a1 * Math.cos(omega) + a2 * Math.cos(2 * omega);
      const denominatorImaginary = -a1 * Math.sin(omega) - a2 * Math.sin(2 * omega);
      return (
        sum +
        10 *
          Math.log10(
            (real ** 2 + imaginary ** 2) / (denominatorReal ** 2 + denominatorImaginary ** 2),
          )
      );
    }, -5);
    close(response[index], sectionsDb, 1e-7);
  });
});

test('distance of a response or curve from itself is exactly zero, with no regions', () => {
  const curve = {
    bands: [{ kind: 'PK', freqHz: 400, gainDb: 8, qFactor: 1.2 }],
    preampDb: -8,
  };
  const response = curveResponseDb(curve);
  for (const [a, b] of [
    [curve, curve],
    [response, response],
    [curve, response],
    [response, curve],
  ]) {
    assert.deepEqual(distance(a, b), { rmsDb: 0, maxDb: 0, maxFreqHz: 20, regions: [] });
  }
});

test('level matching removes a constant preamp difference by default and can be disabled', () => {
  const a = { bands: NEUTRAL_BANDS, preampDb: -8 };
  const b = { bands: NEUTRAL_BANDS };
  assert.equal(distance(a, b).rmsDb, 0);
  const absolute = distance(a, b, { levelMatch: false });
  close(absolute.rmsDb, 8);
  assert.equal(absolute.maxDb, 8);
  assert.equal(absolute.maxFreqHz, GRID[0]);
  assert.deepEqual(absolute.regions, [{ fromHz: 20, toHz: 20000, peakDiffDb: 8 }]);
});

test('level matching uses the inclusive 300–3000 Hz unweighted mean, without mutation', () => {
  const grid = Object.freeze([299, 300, 1000, 3000, 3001]);
  const a = Object.freeze([100, 2, 5, 8, 100]);
  const b = Object.freeze([0, 0, 0, 0, 0]);
  const options = { grid, weights: [1, 1, 100, 1, 1] };
  const result = distance(a, b, options);
  assert.equal(result.maxDb, 95);
  close(result.rmsDb, Math.sqrt((2 * 95 ** 2 + 18) / 104));
  assert.deepEqual(distance(b, a, options), result);
  assert.deepEqual(a, [100, 2, 5, 8, 100]);
});

test('a grid without matching-window samples retains the absolute difference', () => {
  const options = { grid: [20, 40] };
  const result = distance([1, 3], [0, 0], options);
  close(result.rmsDb, Math.sqrt(5));
  assert.deepEqual(result, distance([1, 3], [0, 0], { ...options, levelMatch: false }));
});

test('regions are contiguous strict-threshold runs with unsigned peaks, including grid edges', () => {
  const grid = [20, 50, 100, 200, 500, 1000, 2000, 4000];
  const a = [2, -3, 0, 1, 1.5, -2, 0, 4];
  const b = grid.map(() => 0);
  const result = distance(a, b, { grid, levelMatch: false });
  assert.deepEqual(result.regions, [
    { fromHz: 20, toHz: 50, peakDiffDb: 3 },
    { fromHz: 500, toHz: 1000, peakDiffDb: 2 },
    { fromHz: 4000, toHz: 4000, peakDiffDb: 4 },
  ]);
  assert.equal(result.maxDb, 4);
  assert.equal(result.maxFreqHz, 4000);
  assert.deepEqual(distance(b, a, { grid, levelMatch: false }), result);
  assert.deepEqual(distance(a, b, { grid, thresholdDb: 4, levelMatch: false }).regions, []);
});

test('maximum ties select the lowest frequency; zero threshold includes all nonzero samples', () => {
  const result = distance([3, -3], [0, 0], {
    grid: [100, 1000],
    thresholdDb: 0,
    levelMatch: false,
  });
  assert.equal(result.maxFreqHz, 100);
  assert.deepEqual(result.regions, [{ fromHz: 100, toHz: 1000, peakDiffDb: 3 }]);
});

test('RMS weights are normalized, scale invariant and do not change maxima or regions', () => {
  const a = [2, 4, 6];
  const b = [0, 0, 0];
  const options = { grid: [100, 1000, 10000], levelMatch: false };
  const weighted = distance(a, b, { ...options, weights: [1, 2, 3] });
  close(weighted.rmsDb, Math.sqrt(24));
  assert.deepEqual(distance(a, b, { ...options, weights: [100, 200, 300] }), weighted);
  const unweighted = distance(a, b, options);
  assert.equal(weighted.maxDb, unweighted.maxDb);
  assert.deepEqual(weighted.regions, unweighted.regions);
  close(distance(a, b, { ...options, weights: [0, 1, 0] }).rmsDb, 4);
  close(
    distance(a, b, { ...options, weights: options.grid.map(() => Number.MAX_VALUE) }).rmsDb,
    unweighted.rmsDb,
  );
});

const randomBand = fc.record({
  kind: fc.constant('PK'),
  freqHz: fc.double({ min: 40, max: 12000, noNaN: true }),
  gainDb: fc.double({ min: -12, max: 12, noNaN: true }),
  qFactor: fc.double({ min: 0.35, max: 4, noNaN: true }),
});
const randomCurve = fc.record({
  bands: fc.array(randomBand, { minLength: 0, maxLength: 3 }),
  preampDb: fc.double({ min: -12, max: 0, noNaN: true }),
});

test('random filter curves have symmetric distances and identical regions (fast-check 4)', () => {
  const grid = logGrid(49);
  const { weights } = perceptualWeights(grid);
  fc.assert(
    fc.property(randomCurve, randomCurve, fc.boolean(), (a, b, levelMatch) => {
      const options = { grid, weights, levelMatch };
      assert.deepEqual(distance(a, b, options), distance(b, a, options));
    }),
    { numRuns: 100, seed: 0x517 },
  );
});

test('RMS obeys the approximate triangle inequality for random curves (fast-check 4)', () => {
  const grid = logGrid(49);
  const { weights } = perceptualWeights(grid);
  fc.assert(
    fc.property(randomCurve, randomCurve, randomCurve, fc.boolean(), (a, b, c, levelMatch) => {
      const responses = [a, b, c].map((curve) => curveResponseDb(curve, grid));
      for (const options of [
        { grid, levelMatch },
        { grid, levelMatch, weights },
      ]) {
        const ab = distance(responses[0], responses[1], options).rmsDb;
        const bc = distance(responses[1], responses[2], options).rmsDb;
        const ac = distance(responses[0], responses[2], options).rmsDb;
        assert.ok(ab <= ac + bc + 1e-9, `${ab} > ${ac} + ${bc}`);
        assert.ok(ac <= ab + bc + 1e-9, `${ac} > ${ab} + ${bc}`);
      }
    }),
    { numRuns: 100, seed: 0x226 },
  );
});

test('invalid response grids, responses, thresholds and weights are rejected', () => {
  for (const grid of [[], [0], [-1], [NaN], [Infinity], [100, 99]]) {
    assert.throws(() => distance([], [], { grid }), /grid must contain strictly increasing/);
    assert.throws(() => curveResponseDb({ bands: [] }, grid), RangeError);
  }
  const options = { grid: [100, 1000, 10000] };
  const zeros = [0, 0, 0];
  for (const invalid of [[], [1, 2], [NaN, 0, 0], [0, Infinity, 0]]) {
    assert.throws(() => distance(invalid, zeros, options), /responses must contain/);
    assert.throws(() => distance(zeros, invalid, options), RangeError);
  }
  for (const thresholdDb of [-1, NaN, Infinity]) {
    assert.throws(() => distance(zeros, zeros, { ...options, thresholdDb }), /thresholdDb must/);
  }
  for (const weights of [[], [1, 2], [1, -1, 1], [NaN, 1, 1], [Infinity, 1, 1], [0, 0, 0]]) {
    assert.throws(() => distance(zeros, zeros, { ...options, weights }), /weights must/);
  }
});

test('curve analysis rejects nonfinite preamps and invalid or nonfinite section designs', () => {
  for (const preampDb of [NaN, Infinity, -Infinity]) {
    assert.throws(() => curveResponseDb({ bands: [], preampDb }), /preampDb must be finite/);
  }
  assert.throws(
    () => curveResponseDb({ bands: [{ kind: 'PK', freqHz: 1000, gainDb: 1e308, qFactor: 1 }] }),
    /bands must produce finite section coefficients/,
  );
  assert.throws(
    () => curveResponseDb({ bands: [{ kind: 'PK', freqHz: 1000, gainDb: 1, qFactor: 0 }] }),
    RangeError,
  );
});
