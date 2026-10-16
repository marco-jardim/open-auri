/**
 * S4 curve comparison on the shared logarithmic analysis grid.
 * Responses use the 0xCB designer/evaluator, not an independent filter model.
 */
import { checkBand, designSection, magnitudeDb } from './eq0xcb.mjs';
import { GRID } from './grid.mjs';

/**
 * @typedef {{bands: readonly import('./eq0xcb.mjs').Band[], preampDb?: number}} Curve
 * @typedef {readonly number[] | Curve} ResponseOrCurve
 * @typedef {{fromHz: number, toHz: number, peakDiffDb: number}} DifferenceRegion
 * @typedef {{rmsDb: number, maxDb: number, maxFreqHz: number,
 *   regions: DifferenceRegion[]}} CurveDistance
 * @typedef {{grid?: readonly number[], thresholdDb?: number,
 *   weights?: readonly number[], levelMatch?: boolean}} DistanceOptions
 */

/** @param {readonly number[]} grid */
function checkGrid(grid) {
  if (
    grid.length === 0 ||
    !grid.every(
      (freqHz, index) =>
        Number.isFinite(freqHz) && freqHz > 0 && (index === 0 || freqHz > grid[index - 1]),
    )
  ) {
    throw new RangeError('grid must contain strictly increasing positive finite frequencies');
  }
}

/**
 * Sum all section magnitudes in dB and add the preamp. Any number of bands is
 * accepted; this is analysis, not the ten-section wire encoder. Positive
 * preamps are also allowed here. The 0xCB magnitudeDb evaluator uses designSection.
 * @param {Curve} curve
 * @param {readonly number[]} [grid]
 * @returns {number[]}
 */
export function curveResponseDb({ bands, preampDb = 0 }, grid = GRID) {
  checkGrid(grid);
  if (!Number.isFinite(preampDb)) {
    throw new RangeError('preampDb must be finite');
  }
  bands.forEach((band, index) => {
    checkBand(band, index);
    if (!Object.values(designSection(band)).every(Number.isFinite)) {
      throw new RangeError('bands must produce finite section coefficients');
    }
  });
  return grid.map((freqHz) => magnitudeDb(bands, freqHz) + preampDb);
}

/**
 * @param {ResponseOrCurve} value
 * @returns {value is readonly number[]}
 */
function isResponse(value) {
  return Array.isArray(value);
}

/**
 * @param {ResponseOrCurve} value
 * @param {readonly number[]} grid
 * @returns {readonly number[]}
 */
function response(value, grid) {
  const values = isResponse(value) ? value : curveResponseDb(value, grid);
  if (values.length !== grid.length || !values.every(Number.isFinite)) {
    throw new RangeError('responses must contain one finite dB value per grid frequency');
  }
  return values;
}

/**
 * Symmetric RMS/maximum absolute difference, with contiguous runs strictly above
 * thresholdDb. Region endpoints are grid samples, not interpolated crossings;
 * peakDiffDb is unsigned. A maximum tie selects the lowest frequency.
 *
 * By default, subtract the unweighted mean of (a - b) over grid samples in the
 * inclusive 300 Hz–3 kHz window before comparison. If the grid has no samples in
 * that window, no level matching is applied. Set levelMatch: false to retain
 * absolute level/preamp differences. Inputs are never modified.
 *
 * Nonnegative finite weights affect only RMS and are normalized by their sum;
 * multiplying every weight by the same positive constant changes nothing.
 * At least one weight must be positive. Maxima and regions remain unweighted.
 * @param {ResponseOrCurve} a
 * @param {ResponseOrCurve} b
 * @param {DistanceOptions} [options]
 * @returns {CurveDistance}
 */
export function distance(a, b, { grid = GRID, thresholdDb = 1, weights, levelMatch = true } = {}) {
  checkGrid(grid);
  if (!Number.isFinite(thresholdDb) || thresholdDb < 0) {
    throw new RangeError('thresholdDb must be finite and nonnegative');
  }
  const left = response(a, grid);
  const right = response(b, grid);
  const differences = left.map((value, index) => value - right[index]);
  let offsetDb = 0;
  let matchedSamples = 0;
  if (levelMatch) {
    grid.forEach((freqHz, index) => {
      if (freqHz >= 300 && freqHz <= 3000) {
        offsetDb += differences[index];
        matchedSamples++;
      }
    });
    if (matchedSamples > 0) offsetDb /= matchedSamples;
  }

  let normalizedWeights = grid.map(() => 1 / grid.length);
  if (weights !== undefined) {
    if (
      weights.length !== grid.length ||
      !weights.every((weight) => Number.isFinite(weight) && weight >= 0) ||
      !weights.some((weight) => weight > 0)
    ) {
      throw new RangeError(
        'weights must be finite, nonnegative, match grid and have a positive sum',
      );
    }
    // Scale first so a set of large but finite weights cannot overflow its sum.
    const maximum = Math.max(...weights);
    const scaled = weights.map((weight) => weight / maximum);
    const sum = scaled.reduce((total, weight) => total + weight, 0);
    normalizedWeights = scaled.map((weight) => weight / sum);
  }

  let meanSquare = 0;
  let maxDb = 0;
  let maxFreqHz = grid[0];
  /** @type {DifferenceRegion[]} */
  const regions = [];
  /** @type {DifferenceRegion | undefined} */
  let region;
  grid.forEach((freqHz, index) => {
    const absolute = Math.abs(differences[index] - offsetDb);
    meanSquare += normalizedWeights[index] * absolute * absolute;
    if (absolute > maxDb) {
      maxDb = absolute;
      maxFreqHz = freqHz;
    }
    if (absolute > thresholdDb) {
      if (region === undefined) {
        region = { fromHz: freqHz, toHz: freqHz, peakDiffDb: absolute };
        regions.push(region);
      } else {
        region.toHz = freqHz;
        region.peakDiffDb = Math.max(region.peakDiffDb, absolute);
      }
    } else {
      region = undefined;
    }
  });
  return { rmsDb: Math.sqrt(meanSquare), maxDb, maxFreqHz, regions };
}
