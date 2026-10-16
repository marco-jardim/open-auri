/**
 * Shared constants and helpers for the metering block processors in `src/meter/`.
 *
 * Every meter returns readings in dB clamped to {@link FLOOR_DB}, so silence gives a finite floor:
 * `-Infinity` and `NaN` are never returned (as long as the input samples are finite).
 * @module
 */

/** Lowest reading returned by every meter, in dB (dBFS, VU, dBTP or LUFS). */
export const FLOOR_DB = -120;

/** Linear amplitude matching {@link FLOOR_DB} (10^(−120/20)). */
export const FLOOR_AMPLITUDE = 1e-6;

/** Lowest accepted sample rate, in Hz. */
export const MIN_SAMPLE_RATE = 22050;

/** Highest accepted sample rate, in Hz (bounds the loudness ring buffers). */
export const MAX_SAMPLE_RATE = 768000;

/** Filter states below this magnitude are flushed to zero at block end (avoids subnormals). */
export const DENORMAL_FLUSH = 1e-30;

/** @typedef {Float32Array | Float64Array} Samples */

/**
 * Validates a sample rate.
 * @param {unknown} sampleRate
 * @returns {number}
 */
export function checkSampleRate(sampleRate) {
  if (
    typeof sampleRate !== 'number' ||
    !Number.isFinite(sampleRate) ||
    sampleRate < MIN_SAMPLE_RATE ||
    sampleRate > MAX_SAMPLE_RATE
  ) {
    throw new RangeError(
      `sampleRate must be a number in [${MIN_SAMPLE_RATE}, ${MAX_SAMPLE_RATE}] Hz, got ${String(sampleRate)}`,
    );
  }
  return sampleRate;
}

/**
 * Number of frames in a block; `right`, when given, must be at least as long as `left`.
 * @param {Samples} left
 * @param {Samples | undefined} right
 * @returns {number}
 */
export function blockLength(left, right) {
  if (right !== undefined && right.length < left.length) {
    throw new RangeError(`right channel has ${right.length} samples, left has ${left.length}`);
  }
  return left.length;
}

/**
 * Linear amplitude to dB, clamped to {@link FLOOR_DB} (also for zero, negative or NaN input).
 * @param {number} amplitude
 * @returns {number}
 */
export function amplitudeToDb(amplitude) {
  return amplitude > FLOOR_AMPLITUDE ? 20 * Math.log10(amplitude) : FLOOR_DB;
}

/**
 * Zero when the magnitude is below {@link DENORMAL_FLUSH}.
 * @param {number} value
 * @returns {number}
 */
export function flush(value) {
  return value < DENORMAL_FLUSH && value > -DENORMAL_FLUSH ? 0 : value;
}

/**
 * Validates the envelope of a serialized meter state.
 * @param {unknown} state
 * @param {string} kind
 * @param {number} sampleRate
 * @returns {Record<string, unknown>}
 */
export function checkState(state, kind, sampleRate) {
  if (state === null || typeof state !== 'object') {
    throw new TypeError(`${kind} state must be an object`);
  }
  const record = /** @type {Record<string, unknown>} */ (state);
  if (record.kind !== kind) {
    throw new TypeError(`expected a ${kind} state, got ${String(record.kind)}`);
  }
  if (record.sampleRate !== sampleRate) {
    throw new RangeError(
      `${kind} state was taken at ${String(record.sampleRate)} Hz, meter runs at ${sampleRate} Hz`,
    );
  }
  return record;
}

/**
 * Validates a serialized array of finite numbers with an exact length.
 * @param {unknown} value
 * @param {number} length
 * @param {string} name
 * @returns {number[]}
 */
export function readArray(value, length, name) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${name} must be an array of ${length} numbers`);
  }
  for (let i = 0; i < length; i++) {
    if (typeof value[i] !== 'number' || !Number.isFinite(value[i])) {
      throw new TypeError(`${name}[${i}] must be a finite number`);
    }
  }
  return value;
}

/**
 * Validates a serialized integer in `[min, max]`.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {string} name
 * @returns {number}
 */
export function readInteger(value, min, max, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}
