/** Synthetic test signals and helpers shared by the meter tests. */

/**
 * Sine samples a·sin(2π f n / fs + phase).
 * @param {number} sampleRate
 * @param {number} frequency
 * @param {number} amplitude
 * @param {number} length Samples.
 * @param {number} [phase] Radians.
 * @param {number} [startSample] Index of the first sample (keeps phase continuity across segments).
 * @returns {Float32Array}
 */
export function sine(sampleRate, frequency, amplitude, length, phase = 0, startSample = 0) {
  const out = new Float32Array(length);
  const w = (2 * Math.PI * frequency) / sampleRate;
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin(w * (i + startSample) + phase);
  return out;
}

/**
 * Linear amplitude of a level in dB.
 * @param {number} db
 */
export function dbToAmplitude(db) {
  return 10 ** (db / 20);
}

/**
 * Seeded PRNG (mulberry32), uniform in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Uniform white noise in [−amplitude, amplitude).
 * @param {number} length
 * @param {number} seed
 * @param {number} [amplitude]
 * @returns {Float32Array}
 */
export function noise(length, seed, amplitude = 0.5) {
  const random = mulberry32(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * (2 * random() - 1);
  return out;
}

/**
 * Feeds a signal to a meter in blocks; `onBlock` receives the index after the block.
 * @param {{ process: (left: Float32Array, right?: Float32Array) => void }} meter
 * @param {Float32Array} left
 * @param {Float32Array} [right]
 * @param {(end: number) => void} [onBlock]
 * @param {number} [blockSize]
 */
export function feed(meter, left, right, onBlock, blockSize = 128) {
  for (let start = 0; start < left.length; start += blockSize) {
    const end = Math.min(start + blockSize, left.length);
    if (right === undefined) meter.process(left.subarray(start, end));
    else meter.process(left.subarray(start, end), right.subarray(start, end));
    if (onBlock) onBlock(end);
  }
}

/**
 * Concatenates sample arrays.
 * @param {Float32Array[]} parts
 * @returns {Float32Array}
 */
export function concat(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
