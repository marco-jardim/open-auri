/**
 * VU and PPM (peak programme meter) ballistics as allocation-free block processors.
 *
 * Sources and deviations
 * - IEC 60268-17 (VU) and IEC 60268-10 (PPM) are paywalled and were not consulted; the secondary
 *   sources below were used instead.
 * - VU dynamics: ITU-R BS.2054-4 §2, "99 % of final reading in 300 ms"; Wikipedia "VU meter",
 *   overshoot 1–1.5 % and a fall time of about 300 ms as well
 *   (https://en.wikipedia.org/wiki/VU_meter). Modelled as a linear
 *   2nd-order low-pass on the full-wave rectified signal (ζ = 0.81, ωn = 13.422 rad/s, derivation
 *   at {@link VU_OMEGA_N}), discretised with the bilinear transform pre-warped at ωn. Being linear,
 *   the fall mirrors the rise (1 % residue after 300 ms); the needle may swing slightly below the
 *   rest position after a sudden stop, which the dB reading clamps to FLOOR_DB (−120).
 * - VU alignment: 0 VU = −18 dBFS (EBU R68, default), −20 dBFS (SMPTE RP155) or −14 dBFS (product
 *   option: no standard source found). dBFS is the sine peak level (a full-scale sine is 0 dBFS).
 *   The needle follows the average-rectified value (it is a full-wave rectifier instrument), so the
 *   0 VU point is the average-rectified value of the reference sine, (2/π)·10^(ref/20). For a sine,
 *   RMS and average-rectified calibration differ only by this constant.
 * - PPM Type II (BBC/EBU): EBU Tech 3205 Table 2 (https://tech.ebu.ch/docs/tech/tech3205.pdf):
 *   tone-burst readings relative to a continuous tone 100 ms 0 dB, 10 ms −2 ± 0.5 dB,
 *   5 ms −4 ± 0.75 dB, 1.5 ms −9 ± 1 dB, 0.5 ms −17 ± 2 dB; return 24 dB in 2.8 s.
 * - PPM Type I (DIN): Wikipedia "Peak programme meter"
 *   (https://en.wikipedia.org/wiki/Peak_programme_meter): 10 ms −1 dB, 5 ms −2 dB, 3 ms −4 dB,
 *   0.4 ms −15 dB relative to a continuous tone; return 20 dB in 1.7 s. That source gives no
 *   tolerances (deviation: the tests use ±0.5 dB at 10 ms, ±0.75 dB at 5 ms, ±1 dB at 3 ms and
 *   ±2 dB at 0.4 ms).
 * - PPM model: quasi-peak rectifiers (charge through an attack time constant whenever |x| exceeds
 *   the held value, exponential discharge that is linear in dB). Type I uses one rectifier. For
 *   Type II a single rectifier cannot meet both the 1.5 ms and the 10 ms points with margin once the
 *   continuous-tone droop is accounted for, so the reading is the mean of a fast and a slow
 *   rectifier with the same discharge (decay stays exactly linear in dB). Attack constants were
 *   tuned to the burst tables with the averaged rectifier equation dv/dt = (2/π)·h(v)/τ − k·v,
 *   h(v) = √(1−v²) − v·acos v (see {@link quasiPeakEquilibrium}).
 * - Deviation: readings are calibrated so a steady sine reads its peak level in dBFS; the raw
 *   rectifier settles slightly below the crest (0.19–0.24 dB) because the discharge never stops.
 *   Burst readings relative to the continuous tone are unaffected.
 * @module
 */
import type { Samples } from './common.mjs';
/** @import { Samples } from './common.mjs' */
/**
 * VU damping ratio. Wikipedia "VU meter" gives 1–1.5 % overshoot; the overshoot of a 2nd-order
 * step response is exp(−πζ/√(1−ζ²)), which is 1.5 % at ζ = 0.8008 and 1.0 % at ζ = 0.8261.
 * ζ = 0.81 gives 1.30 %.
 */
