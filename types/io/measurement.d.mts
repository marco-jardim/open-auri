export type MeasurementErrorCode = 'meas:empty' | 'meas:format' | 'meas:number' | 'meas:nonfinite' | * 'meas:order' | 'meas:duplicate' | 'meas:coverage' | 'meas:column';
export type MeasurementFormat = 'autoeq-csv' | 'rew-txt';
export type Series = {
    frequencies: number[];
    values: number[];
};
export type Measurement = Series & {
    format: MeasurementFormat;
    columns: string[];
};
/**
 * @typedef {'meas:empty' | 'meas:format' | 'meas:number' | 'meas:nonfinite' |
 * 'meas:order' | 'meas:duplicate' | 'meas:coverage' | 'meas:column'} MeasurementErrorCode
 * @typedef {'autoeq-csv' | 'rew-txt'} MeasurementFormat
 * @typedef {{frequencies: number[], values: number[]}} Series
 * @typedef {Series & {format: MeasurementFormat, columns: string[]}} Measurement
 */
/** A measurement import/processing failure with a stable, machine-readable code. */
export declare class MeasurementError extends Error {
    code: MeasurementErrorCode;
    /**
     * @param {MeasurementErrorCode} code
     * @param {string} message
     */
    constructor(code: MeasurementErrorCode, message: string);
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
export declare function parseMeasurement(text: string, { format, column }?: {
    format?: 'auto' | MeasurementFormat;
    column?: string;
}): Measurement;
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
export declare function toGrid(frequencies: readonly number[], values: readonly number[], { grid }?: {
    grid?: readonly number[];
}): number[];
/**
 * Shift the response by its log-interpolated 1 kHz value (default), or by the arithmetic
 * mean of grid samples in the inclusive 300–3000 Hz band. No inputs are mutated.
 * @param {readonly number[]} values
 * @param {readonly number[]} grid
 * @param {{mode?: '1k' | 'mean-300-3k'}} [options]
 * @returns {number[]}
 */
export declare function normalize(values: readonly number[], grid: readonly number[], { mode }?: {
    mode?: '1k' | 'mean-300-3k';
}): number[];
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
export declare function smooth(values: readonly number[], grid: readonly number[], fraction: 3 | 6 | 12): number[];
