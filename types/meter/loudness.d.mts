/**
 * Momentary and short-term loudness (ITU-R BS.1770-5) as an allocation-free block processor.
 *
 * Sources and deviations
 * - ITU-R BS.1770-5 Annex 1 (https://www.itu.int/rec/R-REC-BS.1770/en; identical to -4 for these
 *   coefficients): K-weighting = high-shelf (stage 1) then RLB high-pass (stage 2); loudness
 *   L = −0.691 + 10·log10(Σ G_i·z_i) with G_L = G_R = 1.0. At 48 kHz the published coefficients
 *   {@link K_WEIGHTING_48K} are used verbatim.
 * - Other sample rates: coefficients derived from the analog prototypes of libebur128
 *   (https://github.com/jiixyj/libebur128, MIT, `ebur128_init_filter`), see
 *   {@link deriveKWeighting}. At 48 kHz the derivation matches the table within 1e-6
 *   (test/meter/loudness.test.mjs reports the actual error).
 * - Windows (EBU Tech 3341, https://tech.ebu.ch/docs/tech/tech3341.pdf): momentary = 400 ms,
 *   short-term = 3 s, both rectangular. Exact windowing: the K-weighted energy Σ G_i·y_i² is summed
 *   over hops of round(fs/100) samples (10 ms; exact at 44.1, 48, 88.2, 96 and 192 kHz) into a ring
 *   of 300 hop sums. At the end of every hop the momentary value is the mean over the last 40 hops
 *   and the short-term value the mean over all 300 hops (both re-summed from the ring, so there is
 *   no drift). Readings therefore refresh every 10 ms and cover exactly the most recent 400 ms / 3 s
 *   ending at the last hop boundary. Like libebur128, the history before the first sample counts as
 *   silence; `momentaryReady` / `shortTermReady` tell when the windows hold real signal only.
 * - Mono: when `right` is omitted only the left channel contributes (BS.1770 sums the channels
 *   present), so a 0 dBFS 1 kHz sine reads −3.01 LKFS either as mono or on one stereo channel.
 * - Silence reads FLOOR_DB (−120 LUFS); −Infinity and NaN are never returned.
 * @module
 */
import type { Samples } from './common.mjs';
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
export declare const K_WEIGHTING_48K: Readonly<KWeighting>;
/** Shelf centre frequency, Hz (libebur128 `ebur128_init_filter`). */
export declare const SHELF_F0 = 1681.974450955533;
/** Shelf gain, dB (libebur128 `ebur128_init_filter`). */
export declare const SHELF_GAIN_DB = 3.999843853973347;
/** Shelf quality factor (libebur128 `ebur128_init_filter`). */
export declare const SHELF_Q = 0.7071752369554196;
/** Exponent giving the shelf mid-band gain Vb = Vh^x (libebur128 `ebur128_init_filter`). */
export declare const SHELF_VB_EXPONENT = 0.4996667741545416;
/** RLB high-pass corner frequency, Hz (libebur128 `ebur128_init_filter`). */
export declare const RLB_F0 = 38.13547087602444;
/** RLB high-pass quality factor (libebur128 `ebur128_init_filter`). */
export declare const RLB_Q = 0.5003270373238773;
/** Offset of the loudness formula, in dB (ITU-R BS.1770-5 Annex 1, eq. 2). */
export declare const LOUDNESS_OFFSET_DB = -0.691;
/** Hop length used for the sliding windows, in seconds (see the module notes). */
export declare const HOP_SECONDS = 0.01;
/** Hops in the 400 ms momentary window (EBU Tech 3341 §2.2). */
export declare const MOMENTARY_HOPS = 40;
/** Hops in the 3 s short-term window (EBU Tech 3341 §2.2). */
export declare const SHORT_TERM_HOPS = 300;
/**
 * K-weighting coefficients derived from the analog prototypes (libebur128 `ebur128_init_filter`).
 * @param {number} sampleRate
 * @returns {KWeighting}
 */
export declare function deriveKWeighting(sampleRate: number): KWeighting;
/**
 * K-weighting used at a sample rate: the published table at 48 kHz, the derivation elsewhere.
 * @param {number} sampleRate
 * @returns {Readonly<KWeighting>}
 */
export declare function kWeighting(sampleRate: number): Readonly<KWeighting>;
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
    kind: 'loudness';
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
export declare function createLoudnessMeter(options: {
    sampleRate: number;
}): LoudnessMeter;