export declare const VU_ZETA = 0.81;
/**
 * VU natural angular frequency, in rad/s. ITU-R BS.2054-4 §2: 99 % of the final reading in 300 ms.
 * The underdamped step response y(t) = 1 − e^(−ζωn t)/√(1−ζ²)·sin(ωd t + acos ζ) first reaches 0.99
 * at ωn·t = 4.02665 for ζ = 0.81 (solved by iteration on the closed form; the test re-solves it on a
 * 10 µs grid), so ωn = 4.02665 / 0.300 s = 13.422 rad/s. (ωn = 13.7–14 rad/s would reach 99 % at
 * 288–294 ms, also inside ±10 %.)
 */
export declare const VU_OMEGA_N = 13.422;
/** Selectable 0 VU alignment levels in dBFS: EBU R68, SMPTE RP155, product option (no source). */
export declare const VU_REFERENCE_LEVELS: readonly number[];
/** Default 0 VU alignment, in dBFS (EBU R68). */
export declare const VU_DEFAULT_REFERENCE = -18;
/**
 * Analytic VU step response (continuous time), as a fraction of the final deflection.
 * @param {number} seconds
 * @param {number} [zeta]
 * @param {number} [omegaN]
 * @returns {number}
 */
export declare function vuStepResponse(seconds: number, zeta?: number, omegaN?: number): number;
export type VuReading = {
    /**
     * Left reading in VU (dB re the alignment level), floor FLOOR_DB (−120).
     */
    left: number;
    /**
     * Right reading in VU, floor FLOOR_DB (−120).
     */
    right: number;
    /**
     * Left needle deflection, 1 = 0 VU (may dip below 0 after a stop).
     */
    leftDeflection: number;
    /**
     * Right needle deflection, 1 = 0 VU.
     */
    rightDeflection: number;
};
export type VuState = {
    kind: 'vu';
    sampleRate: number;
    reference: number;
    filter: number[];
};
export type VuMeter = {
    /**
     * Processes one block (any length);
     * without `right` the left samples feed both needles.
     */
    process: (left: Samples, right?: Samples) => void;
    read: () => VuReading;
    reset: () => void;
    getState: () => VuState;
    setState: (state: unknown) => void;
    /**
     * Preallocated internal buffers (identity never changes).
     */
    buffers: readonly Float64Array[];
};
/**
 * @typedef {object} VuReading
 * @property {number} left Left reading in VU (dB re the alignment level), floor FLOOR_DB (−120).
 * @property {number} right Right reading in VU, floor FLOOR_DB (−120).
 * @property {number} leftDeflection Left needle deflection, 1 = 0 VU (may dip below 0 after a stop).
 * @property {number} rightDeflection Right needle deflection, 1 = 0 VU.
 */
/**
 * @typedef {object} VuState
 * @property {'vu'} kind
 * @property {number} sampleRate
 * @property {number} reference
 * @property {number[]} filter
 */
/**
 * @typedef {object} VuMeter
 * @property {(left: Samples, right?: Samples) => void} process Processes one block (any length);
 *   without `right` the left samples feed both needles.
 * @property {() => VuReading} read
 * @property {() => void} reset
 * @property {() => VuState} getState
 * @property {(state: unknown) => void} setState
 * @property {readonly Float64Array[]} buffers Preallocated internal buffers (identity never changes).
 */
/**
 * Creates a stereo VU meter.
 * @param {{ sampleRate: number, reference?: number }} options
 * @returns {VuMeter}
 */
export declare function createVuMeter(options: {
    sampleRate: number;
    reference?: number;
}): VuMeter;
export type PpmType = {
    /**
     * Attack time constant of the fast rectifier, in seconds.
     */
    fastAttack: number;
    /**
     * Attack time constant of the slow rectifier, in seconds.
     */
    slowAttack: number;
    /**
     * Weight of the fast rectifier in the reading (slow gets 1 − weight).
     */
    fastWeight: number;
    /**
     * Return rate, in dB/s (linear in dB).
     */
    decayDbPerSecond: number;
};
/**
 * @typedef {object} PpmType
 * @property {number} fastAttack Attack time constant of the fast rectifier, in seconds.
 * @property {number} slowAttack Attack time constant of the slow rectifier, in seconds.
 * @property {number} fastWeight Weight of the fast rectifier in the reading (slow gets 1 − weight).
 * @property {number} decayDbPerSecond Return rate, in dB/s (linear in dB).
 */
