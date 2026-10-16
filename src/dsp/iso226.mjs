/**
 * ISO 226:2003, Acoustics — Normal equal-loudness-level contours, Table 1 and
 * equation (1). The 2003 edition is implemented as specified by the product plan.
 * ISO 226:2023 revised the data by up to 0.6 dB (−0.6…+0.3 dB; largest at 10 phon).
 *
 * Between preferred frequencies, alpha_f, L_U and T_f are interpolated linearly
 * in log-frequency BEFORE evaluating equation (1). From 12.5 to 20 kHz the final
 * table row is held constant: this extension is non-normative, not ISO data.
 *
 * Accepted levels are 0–100 phon. Below 20 phon results are informative only.
 * Normative limits are 100 phon through 1 kHz, 90 phon through 4 kHz, and 80 phon
 * above 4 kHz through 12.5 kHz (conservative across the 4–5 kHz interval).
 * Results outside these limits are flagged extrapolated; values outside the
 * accepted level/frequency domain throw RangeError with a stable message.
 */
import { GRID } from './grid.mjs';

/**
 * @typedef {'normative' | 'informative' | 'extrapolated'} Validity
 * @typedef {Readonly<{freqHz: number, alphaF: number, luDb: number, tfDb: number}>} Iso226Row
 * @typedef {{splDb: number, validity: Validity}} SplResult
 * @typedef {{splDb: number[], validity: Validity}} ContourResult
 * @typedef {{compensationDb: number[], validity: Validity}} CompensationResult
 * @typedef {{weights: number[], validity: Validity}} WeightsResult
 */

/**
 * ISO 226:2003 Table 1. alphaF = alpha_f, luDb = L_U, tfDb = T_f.
 * Rows and the containing array are immutable.
 * @type {readonly Iso226Row[]}
 */
export const ISO226_TABLE = Object.freeze(
  [
    [20, 0.532, -31.6, 78.5],
    [25, 0.506, -27.2, 68.7],
    [31.5, 0.48, -23, 59.5],
    [40, 0.455, -19.1, 51.1],
    [50, 0.432, -15.9, 44],
    [63, 0.409, -13, 37.5],
    [80, 0.387, -10.3, 31.5],
    [100, 0.367, -8.1, 26.5],
    [125, 0.349, -6.2, 22.1],
    [160, 0.33, -4.5, 17.9],
    [200, 0.315, -3.1, 14.4],
    [250, 0.301, -2, 11.4],
    [315, 0.288, -1.1, 8.6],
    [400, 0.276, -0.4, 6.2],
    [500, 0.267, 0, 4.4],
    [630, 0.259, 0.3, 3],
    [800, 0.253, 0.5, 2.2],
    [1000, 0.25, 0, 2.4],
    [1250, 0.246, -2.7, 3.5],
    [1600, 0.244, -4.1, 1.7],
    [2000, 0.243, -1, -1.3],
    [2500, 0.243, 1.7, -4.2],
    [3150, 0.243, 2.5, -6],
    [4000, 0.242, 1.2, -5.4],
    [5000, 0.242, -2.1, -1.5],
    [6300, 0.245, -7.1, 6],
    [8000, 0.254, -11.2, 12.6],
    [10000, 0.271, -10.7, 13.9],
    [12500, 0.301, -3.1, 12.3],
  ].map(([freqHz, alphaF, luDb, tfDb]) => Object.freeze({ freqHz, alphaF, luDb, tfDb })),
);

/** @type {Validity[]} */
const VALIDITIES = ['normative', 'informative', 'extrapolated'];

/** @param {number} phon */
function checkPhon(phon) {
  if (!Number.isFinite(phon) || phon < 0 || phon > 100) {
    throw new RangeError('phon must be a finite number in [0, 100]');
  }
}

/**
 * @param {number} phon
 * @param {number} freqHz
 * @returns {Validity}
 */
function validityAt(phon, freqHz) {
  if (freqHz > 12500 || (freqHz > 4000 && phon > 80) || (freqHz > 1000 && phon > 90)) {
    return 'extrapolated';
  }
  return phon < 20 ? 'informative' : 'normative';
}

/**
 * @param {Validity} a
 * @param {Validity} b
 * @returns {Validity}
 */
function combinedValidity(a, b) {
  return VALIDITIES[Math.max(VALIDITIES.indexOf(a), VALIDITIES.indexOf(b))];
}

/**
 * @param {number} phon
 * @param {number} alphaF
 * @param {number} luDb
 * @param {number} tfDb
 * @returns {number}
 */
