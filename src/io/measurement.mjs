import { GRID } from '../dsp/grid.mjs';

/**
 * @typedef {'meas:empty' | 'meas:format' | 'meas:number' | 'meas:nonfinite' |
 * 'meas:order' | 'meas:duplicate' | 'meas:coverage' | 'meas:column'} MeasurementErrorCode
 * @typedef {'autoeq-csv' | 'rew-txt'} MeasurementFormat
 * @typedef {{frequencies: number[], values: number[]}} Series
 * @typedef {Series & {format: MeasurementFormat, columns: string[]}} Measurement
 */

/** A measurement import/processing failure with a stable, machine-readable code. */
export class MeasurementError extends Error {
  /**
   * @param {MeasurementErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'MeasurementError';
    this.code = code;
  }
}

/**
 * @param {number} value
 * @param {string} label
 */
function finiteNumber(value, label) {
  if (typeof value !== 'number') {
    throw new MeasurementError('meas:number', `${label} must be a number.`);
  }
  if (!Number.isFinite(value)) {
    throw new MeasurementError('meas:nonfinite', `${label} must be finite.`);
  }
}

/**
 * Validate, copy, sort ascending, and merge identical duplicate samples.
 * Nonpositive frequencies use meas:order; unsorted input is accepted.
 * @param {readonly number[]} frequencies
 * @param {readonly number[]} values
 * @returns {Series}
 */
function orderedSeries(frequencies, values) {
  validateValues(values, frequencies);
  const pairs = frequencies.map((frequency, index) => {
    finiteNumber(frequency, `Frequency ${index + 1}`);
    if (frequency <= 0) {
      throw new MeasurementError('meas:order', 'Frequencies must be positive.');
    }
    return { frequency, value: values[index] };
  });
  pairs.sort((a, b) => a.frequency - b.frequency);
  /** @type {number[]} */
  const sorted = [];
  /** @type {number[]} */
  const merged = [];
  for (const { frequency, value } of pairs) {
    if (frequency === sorted[sorted.length - 1]) {
      if (value !== merged[merged.length - 1]) {
        throw new MeasurementError('meas:duplicate', `Conflicting values at ${frequency} Hz.`);
      }
    } else {
      sorted.push(frequency);
      merged.push(value);
    }
  }
  return { frequencies: sorted, values: merged };
}

/**
 * @param {readonly number[]} values
 * @param {readonly number[]} grid
 */
function validateValues(values, grid) {
  if (values.length !== grid.length) {
    throw new MeasurementError('meas:format', 'Frequencies and values must have the same length.');
  }
  if (values.length === 0) {
    throw new MeasurementError('meas:empty', 'No measurement samples.');
  }
  values.forEach((value, index) => finiteNumber(value, `Value ${index + 1}`));
}

/** @param {readonly number[]} grid */
function validateGrid(grid) {
  if (grid.length === 0) {
    throw new MeasurementError('meas:empty', 'The frequency grid is empty.');
  }
  grid.forEach((frequency, index) => {
    finiteNumber(frequency, `Grid frequency ${index + 1}`);
    if (frequency <= 0 || (index > 0 && frequency <= grid[index - 1])) {
      throw new MeasurementError('meas:order', 'Grid frequencies must be positive and increasing.');
    }
  });
}

/** @param {string} line */
function detectSeparator(line) {
  if (line.includes(';')) return ';';
  if (line.includes('\t')) return '\t';
  if (/^frequency\s*,/i.test(line)) return ',';
  // A comma inside a whitespace-separated numeric token is a decimal mark.
  if (/\s/.test(line) && !line.split(/\s+/).some((token) => token.endsWith(','))) return ' ';
  return line.includes(',') ? ',' : ' ';
}

/**
 * @param {string} line
 * @param {string} separator
 */
function fields(line, separator) {
  return line.split(separator === ' ' ? /\s+/ : separator).map((field) => field.trim());
}

/**
 * @param {string} token
 * @param {string} separator
 * @param {string} label
 */
function parseNumber(token, separator, label) {
  if (/^[+-]?(?:nan|inf(?:inity)?)$/i.test(token)) {
    throw new MeasurementError('meas:nonfinite', `${label} is not finite: ${token}.`);
  }
  const decimal = separator === ',' ? token : token.replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(decimal)) {
    throw new MeasurementError('meas:number', `${label} is not a number: ${token || '(empty)'}.`);
  }
  const value = Number(decimal);
  finiteNumber(value, label);
  return value;
}

