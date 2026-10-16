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

import {
  FLOOR_DB,
  blockLength,
  checkSampleRate,
  checkState,
  flush,
  readArray,
  readInteger,
} from './common.mjs';

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
export const K_WEIGHTING_48K = Object.freeze({
  shelf: Object.freeze({
    b: Object.freeze([1.53512485958697, -2.69169618940638, 1.19839281085285]),
    a: Object.freeze([1, -1.69065929318241, 0.73248077421585]),
  }),
  rlb: Object.freeze({
    b: Object.freeze([1, -2, 1]),
    a: Object.freeze([1, -1.99004745483398, 0.99007225036621]),
  }),
});

/** Shelf centre frequency, Hz (libebur128 `ebur128_init_filter`). */
export const SHELF_F0 = 1681.974450955533;
/** Shelf gain, dB (libebur128 `ebur128_init_filter`). */
export const SHELF_GAIN_DB = 3.999843853973347;
/** Shelf quality factor (libebur128 `ebur128_init_filter`). */
export const SHELF_Q = 0.7071752369554196;
/** Exponent giving the shelf mid-band gain Vb = Vh^x (libebur128 `ebur128_init_filter`). */
export const SHELF_VB_EXPONENT = 0.4996667741545416;
/** RLB high-pass corner frequency, Hz (libebur128 `ebur128_init_filter`). */
export const RLB_F0 = 38.13547087602444;
/** RLB high-pass quality factor (libebur128 `ebur128_init_filter`). */
export const RLB_Q = 0.5003270373238773;

/** Offset of the loudness formula, in dB (ITU-R BS.1770-5 Annex 1, eq. 2). */
export const LOUDNESS_OFFSET_DB = -0.691;

/** Hop length used for the sliding windows, in seconds (see the module notes). */
export const HOP_SECONDS = 0.01;
/** Hops in the 400 ms momentary window (EBU Tech 3341 §2.2). */
export const MOMENTARY_HOPS = 40;
/** Hops in the 3 s short-term window (EBU Tech 3341 §2.2). */
export const SHORT_TERM_HOPS = 300;

/**
 * K-weighting coefficients derived from the analog prototypes (libebur128 `ebur128_init_filter`).
 * @param {number} sampleRate
 * @returns {KWeighting}
 */
export function deriveKWeighting(sampleRate) {
  let k = Math.tan((Math.PI * SHELF_F0) / sampleRate);
  const vh = 10 ** (SHELF_GAIN_DB / 20);
  const vb = vh ** SHELF_VB_EXPONENT;
  let a0 = 1 + k / SHELF_Q + k * k;
  const shelf = {
    b: [
      (vh + (vb * k) / SHELF_Q + k * k) / a0,
      (2 * (k * k - vh)) / a0,
      (vh - (vb * k) / SHELF_Q + k * k) / a0,
    ],
    a: [1, (2 * (k * k - 1)) / a0, (1 - k / SHELF_Q + k * k) / a0],
  };
  k = Math.tan((Math.PI * RLB_F0) / sampleRate);
  a0 = 1 + k / RLB_Q + k * k;
  const rlb = { b: [1, -2, 1], a: [1, (2 * (k * k - 1)) / a0, (1 - k / RLB_Q + k * k) / a0] };
  return { shelf, rlb };
}

/**
 * K-weighting used at a sample rate: the published table at 48 kHz, the derivation elsewhere.
 * @param {number} sampleRate
 * @returns {Readonly<KWeighting>}
 */
export function kWeighting(sampleRate) {
  return sampleRate === 48000 ? K_WEIGHTING_48K : deriveKWeighting(sampleRate);
}

/**
 * Mean K-weighted energy to loudness, clamped to FLOOR_DB.
 * @param {number} energy
 * @returns {number}
 */
