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
export function createCorrelationMeter(options: {
    sampleRate: number;
    timeConstant?: number;
}): CorrelationMeter;
/** @import { Samples } from './common.mjs' */
/** Default averaging time constant, in seconds (see the module notes). */
export const CORRELATION_DEFAULT_TIME_CONSTANT: 0.3;
/** Mean-square level at or below which a channel counts as silent (10^(−120/10)). */
export const CORRELATION_ENERGY_FLOOR: 1e-12;
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
    kind: "correlation";
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
import type { Samples } from './common.mjs';