/**
 * Parse AutoEq CSV or REW text, including BOM/CRLF, decimal commas, and scientific notation.
 * AutoEq needs a frequency-first header; raw is the default value column. REW skips blank,
 * '*'/'#' comment and nonnumeric header lines; its columns are frequency, spl, optional phase.
 * Returned column names are lowercase. All numeric columns are checked, not just the selected one.
 * A frequency/SPL header is recognized as REW rather than AutoEq in auto mode.
 * @param {string} text
 * @param {{format?: 'auto' | MeasurementFormat, column?: string}} [options]
 * @returns {Measurement}
 */
export function parseMeasurement(text, { format = 'auto', column } = {}) {
  if (!['auto', 'autoeq-csv', 'rew-txt'].includes(format)) {
    throw new MeasurementError('meas:format', `Unsupported measurement format: ${format}.`);
  }
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*') && !line.startsWith('#'));
  if (lines.length === 0) {
    throw new MeasurementError('meas:empty', 'No measurement data.');
  }
  let separator = detectSeparator(lines[0]);
  let columns = fields(lines[0], separator).map((name) => name.toLowerCase());
  const autoEqHeader = columns[0] === 'frequency' && !/^spl(?:\b|\()/i.test(columns[1]);
  const detected = format === 'auto' ? (autoEqHeader ? 'autoeq-csv' : 'rew-txt') : format;
  let rows;
  if (detected === 'autoeq-csv') {
    if (
      columns[0] !== 'frequency' ||
      columns.length < 2 ||
      columns.some((name) => !name) ||
      new Set(columns).size !== columns.length
    ) {
      throw new MeasurementError('meas:format', 'Expected a frequency-first AutoEq CSV header.');
    }
    rows = lines.slice(1);
  } else {
    rows = lines.filter((line) => /^[+-]?(?:\d|[.,]\d|nan\b|inf(?:inity)?\b)/i.test(line));
    if (rows.length === 0) {
      throw new MeasurementError('meas:format', 'No numeric REW rows found.');
    }
    separator = detectSeparator(rows[0]);
    const width = fields(rows[0], separator).length;
    if (width < 2 || width > 3) {
      throw new MeasurementError(
        'meas:format',
        'REW rows need frequency, SPL, and optional phase.',
      );
    }
    columns = width === 3 ? ['frequency', 'spl', 'phase'] : ['frequency', 'spl'];
  }
  const selected = column ?? (detected === 'autoeq-csv' ? 'raw' : 'spl');
  const columnIndex = columns.indexOf(selected.toLowerCase());
  if (columnIndex < 1) {
    throw new MeasurementError('meas:column', `Value column "${selected}" is unavailable.`);
  }
  /** @type {number[]} */
  const frequencies = [];
  /** @type {number[]} */
  const values = [];
  for (const [index, row] of rows.entries()) {
    const tokens = fields(row, separator);
    if (tokens.length !== columns.length) {
      throw new MeasurementError('meas:format', `Data row ${index + 1} has inconsistent columns.`);
    }
    const numbers = tokens.map((token, i) =>
      parseNumber(token, separator, `Row ${index + 1}, column ${columns[i]}`),
    );
    frequencies.push(numbers[0]);
    values.push(numbers[columnIndex]);
  }
  return { format: detected, ...orderedSeries(frequencies, values), columns };
}

/**
 * Linear interpolation in log-frequency, with flat endpoint extension.
 * Callers are responsible for checking coverage before using this helper.
 * @param {readonly number[]} frequencies
 * @param {readonly number[]} values
 * @param {number} frequency
 */
function interpolate(frequencies, values, frequency) {
  if (frequency <= frequencies[0]) return values[0];
  if (frequency >= frequencies[frequencies.length - 1]) return values[values.length - 1];
  let low = 0;
  let high = frequencies.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (frequencies[middle] <= frequency) low = middle;
    else high = middle;
  }
  const weight =
    Math.log(frequency / frequencies[low]) / Math.log(frequencies[high] / frequencies[low]);
  return values[low] + weight * (values[high] - values[low]);
}

