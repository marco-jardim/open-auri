/**
 * Oversampling factor used at a sample rate (see the module notes).
 * @param {number} sampleRate
 * @returns {1 | 2 | 4}
 */
export function oversamplingFactor(sampleRate: number): 1 | 2 | 4;
/**
 * @typedef {object} TruePeakReading
 * @property {number} left Maximum left true peak since the last reset, in dBTP.
 * @property {number} right Maximum right true peak since the last reset, in dBTP.
 * @property {number} max Maximum of both channels since the last reset, in dBTP.
 * @property {number} blockLeft Left true peak of the most recent block, in dBTP.
 * @property {number} blockRight Right true peak of the most recent block, in dBTP.
 */
/**
 * @typedef {object} TruePeakState
 * @property {'truePeak'} kind
 * @property {number} sampleRate
 * @property {number[]} history
 * @property {number} position
 * @property {number[]} peaks
 */
/**
 * @typedef {object} TruePeakMeter
 * @property {(left: Samples, right?: Samples) => void} process Processes one block (any length);
 *   without `right` the left samples feed both channels.
 * @property {() => TruePeakReading} read
 * @property {() => void} reset
 * @property {() => TruePeakState} getState
 * @property {(state: unknown) => void} setState
 * @property {number} factor Oversampling factor in use (1, 2 or 4).
 * @property {readonly (Float64Array | Int32Array)[]} buffers Preallocated internal buffers.
 */
/**
 * Creates a stereo true-peak meter.
 * @param {{ sampleRate: number }} options
 * @returns {TruePeakMeter}
 */
export function createTruePeakMeter(options: {
    sampleRate: number;
}): TruePeakMeter;
/** @import { Samples } from './common.mjs' */
/** Taps per polyphase branch (ITU-R BS.1770-5 Annex 2). */
export const TRUE_PEAK_TAPS_PER_PHASE: 12;
/**
 * Polyphase branches P0..P3 of the BS.1770-5 Annex 2 interpolation filter (12 taps each).
 * @type {readonly (readonly number[])[]}
 */
export const TRUE_PEAK_PHASES: readonly (readonly number[])[];
export type TruePeakReading = {
    /**
     * Maximum left true peak since the last reset, in dBTP.
     */
    left: number;
    /**
     * Maximum right true peak since the last reset, in dBTP.
     */
    right: number;
    /**
     * Maximum of both channels since the last reset, in dBTP.
     */
    max: number;
    /**
     * Left true peak of the most recent block, in dBTP.
     */
    blockLeft: number;
    /**
     * Right true peak of the most recent block, in dBTP.
     */
    blockRight: number;
};
export type TruePeakState = {
    kind: "truePeak";
    sampleRate: number;
    history: number[];
    position: number;
    peaks: number[];
};
export type TruePeakMeter = {
    /**
     * Processes one block (any length);
     * without `right` the left samples feed both channels.
     */
    process: (left: Samples, right?: Samples) => void;
    read: () => TruePeakReading;
    reset: () => void;
    getState: () => TruePeakState;
    setState: (state: unknown) => void;
    /**
     * Oversampling factor in use (1, 2 or 4).
     */
    factor: number;
    /**
     * Preallocated internal buffers.
     */
    buffers: readonly (Float64Array | Int32Array)[];
};
import type { Samples } from './common.mjs';
