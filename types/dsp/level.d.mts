export type Band = import('./eq0xcb.mjs').Band;
export type Section = import('./eq0xcb.mjs').Section;
/**
 * @typedef {import('./eq0xcb.mjs').Band} Band
 * @typedef {import('./eq0xcb.mjs').Section} Section
 */
/** Q27 fixed-point scale of the section words. */
export declare const Q27: number;
/**
 * The official 280-point log grid (20 Hz–20 kHz, rounded to 0.01 Hz) filtered to
 * 300–3000 Hz: 93 frequencies.
 * @type {readonly number[]}
 */
export declare const MEAN_FREQUENCIES: readonly number[];
/**
 * Section coefficients as the chip sees them, from the 5 wire words
 * `[b0, b2, -a1, b1, -a2]` (Q27).
 * @param {readonly number[]} words
 * @returns {Section}
 */
export declare function fromWords(words: readonly number[]): Section;
/**
 * Q27-quantized section of a band. Throws like the codec on invalid bands.
 * @param {Band} band
 * @returns {Section}
 */
export declare function quantizedSection(band: Band): Section;
/**
 * True for the exact pass-through section (OFF, or any section whose quantized
 * numerator equals its denominator).
 * @param {Section} s
 * @returns {boolean}
 */
export declare function isIdentitySection(s: Section): boolean;
/**
 * Magnitude (dB) of one section at `f` Hz, evaluated around z^-1 = 1 (the stable
 * form of the codec). Exact identities return 0.
 * @param {Section} s
 * @param {number} f
 * @returns {number}
 */
export declare function sectionDb(s: Section, f: number): number;
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
export declare function sectionDbFromTerms(s: Section, re: number, im: number, u2re: number, u2im: number): number;
/**
 * The preamp actually applied by the chip (Q23 word), in dB. Throws like
 * `preampWord` on non-finite or positive values.
 * @param {number} preampDb
 * @returns {number}
 */
export declare function quantizedPreampDb(preampDb: number): number;
/**
 * Effective level (dB) of `bands` with `preampDb`: Q23 preamp plus the mean, over
 * MEAN_FREQUENCIES, of the summed Q27 section gains. Throws on bands or preamps
 * the codec cannot encode. Any number of bands is accepted; they are copied
 * once with `snapshotBands` (one read per field), so a non-array, a hole in a
 * sparse array or a non-object element throws a TypeError (holes are never
 * silently skipped).
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @returns {number}
 */
export declare function levelDb(bands: readonly Band[], preampDb: number): number;
