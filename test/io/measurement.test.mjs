import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID, logGrid } from '../../src/dsp/grid.mjs';
import {
  MeasurementError,
  normalize,
  parseMeasurement,
  smooth,
  toGrid,
} from '../../src/io/measurement.mjs';

// Inline fixtures: 37 samples over the entire canonical range, without filesystem access.
const frequencies = logGrid(37);
const response = (frequency) => 80 + 4 * Math.log10(frequency / 1000);
const values = frequencies.map(response);
const autoEq = [
  'frequency,raw,error,smoothed',
  ...frequencies.map((frequency, i) => `${frequency},${values[i]},1,${values[i] + 2}`),
].join('\n');
const rew = [
  '* REW V5 measurement export',
  '* Frequency response, SPL and phase',
  'Freq (Hz) SPL (dB) Phase (degrees)',
  ...frequencies.map((frequency, i) => `${frequency}\t${values[i]}\t${i - 18}`),
].join('\r\n');

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function fails(action, code, message) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof MeasurementError);
    assert.equal(error.name, 'MeasurementError');
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test('AutoEq raw import, alternate column, BOM/CRLF and canonical-grid resampling', () => {
  const parsed = parseMeasurement(`\uFEFF${autoEq.replaceAll('\n', '\r\n')}\r\n`);
  assert.equal(parsed.format, 'autoeq-csv');
  assert.deepEqual(parsed.columns, ['frequency', 'raw', 'error', 'smoothed']);
  assert.deepEqual(parsed.frequencies, frequencies);
  assert.deepEqual(parsed.values, values);
  const gridded = toGrid(parsed.frequencies, parsed.values);
  assert.equal(gridded.length, 481);
  gridded.forEach((value, i) => close(value, response(GRID[i])));
  const alternate = parseMeasurement(autoEq, { format: 'autoeq-csv', column: 'SMOOTHED' });
  assert.deepEqual(
    alternate.values,
    values.map((value) => value + 2),
  );
  assert.deepEqual(
    parseMeasurement('Frequency,Target\n20,1\n20000,2', { column: 'target' }).values,
    [1, 2],
  );
});

test('REW comments, nonnumeric headers, tabs, optional phase and explicit format', () => {
  const parsed = parseMeasurement(`\uFEFF${rew}\r\n\r\n`);
  assert.equal(parsed.format, 'rew-txt');
  assert.deepEqual(parsed.columns, ['frequency', 'spl', 'phase']);
  assert.deepEqual(parsed.frequencies, frequencies);
  assert.deepEqual(parsed.values, values);
  const phase = parseMeasurement(rew, { format: 'rew-txt', column: 'phase' });
  assert.deepEqual(
    phase.values,
    frequencies.map((_, i) => i - 18),
  );
  const twoColumns = parseMeasurement(
    ['# REW response', 'Frequency SPL', ...frequencies.map((f, i) => `${f}  ${values[i]}`)].join(
      '\n',
    ),
  );
  assert.deepEqual(twoColumns.columns, ['frequency', 'spl']);
  assert.deepEqual(twoColumns.values, values);
  assert.deepEqual(parseMeasurement('Frequency SPL(dB)\n20 80\n20000 90').values, [80, 90]);
  toGrid(parsed.frequencies, parsed.values).forEach((value, i) => close(value, response(GRID[i])));
});

test('separator/decimal detection handles semicolons, tabs, whitespace, and comma CSV', () => {
  for (const separator of [';', '\t', ' ']) {
    const decimalComma = [
      `frequency${separator}raw`,
      ...frequencies.map((f, i) =>
        [f, values[i]].map((value) => String(value).replace('.', ',')).join(separator),
      ),
    ].join('\n');
    assert.deepEqual(parseMeasurement(decimalComma).values, values);
    const rewDecimal = decimalComma.split('\n').slice(1).join('\n');
    assert.deepEqual(parseMeasurement(rewDecimal).frequencies, frequencies);
  }
  assert.deepEqual(parseMeasurement('frequency;raw\n1000,5;80,2').values, [80.2]);
  assert.deepEqual(parseMeasurement('frequency;raw\n1000,5;80,2').frequencies, [1000.5]);
  assert.deepEqual(parseMeasurement('frequency, raw\n20, 80\n20000, 90').values, [80, 90]);
  assert.deepEqual(parseMeasurement('frequency,raw,error in db\n20,80,1').values, [80]);
  assert.deepEqual(parseMeasurement('20,80\n20000,90').values, [80, 90]);
  assert.deepEqual(parseMeasurement('  +2e1   -.5\r2E4  +8.0e1  ').values, [-0.5, 80]);
  assert.deepEqual(parseMeasurement('.2\t80\n.4\t90').frequencies, [0.2, 0.4]);
});

