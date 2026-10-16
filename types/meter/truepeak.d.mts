/**
 * True-peak meter (ITU-R BS.1770 Annex 2) as an allocation-free block processor.
 *
 * Sources and deviations
 * - ITU-R BS.1770-5 Annex 2 (https://www.itu.int/rec/R-REC-BS.1770/en): 4× oversampling with a
 *   48-tap, 4-phase polyphase FIR (12 taps per phase), true peak = max |y| in dBTP. The phase
 *   arrays {@link TRUE_PEAK_PHASES} were reconstructed from a text extraction of the Recommendation;
 *   the interleaved 48-tap filter h[4j + k] = P_k[j] is checked for the symmetry h[n] = h[47 − n]
 *   and validated against EBU Tech 3341 test 15 (https://tech.ebu.ch/docs/tech/tech3341.pdf) in
 *   test/meter/truepeak.test.mjs.
 * - Oversampling factor: the smallest of 1, 2 or 4 that reaches ≥ 176.4 kHz (the effective rate
 *   the Annex reaches at 44.1 kHz): 4× below 88.2 kHz, 2× at 88.2–176.4 kHz, none from 176.4 kHz
 *   (so none at 192 kHz). 2× uses phases 0 and 2 of the same filter, i.e. the 4× output decimated
 *   by 2: they sit at evenly spaced fractional positions 0.125 and 0.625 of an input period.
 * - Deviation: no phase of this filter reproduces the input samples (all phases are fractional
 *   delays), so the input sample magnitudes are included in the maximum as well. The reading is
 *   therefore never below the sample peak.
 * - The Annex's optional −12.04 dB input attenuation is not applied (floating point has headroom).
 * - Silence reads FLOOR_DB (−120 dBTP); −Infinity and NaN are never returned.
 * @module
 */
import type { Samples } from './common.mjs';
/** @import { Samples } from './common.mjs' */
/** Taps per polyphase branch (ITU-R BS.1770-5 Annex 2). */
export declare const TRUE_PEAK_TAPS_PER_PHASE = 12;
/**
 * Polyphase branches P0..P3 of the BS.1770-5 Annex 2 interpolation filter (12 taps each).
 * @type {readonly (readonly number[])[]}
 */
export declare const TRUE_PEAK_PHASES: readonly (readonly number[])[];
/**
 * Oversampling factor used at a sample rate (see the module notes).
 * @param {number} sampleRate
 * @returns {1 | 2 | 4}
 */
export declare function oversamplingFactor(sampleRate: number): 1 | 2 | 4;
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
    kind: 'truePeak';
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
export declare function createTruePeakMeter(options: {
    sampleRate: number;
}): TruePeakMeter;