function energyToLoudness(energy) {
  const value = LOUDNESS_OFFSET_DB + 10 * Math.log10(energy);
  return value > FLOOR_DB ? value : FLOOR_DB;
}

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
export function createLoudnessMeter(options) {
  const sampleRate = checkSampleRate(options.sampleRate);
  const { shelf, rlb } = kWeighting(sampleRate);
  const sb0 = shelf.b[0];
  const sb1 = shelf.b[1];
  const sb2 = shelf.b[2];
  const sa1 = shelf.a[1];
  const sa2 = shelf.a[2];
  const rb0 = rlb.b[0];
  const rb1 = rlb.b[1];
  const rb2 = rlb.b[2];
  const ra1 = rlb.a[1];
  const ra2 = rlb.a[2];
  const hopLength = Math.round(sampleRate * HOP_SECONDS);
  const momentaryScale = 1 / (MOMENTARY_HOPS * hopLength);
  const shortTermScale = 1 / (SHORT_TERM_HOPS * hopLength);
  // Per channel: [shelf s1, shelf s2, rlb s1, rlb s2] (transposed direct form II).
  const filters = new Float64Array(8);
  const ring = new Float64Array(SHORT_TERM_HOPS);
  // [hop energy, hop fill, ring position, completed hops (capped), momentary mean, short-term mean]
  const scalars = new Float64Array(6);
  const buffers = Object.freeze([filters, ring, scalars]);

  function completeHop() {
    let position = scalars[2];
    ring[position] = scalars[0];
    position = position === SHORT_TERM_HOPS - 1 ? 0 : position + 1;
    scalars[2] = position;
    scalars[0] = 0;
    scalars[1] = 0;
    if (scalars[3] < SHORT_TERM_HOPS) scalars[3] += 1;
    let momentary = 0;
    let shortTerm = 0;
    for (let h = 0; h < SHORT_TERM_HOPS; h++) {
      // h counts back from the newest hop.
      const index = position - 1 - h < 0 ? position - 1 - h + SHORT_TERM_HOPS : position - 1 - h;
      const energy = ring[index];
      shortTerm += energy;
      if (h < MOMENTARY_HOPS) momentary += energy;
    }
    scalars[4] = momentary * momentaryScale;
    scalars[5] = shortTerm * shortTermScale;
  }

  /**
   * @param {Samples} left
   * @param {Samples} [right]
   */
  function process(left, right) {
    const n = blockLength(left, right);
    const stereo = right !== undefined;
    const r = right === undefined ? left : right;
    let ls1 = filters[0];
    let ls2 = filters[1];
    let lr1 = filters[2];
    let lr2 = filters[3];
    let rs1 = filters[4];
    let rs2 = filters[5];
    let rr1 = filters[6];
    let rr2 = filters[7];
    let energy = scalars[0];
    let fill = scalars[1];
    for (let i = 0; i < n; i++) {
      const xl = left[i];
      const ul = sb0 * xl + ls1;
      ls1 = sb1 * xl - sa1 * ul + ls2;
      ls2 = sb2 * xl - sa2 * ul;
      const yl = rb0 * ul + lr1;
      lr1 = rb1 * ul - ra1 * yl + lr2;
      lr2 = rb2 * ul - ra2 * yl;
      energy += yl * yl;
      if (stereo) {
        const xr = r[i];
        const ur = sb0 * xr + rs1;
        rs1 = sb1 * xr - sa1 * ur + rs2;
        rs2 = sb2 * xr - sa2 * ur;
        const yr = rb0 * ur + rr1;
        rr1 = rb1 * ur - ra1 * yr + rr2;
        rr2 = rb2 * ur - ra2 * yr;
        energy += yr * yr;
      }
      fill += 1;
      if (fill === hopLength) {
        scalars[0] = energy;
        completeHop();
        energy = 0;
        fill = 0;
      }
    }
    scalars[0] = energy;
    scalars[1] = fill;
    filters[0] = flush(ls1);
    filters[1] = flush(ls2);
    filters[2] = flush(lr1);
    filters[3] = flush(lr2);
    filters[4] = flush(rs1);
    filters[5] = flush(rs2);
    filters[6] = flush(rr1);
    filters[7] = flush(rr2);
  }

  return {
    process,
    read() {
      return {
        momentary: energyToLoudness(scalars[4]),
        shortTerm: energyToLoudness(scalars[5]),
        momentaryReady: scalars[3] >= MOMENTARY_HOPS,
        shortTermReady: scalars[3] >= SHORT_TERM_HOPS,
      };
    },
    reset() {
      filters.fill(0);
      ring.fill(0);
      scalars.fill(0);
    },
    getState() {
      return {
        kind: 'loudness',
        sampleRate,
        filters: Array.from(filters),
        ring: Array.from(ring),
        scalars: Array.from(scalars),
      };
    },
    setState(state) {
      const record = checkState(state, 'loudness', sampleRate);
      const nextFilters = readArray(record.filters, filters.length, 'loudness filters');
      const nextRing = readArray(record.ring, ring.length, 'loudness ring');
      const nextScalars = readArray(record.scalars, scalars.length, 'loudness scalars');
      readInteger(nextScalars[1], 0, hopLength - 1, 'loudness hop fill');
      readInteger(nextScalars[2], 0, SHORT_TERM_HOPS - 1, 'loudness ring position');
      readInteger(nextScalars[3], 0, SHORT_TERM_HOPS, 'loudness hop count');
      filters.set(nextFilters);
      ring.set(nextRing);
      scalars.set(nextScalars);
    },
    hopLength,
    buffers,
  };
}
