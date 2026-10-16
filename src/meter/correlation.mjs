/**
 * Stereo correlation (phase) meter as an allocation-free block processor.
 *
 * Sources and deviations
 * - Definition: normalised cross-correlation at lag 0, r = E{L·R} / √(E{L²}·E{R²}), the quantity
 *   shown by correlation meters (Pearson correlation of zero-mean audio signals); r = +1 for mono,
 *   −1 for polarity-inverted channels, ≈ 0 for unrelated signals.
 * - Averaging: each expectation is a one-pole (exponential) averager y += α·(x − y) with
 *   α = 1 − e^(−1/(τ·fs)). τ = 300 ms by default ({@link CORRELATION_DEFAULT_TIME_CONSTANT}); meters
 *   in practice use 300–600 ms and Sound On Sound cites about 600 ms (secondary source named in the
 *   task brief; no article URL was verified), so τ is an option. 300 ms follows the faster end of
 *   practice, matching the VU integration time (ballistics.mjs).
 * - No signal: when either channel's mean square is at or below {@link CORRELATION_ENERGY_FLOOR}
 *   (−120 dBFS mean square) the reading is 0 and `active` is false. The result is clamped to
 *   [−1, 1] against rounding; NaN is never returned for finite input.
 * - Without `right` the input is mono and reads +1.
 * @module
 */

import { blockLength, checkSampleRate, checkState, flush, readArray } from './common.mjs';

/** @import { Samples } from './common.mjs' */

/** Default averaging time constant, in seconds (see the module notes). */
export const CORRELATION_DEFAULT_TIME_CONSTANT = 0.3;

/** Mean-square level at or below which a channel counts as silent (10^(−120/10)). */
export const CORRELATION_ENERGY_FLOOR = 1e-12;

/**
 * @typedef {object} CorrelationReading
 * @property {number} correlation Correlation in [−1, 1]; 0 when `active` is false.
 * @property {boolean} active False when either channel is below the energy floor.
 */

/**
 * @typedef {object} CorrelationState
 * @property {'correlation'} kind
 * @property {number} sampleRate
 * @property {number} timeConstant
 * @property {number[]} averages
 */

/**
 * @typedef {object} CorrelationMeter
 * @property {(left: Samples, right?: Samples) => void} process Processes one block (any length).
 * @property {() => CorrelationReading} read
 * @property {() => void} reset
 * @property {() => CorrelationState} getState
 * @property {(state: unknown) => void} setState
 * @property {readonly Float64Array[]} buffers Preallocated internal buffers (identity never changes).
 */

/**
 * Creates a stereo correlation meter.
 * @param {{ sampleRate: number, timeConstant?: number }} options
 * @returns {CorrelationMeter}
 */
export function createCorrelationMeter(options) {
  const sampleRate = checkSampleRate(options.sampleRate);
  const timeConstant = options.timeConstant ?? CORRELATION_DEFAULT_TIME_CONSTANT;
  if (typeof timeConstant !== 'number' || !(timeConstant >= 0.01 && timeConstant <= 10)) {
    throw new RangeError(`correlation timeConstant must be in [0.01, 10] s, got ${timeConstant}`);
  }
  const alpha = 1 - Math.exp(-1 / (timeConstant * sampleRate));
  // [E{L·R}, E{L²}, E{R²}]
  const averages = new Float64Array(3);
  const buffers = Object.freeze([averages]);

  /**
   * @param {Samples} left
   * @param {Samples} [right]
   */
  function process(left, right) {
    const n = blockLength(left, right);
    const r = right === undefined ? left : right;
    let lr = averages[0];
    let ll = averages[1];
    let rr = averages[2];
    for (let i = 0; i < n; i++) {
      const xl = left[i];
      const xr = r[i];
      lr += alpha * (xl * xr - lr);
      ll += alpha * (xl * xl - ll);
      rr += alpha * (xr * xr - rr);
    }
    averages[0] = flush(lr);
    averages[1] = flush(ll);
    averages[2] = flush(rr);
  }

  return {
    process,
    read() {
      const ll = averages[1];
      const rr = averages[2];
      if (!(ll > CORRELATION_ENERGY_FLOOR && rr > CORRELATION_ENERGY_FLOOR)) {
        return { correlation: 0, active: false };
      }
      const value = averages[0] / Math.sqrt(ll * rr);
      return { correlation: value > 1 ? 1 : value < -1 ? -1 : value, active: true };
    },
    reset() {
      averages.fill(0);
    },
    getState() {
      return { kind: 'correlation', sampleRate, timeConstant, averages: Array.from(averages) };
    },
    setState(state) {
      const record = checkState(state, 'correlation', sampleRate);
      if (record.timeConstant !== timeConstant) {
        throw new RangeError(`correlation state uses τ = ${String(record.timeConstant)} s`);
      }
      averages.set(readArray(record.averages, averages.length, 'correlation averages'));
    },
    buffers,
  };
}
