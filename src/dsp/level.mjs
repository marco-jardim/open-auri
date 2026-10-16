// Effective level of a curve as the chip computes it, plus the quantized-section
// helpers shared with the safety gate (src/safety/gate.mjs).
//
// Exact port of the reference analysis (design/analysis/gate.mjs): same
// arithmetic, same order of summations, so results are bit-identical. The
// level metric is the arithmetic mean of the cascade gain in dB over the 93
// points of the official 280-point grid that fall in 300 Hz–3 kHz, plus the
// Q23 preamp. It is not LUFS, ISO 226 or a loudness prediction.
//
// Pure ESM: no DOM, no Node-only APIs.

import { designSection, encodeSection, preampWord, SAMPLE_RATE } from './eq0xcb.mjs';

/**
 * @typedef {import('./eq0xcb.mjs').Band} Band
 * @typedef {import('./eq0xcb.mjs').Section} Section
 */

/** Q27 fixed-point scale of the section words. */
export const Q27 = 2 ** 27;

const Q23 = 2 ** 23;

/**
 * The official 280-point log grid (20 Hz–20 kHz, rounded to 0.01 Hz) filtered to
 * 300–3000 Hz: 93 frequencies.
 * @type {readonly number[]}
 */
export const MEAN_FREQUENCIES = Object.freeze(
  Array.from({ length: 280 }, (_, i) => Math.round(20 * 1000 ** (i / 279) * 100) / 100).filter(
    (f) => f >= 300 && f <= 3000,
  ),
);

/**
 * Section coefficients as the chip sees them, from the 5 wire words
 * `[b0, b2, -a1, b1, -a2]` (Q27).
 * @param {readonly number[]} words
 * @returns {Section}
 */
export function fromWords(words) {
  return {
    b0: words[0] / Q27,
    b2: words[1] / Q27,
    a1: -words[2] / Q27,
    b1: words[3] / Q27,
    a2: -words[4] / Q27,
  };
}

/**
 * Q27-quantized section of a band. Throws like the codec on invalid bands.
 * @param {Band} band
 * @returns {Section}
 */
export function quantizedSection(band) {
  return fromWords(encodeSection(designSection(band)));
}

/**
 * True for the exact pass-through section (OFF, or any section whose quantized
 * numerator equals its denominator).
 * @param {Section} s
 * @returns {boolean}
 */
export function isIdentitySection(s) {
  return s.b0 === 1 && s.b1 === s.a1 && s.b2 === s.a2;
}

/**
 * Magnitude (dB) of one section at `f` Hz, evaluated around z^-1 = 1 (the stable
 * form of the codec). Exact identities return 0.
 * @param {Section} s
 * @param {number} f
 * @returns {number}
 */
export function sectionDb(s, f) {
  if (isIdentitySection(s)) return 0;
  const w = (2 * Math.PI * f) / SAMPLE_RATE;
  const re = 2 * Math.sin(w / 2) ** 2;
  const im = Math.sin(w);
  return sectionDbFromTerms(s, re, im, re * re - im * im, 2 * re * im);
}

/**
 * `sectionDb` from precomputed frequency terms (u = 1 − e^−jw = re + j·im and
 * u² = u2re + j·u2im), for callers scanning a fixed grid many times. Same
 * arithmetic as `sectionDb`, so results are bit-identical.
 * @param {Section} s
 * @param {number} re
 * @param {number} im
 * @param {number} u2re
 * @param {number} u2im
 * @returns {number}
 */
export function sectionDbFromTerms(s, re, im, u2re, u2im) {
  if (isIdentitySection(s)) return 0;
  /**
   * @param {number} p0
   * @param {number} p1
   * @param {number} p2
   */
  const power = (p0, p1, p2) => {
    const r = p0 + p1 + p2 - (p1 + 2 * p2) * re + p2 * u2re;
    const i = -(p1 + 2 * p2) * im + p2 * u2im;
    return r * r + i * i;
  };
  return 10 * Math.log10(power(s.b0, s.b1, s.b2) / power(1, s.a1, s.a2));
}

/**
 * The preamp actually applied by the chip (Q23 word), in dB. Throws like
 * `preampWord` on non-finite or positive values.
 * @param {number} preampDb
 * @returns {number}
 */
export function quantizedPreampDb(preampDb) {
  return 20 * Math.log10(preampWord(preampDb) / Q23);
}

/**
 * Effective level (dB) of `bands` with `preampDb`: Q23 preamp plus the mean, over
 * MEAN_FREQUENCIES, of the summed Q27 section gains. Throws on bands or preamps
 * the codec cannot encode.
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @returns {number}
 */
export function levelDb(bands, preampDb) {
  const sections = bands.map(quantizedSection);
  return (
    quantizedPreampDb(preampDb) +
    MEAN_FREQUENCIES.reduce(
      (sum, f) => sum + sections.reduce((db, s) => db + sectionDb(s, f), 0),
      0,
    ) /
      MEAN_FREQUENCIES.length
  );
}
