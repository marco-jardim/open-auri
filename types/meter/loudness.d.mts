/**
 * K-weighting coefficients derived from the analog prototypes (libebur128 `ebur128_init_filter`).
 * @param {number} sampleRate
 * @returns {KWeighting}
 */
export function deriveKWeighting(sampleRate: number): KWeighting;
/**
 * K-weighting used at a sample rate: the published table at 48 kHz, the derivation elsewhere.
 * @param {number} sampleRate
 * @returns {Readonly<KWeighting>}
 */
export function kWeighting(sampleRate: number): Readonly<KWeighting>;
/**
 * @typedef {object} LoudnessReading
 * @property {number} momentary Momentary loudness (400 ms), LUFS, floor FLOOR_DB (−120).
 * @property {number} shortTerm Short-term loudness (3 s), LUFS, floor FLOOR_DB (−120).
 * @property {boolean} momentaryReady True once 400 ms of signal have been processed.
 * @property {boolean} shortTermReady True once 3 s of signal have been processed.
 */
/**
 * @typedef {object} LoudnessState
 * @property {'loudness'} kind
 * @property {number} sampleRate
 * @property {number[]} filters
 * @property {number[]} ring
 * @property {number[]} scalars
 */
/**
 * @typedef {object} LoudnessMeter
 * @property {(left: Samples, right?: Samples) => void} process Processes one block (any length);
 *   without `right` the input is mono (one channel).
 * @property {() => LoudnessReading} read
 * @property {() => void} reset
 * @property {() => LoudnessState} getState
 * @property {(state: unknown) => void} setState
 * @property {number} hopLength Samples per hop.
 * @property {readonly Float64Array[]} buffers Preallocated internal buffers (identity never changes).
 */
/**
 * Creates a momentary / short-term loudness meter.
 * @param {{ sampleRate: number }} options
 * @returns {LoudnessMeter}
 */
export function createLoudnessMeter(options: {
    sampleRate: number;
}): LoudnessMeter;
/** @import { Samples } from './common.mjs' */
/**
 * @typedef {object} Biquad
 * @property {readonly number[]} b Numerator [b0, b1, b2].
 * @property {readonly number[]} a Denominator [1, a1, a2].
 */
/**
 * @typedef {object} KWeighting
 * @property {Readonly<Biquad>} shelf Stage 1 (high shelf).
 * @property {Readonly<Biquad>} rlb Stage 2 (RLB high-pass).
 */
/**
 * K-weighting coefficients at 48 kHz, ITU-R BS.1770-5 Annex 1, Tables 1 and 2.
 * @type {Readonly<KWeighting>}
 */
export const K_WEIGHTING_48K: Readonly<KWeighting>;
/** Shelf centre frequency, Hz (libebur128 `ebur128_init_filter`). */
export const SHELF_F0: 1681.974450955533;
/** Shelf gain, dB (libebur128 `ebur128_init_filter`). */
export const SHELF_GAIN_DB: 3.999843853973347;
/** Shelf quality factor (libebur128 `ebur128_init_filter`). */
export const SHELF_Q: 0.7071752369554196;
/** Exponent giving the shelf mid-band gain Vb = Vh^x (libebur128 `ebur128_init_filter`). */
export const SHELF_VB_EXPONENT: 0.4996667741545416;
/** RLB high-pass corner frequency, Hz (libebur128 `ebur128_init_filter`). */
export const RLB_F0: 38.13547087602444;
/** RLB high-pass quality factor (libebur128 `ebur128_init_filter`). */
export const RLB_Q: 0.5003270373238773;
/** Offset of the loudness formula, in dB (ITU-R BS.1770-5 Annex 1, eq. 2). */
export const LOUDNESS_OFFSET_DB: -0.691;
/** Hop length used for the sliding windows, in seconds (see the module notes). */
export const HOP_SECONDS: 0.01;
/** Hops in the 400 ms momentary window (EBU Tech 3341 §2.2). */
export const MOMENTARY_HOPS: 40;
/** Hops in the 3 s short-term window (EBU Tech 3341 §2.2). */
export const SHORT_TERM_HOPS: 300;
export type LoudnessReading = {
    /**
     * Momentary loudness (400 ms), LUFS, floor FLOOR_DB (−120).
     */
    momentary: number;
    /**
     * Short-term loudness (3 s), LUFS, floor FLOOR_DB (−120).
     */
    shortTerm: number;
    /**
     * True once 400 ms of signal have been processed.
     */
    momentaryReady: boolean;
    /**
     * True once 3 s of signal have been processed.
     */
    shortTermReady: boolean;
};
export type LoudnessState = {
    kind: "loudness";
    sampleRate: number;
    filters: number[];
    ring: number[];
    scalars: number[];
};
export type LoudnessMeter = {
    /**
     * Processes one block (any length);
     * without `right` the input is mono (one channel).
     */
    process: (left: Samples, right?: Samples) => void;
    read: () => LoudnessReading;
    reset: () => void;
    getState: () => LoudnessState;
    setState: (state: unknown) => void;
    /**
     * Samples per hop.
     */
    hopLength: number;
    /**
     * Preallocated internal buffers (identity never changes).
     */
    buffers: readonly Float64Array[];
};
export type Biquad = {
    /**
     * Numerator [b0, b1, b2].
     */
    b: readonly number[];
    /**
     * Denominator [1, a1, a2].
     */
    a: readonly number[];
};
export type KWeighting = {
    /**
     * Stage 1 (high shelf).
     */
    shelf: Readonly<Biquad>;
    /**
     * Stage 2 (RLB high-pass).
     */
    rlb: Readonly<Biquad>;
};
import type { Samples } from './common.mjs';
