import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID, logGrid } from '../../src/dsp/grid.mjs';
import {
  ISO226_TABLE,
  splAtPreferred,
  equalLoudnessSpl,
  contour,
  loudnessCompensationDb,
  perceptualWeights,
} from '../../src/dsp/iso226.mjs';

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

// Independent equation (1), with scalar constants supplied by each reference.
function equation(phon, alphaF, luDb, tfDb) {
  const loudnessTerm = 0.00447 * (Math.pow(10, 0.025 * phon) - 1.15);
  const thresholdTerm = Math.pow(0.4 * Math.pow(10, (tfDb + luDb) / 10 - 9), alphaF);
  return (10 / alphaF) * Math.log10(loudnessTerm + thresholdTerm) - luDb + 94;
}

test('ISO 226:2003 Table 1 contains all 29 exact, immutable rows', () => {
  assert.equal(ISO226_TABLE.length, 29);
  assert.ok(Object.isFrozen(ISO226_TABLE));
  assert.ok(ISO226_TABLE.every(Object.isFrozen));
  assert.deepEqual(
    ISO226_TABLE.map((row) => row.freqHz),
    [
      20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250,
      1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500,
    ],
  );
  assert.deepEqual(
    ISO226_TABLE.map((row) => row.alphaF),
    [
      0.532, 0.506, 0.48, 0.455, 0.432, 0.409, 0.387, 0.367, 0.349, 0.33, 0.315, 0.301, 0.288,
      0.276, 0.267, 0.259, 0.253, 0.25, 0.246, 0.244, 0.243, 0.243, 0.243, 0.242, 0.242, 0.245,
      0.254, 0.271, 0.301,
    ],
  );
  assert.deepEqual(
    ISO226_TABLE.map((row) => row.luDb),
    [
      -31.6, -27.2, -23, -19.1, -15.9, -13, -10.3, -8.1, -6.2, -4.5, -3.1, -2, -1.1, -0.4, 0, 0.3,
      0.5, 0, -2.7, -4.1, -1, 1.7, 2.5, 1.2, -2.1, -7.1, -11.2, -10.7, -3.1,
    ],
  );
  assert.deepEqual(
    ISO226_TABLE.map((row) => row.tfDb),
    [
      78.5, 68.7, 59.5, 51.1, 44, 37.5, 31.5, 26.5, 22.1, 17.9, 14.4, 11.4, 8.6, 6.2, 4.4, 3, 2.2,
      2.4, 3.5, 1.7, -1.3, -4.2, -6, -5.4, -1.5, 6, 12.6, 13.9, 12.3,
    ],
  );
});

test('1 kHz SPL equals phon within 0.05 dB throughout 20–90 phon', () => {
  for (let phon = 20; phon <= 90; phon++) {
    close(equalLoudnessSpl(phon, 1000).splDb, phon, 0.05);
    close(contour(phon, [1000]).splDb[0], phon, 0.05);
    assert.equal(equalLoudnessSpl(phon, 1000).validity, 'normative');
  }
});

test('hand-derived 100 Hz and 4 kHz references agree with equation (1) within 0.1 dB', () => {
  for (const [phon, freqHz, alphaF, luDb, tfDb, handReference] of [
    [40, 100, 0.367, -8.1, 26.5, 64.4],
    [80, 100, 0.367, -8.1, 26.5, 92.5],
    [40, 4000, 0.242, 1.2, -5.4, 36.6],
    [80, 4000, 0.242, 1.2, -5.4, 78.3],
  ]) {
    const expected = equation(phon, alphaF, luDb, tfDb);
    close(expected, handReference, 0.1);
    close(equalLoudnessSpl(phon, freqHz).splDb, expected, 0.1);
  }
});

test('all preferred SPLs reproduce the independent equation, including informative levels', () => {
  for (const phon of [0, 10, 20, 40, 60, 80, 90, 100]) {
    const { splDb } = splAtPreferred(phon);
    assert.equal(splDb.length, 29);
    ISO226_TABLE.forEach((row, index) => {
      close(splDb[index], equation(phon, row.alphaF, row.luDb, row.tfDb));
      close(equalLoudnessSpl(phon, row.freqHz).splDb, splDb[index]);
    });
  }
});

