/** Lowest frequency of the canonical analysis grid, in Hz. */
export declare const GRID_MIN_HZ = 20;
/** Highest frequency of the canonical analysis grid, in Hz. */
export declare const GRID_MAX_HZ = 20000;
/** Number of points of the canonical analysis grid (log-spaced, both ends included). */
export declare const GRID_POINTS = 481;
/**
 * Log-spaced frequencies from `minHz` to `maxHz`, both ends exact.
 * @param {number} [points]
 * @param {number} [minHz]
 * @param {number} [maxHz]
 * @returns {number[]}
 */
export declare function logGrid(points?: number, minHz?: number, maxHz?: number): number[];
/** The canonical 481-point grid from 20 Hz to 20 kHz shared by measurements, targets and the solver. */
export declare const GRID: readonly number[];