test('source samples are sorted; equal duplicates merge and conflicting duplicates fail', () => {
  const parsed = parseMeasurement('frequency,raw\n20000,3\n20,1\n1000,2\n20,1');
  assert.deepEqual(parsed.frequencies, [20, 1000, 20000]);
  assert.deepEqual(parsed.values, [1, 2, 3]);
  fails(() => parseMeasurement('20 1\n20 2'), 'meas:duplicate', /20 Hz/);
  const sourceFrequencies = Object.freeze([20000, 20, 20]);
  const sourceValues = Object.freeze([3, 1, 1]);
  assert.deepEqual(toGrid(sourceFrequencies, sourceValues, { grid: [20, 20000] }), [1, 3]);
  assert.deepEqual(sourceFrequencies, [20000, 20, 20]);
  assert.deepEqual(sourceValues, [3, 1, 1]);
  fails(() => toGrid([20, 20, 20000], [1, 2, 3]), 'meas:duplicate');
});

test('empty, unknown, malformed formats and unavailable columns have typed errors', () => {
  for (const text of ['', '\uFEFF\r\n \t\n', '* comment\n# another']) {
    fails(() => parseMeasurement(text), 'meas:empty');
  }
  fails(() => parseMeasurement('frequency,raw'), 'meas:empty');
  fails(() => parseMeasurement(autoEq, { format: 'other' }), 'meas:format');
  fails(() => parseMeasurement('not a measurement'), 'meas:format');
  for (const text of ['20,80', 'frequency', 'frequency,', 'frequency,raw,raw']) {
    fails(() => parseMeasurement(text, { format: 'autoeq-csv' }), 'meas:format');
  }
  for (const text of ['20', '20 1 2 3', '20 1\n30 2 3', 'frequency,raw\n20,1,2']) {
    fails(() => parseMeasurement(text), 'meas:format');
  }
  fails(() => parseMeasurement('frequency,target\n20,80'), 'meas:column', /raw/);
  for (const column of ['absent', 'frequency']) {
    fails(() => parseMeasurement(autoEq, { column }), 'meas:column');
  }
  fails(() => parseMeasurement('20 80', { column: 'phase' }), 'meas:column');
});

test('invalid and nonfinite numbers, including unused numeric columns, are rejected', () => {
  for (const token of ['oops', '', '1.2.3', '0x10', '80dB', '1,2,3']) {
    fails(() => parseMeasurement(`frequency;raw\n20;${token}`), 'meas:number');
  }
  for (const token of ['NaN', 'nan', 'inf', '-inf', '+Infinity', '-Infinity', '1e999']) {
    fails(() => parseMeasurement(`frequency,raw\n20,${token}`), 'meas:nonfinite');
    fails(() => parseMeasurement(`${token}\t80`), 'meas:nonfinite');
  }
  fails(() => parseMeasurement('frequency,raw,smoothed\n20,80,NaN'), 'meas:nonfinite');
  fails(() => parseMeasurement('frequency,raw\nwat,80'), 'meas:number');
  for (const frequency of [0, -20]) {
    fails(() => parseMeasurement(`${frequency} 80`), 'meas:order');
  }
});

test('resampling is exact for linear-in-log responses and supports custom grids', () => {
  const source = Object.freeze([10, 100, 1000, 10000, 30000]);
  const data = Object.freeze(source.map((f) => -7 + 3 * Math.log2(f)));
  const target = logGrid(101, 20, 20000);
  toGrid(source, data, { grid: target }).forEach((value, i) =>
    close(value, -7 + 3 * Math.log2(target[i])),
  );
  assert.deepEqual(toGrid([20, 200, 2000], [1, 2, 3], { grid: [20, 200, 2000] }), [1, 2, 3]);
  close(toGrid([20, 2000], [0, 10], { grid: [200] })[0], 5);
});

test('coverage allows only 1% flat endpoint extension and names missing ranges', () => {
  const extended = toGrid([20.2, 19800], [1, 9]);
  assert.equal(extended[0], 1);
  assert.equal(extended[extended.length - 1], 9);
  fails(() => toGrid([20.201, 20000], [1, 2]), 'meas:coverage', /20–20\.201 Hz/);
  fails(() => toGrid([20, 19799], [1, 2]), 'meas:coverage', /19799–20000 Hz/);
  fails(() => toGrid([100, 10000], [1, 2]), 'meas:coverage', /20–100 Hz and 10000–20000 Hz/);
  fails(() => toGrid([20 * 2 ** (1 / 24), 20000], [1, 2]), 'meas:coverage');
  assert.deepEqual(toGrid([1000], [3], { grid: [995, 1005] }), [3, 3]);
});