/**
 * PPM ballistics per type.
 * - `I` (DIN): one rectifier, τ = 1.42 ms (tuned to the Wikipedia Type I burst table; predicted
 *   readings at 48 kHz ≈ −0.8, −2.1, −3.8 and −15.9 dB for 10, 5, 3 and 0.4 ms), return
 *   20 dB / 1.7 s (Wikipedia "Peak programme meter").
 * - `II` (BBC/EBU): mean of rectifiers with τ = 1.1 ms and τ = 5.0 ms (tuned to EBU Tech 3205
 *   Table 2; predicted ≈ −2.0, −3.9, −9.2 and −16.4 dB for 10, 5, 1.5 and 0.5 ms), return
 *   24 dB / 2.8 s (EBU Tech 3205).
 * @type {Readonly<Record<'I' | 'II', Readonly<PpmType>>>}
 */
export declare const PPM_TYPES: Readonly<Record<'I' | 'II', Readonly<PpmType>>>;
/**
 * Steady-state level, as a fraction of the crest, of a continuous-time quasi-peak rectifier driven
 * by a sine. Averaged over a half cycle the rectifier obeys dv/dt = (2/π)·h(v)/τ − k·v with
 * h(v) = √(1−v²) − v·acos v and k = decay·ln(10)/20, so equilibrium solves h(v) = (π/2)·k·τ·v.
 * @param {number} attackSeconds
 * @param {number} decayDbPerSecond
 * @returns {number}
 */
export declare function quasiPeakEquilibrium(attackSeconds: number, decayDbPerSecond: number): number;
export type PpmReading = {
    /**
     * Left reading in dBFS (sine peak), floor FLOOR_DB (−120).
     */
    left: number;
    /**
     * Right reading in dBFS (sine peak), floor FLOOR_DB (−120).
     */
    right: number;
};
export type PpmState = {
    kind: 'ppm';
    sampleRate: number;
    type: 'I' | 'II';
    rectifiers: number[];
};
export type PpmMeter = {
    /**
     * Processes one block (any length);
     * without `right` the left samples feed both channels.
     */
    process: (left: Samples, right?: Samples) => void;
    read: () => PpmReading;
    reset: () => void;
    getState: () => PpmState;
    setState: (state: unknown) => void;
    /**
     * Preallocated internal buffers (identity never changes).
     */
    buffers: readonly Float64Array[];
};
/**
 * @typedef {object} PpmReading
 * @property {number} left Left reading in dBFS (sine peak), floor FLOOR_DB (−120).
 * @property {number} right Right reading in dBFS (sine peak), floor FLOOR_DB (−120).
 */
/**
 * @typedef {object} PpmState
 * @property {'ppm'} kind
 * @property {number} sampleRate
 * @property {'I' | 'II'} type
 * @property {number[]} rectifiers
 */
/**
 * @typedef {object} PpmMeter
 * @property {(left: Samples, right?: Samples) => void} process Processes one block (any length);
 *   without `right` the left samples feed both channels.
 * @property {() => PpmReading} read
 * @property {() => void} reset
 * @property {() => PpmState} getState
 * @property {(state: unknown) => void} setState
 * @property {readonly Float64Array[]} buffers Preallocated internal buffers (identity never changes).
 */
/**
 * Creates a stereo PPM.
 * @param {{ sampleRate: number, type?: 'I' | 'II' }} options
 * @returns {PpmMeter}
 */
export declare function createPpmMeter(options: {
    sampleRate: number;
    type?: 'I' | 'II';
}): PpmMeter;