function spl(phon, alphaF, luDb, tfDb) {
  const af =
    4.47e-3 * (10 ** (0.025 * phon) - 1.15) + (0.4 * 10 ** ((tfDb + luDb) / 10 - 9)) ** alphaF;
  return (10 / alphaF) * Math.log10(af) - luDb + 94;
}

/**
 * SPL at any 20–20000 Hz. Table parameters, NOT computed SPLs, are interpolated
 * in log-frequency. The constant extension above 12.5 kHz is non-normative and
 * always flagged extrapolated. Exact preferred points reproduce equation (1).
 * @param {number} phon
 * @param {number} freqHz
 * @returns {SplResult}
 */
export function equalLoudnessSpl(phon, freqHz) {
  checkPhon(phon);
  if (!Number.isFinite(freqHz) || freqHz < 20 || freqHz > 20000) {
    throw new RangeError('freqHz must be a finite number in [20, 20000]');
  }
  let upper = 1;
  while (upper < ISO226_TABLE.length - 1 && ISO226_TABLE[upper].freqHz < freqHz) upper++;
  const low = ISO226_TABLE[upper - 1];
  const high = ISO226_TABLE[upper];
  const fraction = Math.min(1, Math.log(freqHz / low.freqHz) / Math.log(high.freqHz / low.freqHz));
  return {
    splDb: spl(
      phon,
      low.alphaF + fraction * (high.alphaF - low.alphaF),
      low.luDb + fraction * (high.luDb - low.luDb),
      low.tfDb + fraction * (high.tfDb - low.tfDb),
    ),
    validity: validityAt(phon, freqHz),
  };
}

/**
 * Sample SPL on the shared grid (or a supplied nonempty grid). The overall
 * validity is the least normative sample: extrapolated > informative > normative.
 * The default GRID includes the non-normative extension, so its flag is extrapolated.
 * @param {number} phon
 * @param {readonly number[]} [grid]
 * @returns {ContourResult}
 */
export function contour(phon, grid = GRID) {
  checkPhon(phon);
  if (grid.length === 0) throw new RangeError('grid must contain at least one frequency');
  const samples = grid.map((freqHz) => equalLoudnessSpl(phon, freqHz));
  return {
    splDb: samples.map((sample) => sample.splDb),
    validity: samples.reduce(
      (flag, sample) => combinedValidity(flag, sample.validity),
      /** @type {Validity} */ ('normative'),
    ),
  };
}

/**
 * The 29 SPLs, in ISO226_TABLE order, plus their combined validity.
 * @param {number} phon
 * @returns {ContourResult}
 */
export function splAtPreferred(phon) {
  return contour(
    phon,
    ISO226_TABLE.map((row) => row.freqHz),
  );
}

/**
 * Static gain to preserve the reference balance at an actual listening level.
 * Positive means boost: listening quieter (e.g. reference 80, actual 40 phon)
 * requires positive bass gain. This is the inverse of the sensitivity change:
 * (Lp(actual) - actual) - (Lp(reference) - reference), normalized to exactly
 * 0 dB at 1 kHz using the equation there, even when the grid omits 1 kHz.
 * This is a relative EQ curve, not an absolute listening-level calibration.
 * @param {number} referencePhon
 * @param {number} actualPhon
 * @param {readonly number[]} [grid]
 * @returns {CompensationResult}
 */
export function loudnessCompensationDb(referencePhon, actualPhon, grid = GRID) {
  const reference = contour(referencePhon, grid);
  const actual = contour(actualPhon, grid);
  const anchor =
    equalLoudnessSpl(actualPhon, 1000).splDb -
    actualPhon -
    (equalLoudnessSpl(referencePhon, 1000).splDb - referencePhon);
  return {
    compensationDb: actual.splDb.map(
      (value, index) => value - actualPhon - (reference.splDb[index] - referencePhon) - anchor,
    ),
    validity: combinedValidity(reference.validity, actual.validity),
  };
}

/**
 * Amplitude-sensitivity weights: 10^(-(Lp(f) - phon)/20), normalized to the
 * maximum on the requested grid, THEN floored at 0.05. This keeps all frequencies
 * represented without letting low-sensitivity extremes dominate D4/D6. These
 * are relative perceptual weights, not an SPL calibration or ISO weighting filter.
 * @param {readonly number[]} [grid]
 * @param {number} [phon]
 * @returns {WeightsResult}
 */
export function perceptualWeights(grid = GRID, phon = 60) {
  const result = contour(phon, grid);
  const raw = result.splDb.map((value) => 10 ** (-(value - phon) / 20));
  const maximum = Math.max(...raw);
  return {
    weights: raw.map((weight) => Math.max(0.05, weight / maximum)),
    validity: result.validity,
  };
}