test('processing validates lengths, finite numbers, positive frequencies, and grid order', () => {
  fails(() => toGrid([], []), 'meas:empty');
  fails(() => toGrid([20], []), 'meas:format');
  fails(() => toGrid([20, 20000], [1, Infinity]), 'meas:nonfinite');
  fails(() => toGrid([20, Infinity], [1, 2]), 'meas:nonfinite');
  fails(() => toGrid([20, '20000'], [1, 2]), 'meas:number');
  fails(() => toGrid([20, 20000], [1, '2']), 'meas:number');
  fails(() => toGrid([0, 20000], [1, 2]), 'meas:order');
  for (const grid of [[], [200, 20], [20, 20], [0, 20], [-20, 20], [20, NaN], [20, '30']]) {
    const code =
      grid.length === 0
        ? 'meas:empty'
        : grid.includes(NaN)
          ? 'meas:nonfinite'
          : grid.includes('30')
            ? 'meas:number'
            : 'meas:order';
    fails(() => toGrid([20, 20000], [1, 2], { grid }), code);
  }
  fails(() => normalize([], []), 'meas:empty');
  fails(() => normalize([1], [20, 20000]), 'meas:format');
  fails(() => normalize([1, NaN], [20, 20000]), 'meas:nonfinite');
  fails(() => normalize([1, 2], [20000, 20]), 'meas:order');
  fails(() => smooth([], [], 3), 'meas:empty');
  fails(() => smooth([1], [20, 20000], 3), 'meas:format');
  fails(() => smooth([1, 2], [20, Infinity], 3), 'meas:nonfinite');
  fails(() => smooth([1, 2], [20, 20], 3), 'meas:order');
});

test('1 kHz normalization interpolates the reference and leaves inputs untouched', () => {
  const input = Object.freeze(GRID.map(response));
  const output = normalize(input, GRID);
  output.forEach((value, i) => close(value, response(GRID[i]) - 80));
  assert.deepEqual(input, GRID.map(response));
  assert.deepEqual(normalize([7, 9, 12], [20, 1000, 20000], { mode: '1k' }), [-2, 0, 3]);
  assert.deepEqual(normalize([9, 12], [1000, 20000]), [0, 3]);
  assert.deepEqual(normalize([7, 9], [20, 1000]), [-2, 0]);
  fails(() => normalize([1, 2], [1001, 20000]), 'meas:coverage', /1000 Hz/);
  fails(() => normalize([1, 2], [20, 999]), 'meas:coverage');
  fails(() => normalize([1, 2], [20, 20000], { mode: 'other' }), 'meas:format');
});

test('mean-300-3k normalization uses the inclusive in-band arithmetic sample mean', () => {
  const output = normalize(values, frequencies, { mode: 'mean-300-3k' });
  const band = output.filter((_, i) => frequencies[i] >= 300 && frequencies[i] <= 3000);
  close(band.reduce((sum, value) => sum + value, 0) / band.length, 0);
  assert.deepEqual(
    normalize([99, 2, 4, 6, 99], [20, 300, 1000, 3000, 20000], { mode: 'mean-300-3k' }),
    [95, -2, 0, 2, 95],
  );
  for (const grid of [
    [301, 20000],
    [20, 2999],
    [20, 20000],
  ]) {
    fails(() => normalize([1, 2], grid, { mode: 'mean-300-3k' }), 'meas:coverage');
  }
});

test('fractional octave smoothing preserves constants exactly, including clipped edges', () => {
  for (const fraction of [3, 6, 12]) {
    const input = Object.freeze(GRID.map(() => 80.2));
    const output = smooth(input, GRID, fraction);
    assert.deepEqual(output, input);
    assert.notEqual(output, input);
    assert.deepEqual(smooth([7], [1000], fraction), [7]);
  }
  fails(() => smooth([1, 2], [20, 20000], 4), 'meas:format');
});

test('smoothing reduces narrow spikes with symmetric fractional-octave windows', () => {
  const input = Object.freeze(GRID.map((_, i) => (i === 240 ? 12 : 0)));
  const thirds = smooth(input, GRID, 3);
  const sixths = smooth(input, GRID, 6);
  const twelfths = smooth(input, GRID, 12);
  assert.ok(thirds[240] > 0 && thirds[240] < sixths[240]);
  assert.ok(sixths[240] < twelfths[240] && twelfths[240] < 12);
  for (let i = 1; i <= 10; i++) close(thirds[240 - i], thirds[240 + i]);
  assert.equal(thirds[0], 0);
  assert.equal(thirds[480], 0);
  const grid = [100, 100 * 2 ** (1 / 6), 100 * 2 ** (2 / 6)];
  assert.deepEqual(smooth([0, 12, 0], grid, 3), [6, 4, 6]);
  assert.deepEqual(
    input,
    GRID.map((_, i) => (i === 240 ? 12 : 0)),
  );
});
