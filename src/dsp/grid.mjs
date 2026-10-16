/** Lowest frequency of the canonical analysis grid, in Hz. */
export const GRID_MIN_HZ = 20;

/** Highest frequency of the canonical analysis grid, in Hz. */
export const GRID_MAX_HZ = 20000;

/** Number of points of the canonical analysis grid (log-spaced, both ends included). */
export const GRID_POINTS = 481;

/**
 * Log-spaced frequencies from `minHz` to `maxHz`, both ends exact.
 * @param {number} [points]
 * @param {number} [minHz]
 * @param {number} [maxHz]
 * @returns {number[]}
 */
export function logGrid(points = GRID_POINTS, minHz = GRID_MIN_HZ, maxHz = GRID_MAX_HZ) {
  if (!Number.isInteger(points) || points < 2) {
    throw new RangeError(`grid needs an integer number of points >= 2, got ${points}`);
  }
  if (!(minHz > 0) || !(maxHz > minHz) || !Number.isFinite(maxHz)) {
    throw new RangeError(`grid needs 0 < minHz < maxHz, got ${minHz}..${maxHz}`);
  }
  const ratio = maxHz / minHz;
  const grid = Array.from({ length: points }, (_, i) => minHz * ratio ** (i / (points - 1)));
  grid[0] = minHz;
  grid[points - 1] = maxHz;
  return grid;
}

/** The canonical 481-point grid from 20 Hz to 20 kHz shared by measurements, targets and the solver. */
export const GRID = Object.freeze(logGrid());