test('SPL increases strictly with phon at every preferred frequency and in the extension', () => {
  for (const freqHz of [...ISO226_TABLE.map((row) => row.freqHz), 15000, 20000]) {
    let previous = equalLoudnessSpl(0, freqHz).splDb;
    for (let phon = 5; phon <= 100; phon += 5) {
      const current = equalLoudnessSpl(phon, freqHz).splDb;
      assert.ok(current > previous, `${freqHz} Hz at ${phon} phon`);
      previous = current;
    }
  }
});

test('interpolation is linear in log-frequency for table parameters, not SPL', () => {
  const freqHz = Math.sqrt(100 * 125);
  const result = equalLoudnessSpl(60, freqHz);
  const expected = equation(60, (0.367 + 0.349) / 2, (-8.1 - 6.2) / 2, (26.5 + 22.1) / 2);
  close(result.splDb, expected);
  const interpolatedSpl = (equalLoudnessSpl(60, 100).splDb + equalLoudnessSpl(60, 125).splDb) / 2;
  assert.ok(Math.abs(result.splDb - interpolatedSpl) > 1e-4);
  assert.equal(result.validity, 'normative');
});

test('12.5–20 kHz holds the final row and flags the extension as non-normative', () => {
  for (const phon of [0, 20, 60, 80, 100]) {
    const preferred = equalLoudnessSpl(phon, 12500).splDb;
    for (const freqHz of [12500.01, 15000, 20000]) {
      const result = equalLoudnessSpl(phon, freqHz);
      assert.equal(result.splDb, preferred);
      assert.equal(result.validity, 'extrapolated');
    }
  }
});

test('validity respects the informative floor and frequency-dependent normative ceilings', () => {
  for (const [phon, freqHz] of [
    [20, 20],
    [100, 20],
    [100, 1000],
    [90, 1001],
    [90, 4000],
    [80, 4001],
    [80, 5000],
    [80, 12500],
  ]) {
    assert.equal(equalLoudnessSpl(phon, freqHz).validity, 'normative');
  }
  for (const [phon, freqHz] of [
    [100, 1001],
    [91, 2000],
    [90, 4001],
    [81, 5000],
    [90, 12500],
    [20, 20000],
    [10, 20000],
  ]) {
    assert.equal(equalLoudnessSpl(phon, freqHz).validity, 'extrapolated');
  }
  for (const phon of [0, 10, 19.999]) {
    assert.equal(equalLoudnessSpl(phon, 20).validity, 'informative');
    assert.equal(equalLoudnessSpl(phon, 12500).validity, 'informative');
  }
  assert.equal(splAtPreferred(80).validity, 'normative');
  assert.equal(splAtPreferred(10).validity, 'informative');
  assert.equal(splAtPreferred(90).validity, 'extrapolated');
  assert.equal(contour(10, [20000, 1000]).validity, 'extrapolated');
  assert.equal(contour(10, [1000, 20000]).validity, 'extrapolated');
});

test('contour defaults to the canonical 481-point grid and supports custom log grids', () => {
  const result = contour(60);
  assert.equal(result.splDb.length, 481);
  assert.equal(result.validity, 'extrapolated');
  GRID.forEach((freqHz, index) => close(result.splDb[index], equalLoudnessSpl(60, freqHz).splDb));
  const grid = Object.freeze(logGrid(13, 20, 4000));
  assert.deepEqual(
    contour(60, grid).splDb,
    grid.map((freqHz) => equalLoudnessSpl(60, freqHz).splDb),
  );
  assert.equal(contour(60, grid).validity, 'normative');
  result.splDb[0] = -1000;
  assert.notEqual(contour(60).splDb[0], -1000);
});