/**
 * Resample onto the canonical grid (or a supplied positive, strictly increasing grid).
 * Missing endpoint coverage of at most 1% of the requested endpoint is extended flat;
 * this is stricter than 1/24 octave. Larger gaps are never extrapolated.
 * Source samples are sorted and equal duplicates merged without mutating the input.
 * @param {readonly number[]} frequencies
 * @param {readonly number[]} values
 * @param {{grid?: readonly number[]}} [options]
 * @returns {number[]}
 */
export function toGrid(frequencies, values, { grid = GRID } = {}) {
  const source = orderedSeries(frequencies, values);
  validateGrid(grid);
  const min = grid[0];
  const max = grid[grid.length - 1];
  const first = source.frequencies[0];
  const last = source.frequencies[source.frequencies.length - 1];
  const missing = [];
  if (first > min * 1.01) missing.push(`${min}–${first} Hz`);
  if (last < max * 0.99) missing.push(`${last}–${max} Hz`);
  if (missing.length > 0) {
    throw new MeasurementError(
      'meas:coverage',
      `Missing measurement coverage: ${missing.join(' and ')}.`,
    );
  }
  return grid.map((frequency) => interpolate(source.frequencies, source.values, frequency));
}

/**
 * Shift the response by its log-interpolated 1 kHz value (default), or by the arithmetic
 * mean of grid samples in the inclusive 300–3000 Hz band. No inputs are mutated.
 * @param {readonly number[]} values
 * @param {readonly number[]} grid
 * @param {{mode?: '1k' | 'mean-300-3k'}} [options]
 * @returns {number[]}
 */
export function normalize(values, grid, { mode = '1k' } = {}) {
  validateValues(values, grid);
  validateGrid(grid);
  let reference;
  if (mode === '1k') {
    if (grid[0] > 1000 || grid[grid.length - 1] < 1000) {
      throw new MeasurementError('meas:coverage', 'Normalization needs coverage at 1000 Hz.');
    }
    reference = interpolate(grid, values, 1000);
  } else if (mode === 'mean-300-3k') {
    if (grid[0] > 300 || grid[grid.length - 1] < 3000) {
      throw new MeasurementError('meas:coverage', 'Normalization needs coverage from 300–3000 Hz.');
    }
    const band = values.filter((_, index) => grid[index] >= 300 && grid[index] <= 3000);
    if (band.length === 0) {
      throw new MeasurementError('meas:coverage', 'No grid samples in the 300–3000 Hz band.');
    }
    reference = band.reduce((sum, value) => sum + value, 0) / band.length;
  } else {
    throw new MeasurementError('meas:format', `Unsupported normalization mode: ${mode}.`);
  }
  return values.map((value) => value - reference);
}

/**
 * Boxcar smoothing over a symmetric log-frequency window of total width 1/fraction octave.
 * Average the available grid samples only: at edges the window is clipped and its sample
 * count renormalized, with no zero padding or endpoint replication. This preserves constants
 * exactly, including at edges. On nonuniform grids this is a sample mean, not an integral.
 * @param {readonly number[]} values
 * @param {readonly number[]} grid
 * @param {3 | 6 | 12} fraction
 * @returns {number[]}
 */
export function smooth(values, grid, fraction) {
  validateValues(values, grid);
  validateGrid(grid);
  if (![3, 6, 12].includes(fraction)) {
    throw new MeasurementError('meas:format', 'Smoothing fraction must be 3, 6, or 12.');
  }
  const logs = grid.map((frequency) => Math.log2(frequency));
  const halfWidth = 1 / (2 * fraction);
  return values.map((value, index) => {
    let delta = 0;
    let count = 0;
    for (let i = 0; i < logs.length; i++) {
      if (Math.abs(logs[i] - logs[index]) <= halfWidth + 1e-12) {
        delta += values[i] - value;
        count++;
      }
    }
    return value + delta / count;
  });
}
