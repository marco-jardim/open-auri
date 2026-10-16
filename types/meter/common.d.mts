/**
 * Shared constants and helpers for the metering block processors in `src/meter/`.
 *
 * Every meter returns readings in dB clamped to {@link FLOOR_DB}, so silence gives a finite floor:
 * `-Infinity` and `NaN` are never returned (as long as the input samples are finite).
 * @module
 */
/** Lowest reading returned by every meter, in dB (dBFS, VU, dBTP or LUFS). */
export declare const FLOOR_DB = -120;
/** Linear amplitude matching {@link FLOOR_DB} (10^(−120/20)). */
export declare const FLOOR_AMPLITUDE = 0.000001;
/** Lowest accepted sample rate, in Hz. */
export declare const MIN_SAMPLE_RATE = 22050;
/** Highest accepted sample rate, in Hz (bounds the loudness ring buffers). */
export declare const MAX_SAMPLE_RATE = 768000;
/** Filter states below this magnitude are flushed to zero at block end (avoids subnormals). */
export declare const DENORMAL_FLUSH = 1e-30;
export type Samples = Float32Array | Float64Array;
/** @typedef {Float32Array | Float64Array} Samples */
/**
 * Validates a sample rate.
 * @param {unknown} sampleRate
 * @returns {number}
 */
export declare function checkSampleRate(sampleRate: unknown): number;
/**
 * Number of frames in a block; `right`, when given, must be at least as long as `left`.
 * @param {Samples} left
 * @param {Samples | undefined} right
 * @returns {number}
 */
export declare function blockLength(left: Samples, right: Samples | undefined): number;
/**
 * Linear amplitude to dB, clamped to {@link FLOOR_DB} (also for zero, negative or NaN input).
 * @param {number} amplitude
 * @returns {number}
 */
export declare function amplitudeToDb(amplitude: number): number;
/**
 * Zero when the magnitude is below {@link DENORMAL_FLUSH}.
 * @param {number} value
 * @returns {number}
 */
export declare function flush(value: number): number;
/**
 * Validates the envelope of a serialized meter state.
 * @param {unknown} state
 * @param {string} kind
 * @param {number} sampleRate
 * @returns {Record<string, unknown>}
 */
export declare function checkState(state: unknown, kind: string, sampleRate: number): Record<string, unknown>;
/**
 * Validates a serialized array of finite numbers with an exact length.
 * @param {unknown} value
 * @param {number} length
 * @param {string} name
 * @returns {number[]}
 */
export declare function readArray(value: unknown, length: number, name: string): number[];
/**
 * Validates a serialized integer in `[min, max]`.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {string} name
 * @returns {number}
 */
export declare function readInteger(value: unknown, min: number, max: number, name: string): number;