test('quieter listening needs bass boost, with exactly zero compensation at 1 kHz', () => {
  const grid = [20, 100, 1000, 4000, 20000];
  const { compensationDb, validity } = loudnessCompensationDb(80, 40, grid);
  assert.equal(compensationDb[2], 0);
  assert.ok(compensationDb[0] > 0);
  assert.ok(compensationDb[1] > 0);
  close(compensationDb[1], 11.9, 0.1);
  assert.equal(validity, 'extrapolated');
  const inverse = loudnessCompensationDb(40, 80, grid).compensationDb;
  compensationDb.forEach((value, index) => close(value, -inverse[index]));
  const actual = contour(40, grid).splDb;
  const reference = contour(80, grid).splDb;
  compensationDb.forEach((value, index) => {
    close(value, actual[index] - actual[2] - (reference[index] - reference[2]));
  });
});

test('compensation anchors analytically even if the grid omits 1 kHz', () => {
  const grid = [20, 100, 4000];
  const { compensationDb } = loudnessCompensationDb(80, 40, grid);
  assert.deepEqual(
    compensationDb,
    loudnessCompensationDb(80, 40, [20, 100, 1000, 4000]).compensationDb.filter(
      (_, index) => index !== 2,
    ),
  );
  assert.equal(loudnessCompensationDb(80, 40, grid).validity, 'normative');
  assert.deepEqual(loudnessCompensationDb(60, 60, grid).compensationDb, [0, 0, 0]);
  assert.equal(loudnessCompensationDb(20, 10, grid).validity, 'informative');
  assert.equal(loudnessCompensationDb(10, 20, grid).validity, 'informative');
  assert.equal(loudnessCompensationDb(90, 40, [5000]).validity, 'extrapolated');
  assert.equal(loudnessCompensationDb(40, 90, [5000]).validity, 'extrapolated');
  assert.equal(loudnessCompensationDb(80, 40).compensationDb.length, GRID.length);
});

test('perceptual weights follow the amplitude formula, normalize to max 1, then floor at 0.05', () => {
  for (const phon of [0, 20, 60, 80, 100]) {
    const { weights, validity } = perceptualWeights(GRID, phon);
    assert.equal(weights.length, GRID.length);
    assert.ok(weights.every((weight) => weight >= 0.05 && weight <= 1));
    assert.equal(Math.max(...weights), 1);
    assert.equal(validity, 'extrapolated');
    const raw = GRID.map((freqHz) => 10 ** (-(equalLoudnessSpl(phon, freqHz).splDb - phon) / 20));
    const max = Math.max(...raw);
    weights.forEach((weight, index) => close(weight, Math.max(0.05, raw[index] / max)));
  }
  assert.equal(Math.min(...perceptualWeights().weights), 0.05);
  assert.deepEqual(perceptualWeights(), perceptualWeights(GRID, 60));
  assert.deepEqual(perceptualWeights([1000]), { weights: [1], validity: 'normative' });
  assert.equal(perceptualWeights([20, 1000], 10).validity, 'informative');
});

test('phon and frequency domains throw RangeError with stable messages in every public API', () => {
  const phonError = { name: 'RangeError', message: 'phon must be a finite number in [0, 100]' };
  for (const phon of [-1, 100.01, NaN, Infinity, -Infinity]) {
    assert.throws(() => equalLoudnessSpl(phon, 1000), phonError);
    assert.throws(() => splAtPreferred(phon), phonError);
    assert.throws(() => contour(phon), phonError);
    assert.throws(() => loudnessCompensationDb(phon, 40), phonError);
    assert.throws(() => loudnessCompensationDb(40, phon), phonError);
    assert.throws(() => perceptualWeights(GRID, phon), phonError);
  }
  const frequencyError = {
    name: 'RangeError',
    message: 'freqHz must be a finite number in [20, 20000]',
  };
  for (const freqHz of [0, 19.99, 20000.01, NaN, Infinity, -Infinity]) {
    assert.throws(() => equalLoudnessSpl(60, freqHz), frequencyError);
    assert.throws(() => contour(60, [freqHz]), frequencyError);
    assert.throws(() => loudnessCompensationDb(80, 40, [freqHz]), frequencyError);
    assert.throws(() => perceptualWeights([freqHz]), frequencyError);
  }
  for (const operation of [
    () => contour(60, []),
    () => loudnessCompensationDb(80, 40, []),
    () => perceptualWeights([]),
  ]) {
    assert.throws(operation, {
      name: 'RangeError',
      message: 'grid must contain at least one frequency',
    });
  }
});
