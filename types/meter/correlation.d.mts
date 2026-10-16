/**
 * Stereo correlation (phase) meter as an allocation-free block processor.
 *
 * Sources and deviations
 * - Definition: normalised cross-correlation at lag 0, r = E{L·R} / √(E{L²}·E{R²}), the quantity
 *   shown by correlation meters (Pearson correlation of zero-mean audio signals); r = +1 for mono,
 *   −1 for polarity-inverted channels, ≈ 0 for unrelated signals.
 * - Averaging: each expectation is a one-pole (exponential) averager y += α·(x − y) with
 *   α = 1 − e^(−1/(τ·fs)). τ = 300 ms by default ({@link CORRELATION_DEFAULT_TIME_CONSTANT}); meters
 *   in practice use 300–600 ms and Sound On Sound cites about 600 ms (secondary source named in the
 *   task brief; no article URL was verified), so τ is an option. 300 ms follows the faster end of
 *   practice, matching the VU integration time (ballistics.mjs).
 * - No signal: when either channel's mean square is at or below {@link CORRELATION_ENERGY_FLOOR}
 *   (−120 dBFS mean square) the reading is 0 and `active` is false. The result is clamped to
 *   [−1, 1] against rounding; NaN is never returned for finite input.
 * - Without `right` the input is mono and reads +1.
 * @module
 */
import type { Samples } from './common.mjs';
/** @import { Samples } from './common.mjs' */
/** Default averaging time constant, in seconds (see the module notes). */
export declare const CORRELATION_DEFAULT_TIME_CONSTANT = 0.3;
/** Mean-square level at or below which a channel counts as silent (10^(−120/10)). */
export declare const CORRELATION_ENERGY_FLOOR = 1e-12;
export type CorrelationReading = {
    /**
     * Correlation in [−1, 1]; 0 when `active` is false.
     */
    correlation: number;
    /**
     * False when either channel is below the energy floor.
     */
    active: boolean;
};
export type CorrelationState = {
    kind: 'correlation';
    sampleRate: number;
    timeConstant: number;
    averages: number[];
};
export type CorrelationMeter = {
    /**
     * Processes one block (any length).
     */
    process: (left: Samples, right?: Samples) => void;
    read: () => CorrelationReading;
    reset: () => void;
    getState: () => CorrelationState;
    setState: (state: unknown) => void;
    /**
     * Preallocated internal buffers (identity never changes).
     */
    buffers: readonly Float64Array[];
};
/**
 * @typedef {object} CorrelationReading
 * @property {number} correlation Correlation in [−1, 1]; 0 when `active` is false.
 * @property {boolean} active False when either channel is below the energy floor.
 */
/**
 * @typedef {object} CorrelationState
 * @property {'correlation'} kind
 * @property {number} sampleRate
 * @property {number} timeConstant
 * @property {number[]} averages
 */
/**
 * @typedef {object} CorrelationMeter
 * @property {(left: Samples, right?: Samples) => void} process Processes one block (any length).
 * @property {() => CorrelationReading} read
 * @property {() => void} reset
 * @property {() => CorrelationState} getState
 * @property {(state: unknown) => void} setState
 * @property {readonly Float64Array[]} buffers Preallocated internal buffers (identity never changes).
 */
/**
 * Creates a stereo correlation meter.
 * @param {{ sampleRate: number, timeConstant?: number }} options
 * @returns {CorrelationMeter}
 */
export declare function createCorrelationMeter(options: {
    sampleRate: number;
    timeConstant?: number;
}): CorrelationMeter;
