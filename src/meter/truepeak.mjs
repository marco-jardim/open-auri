/**
 * True-peak meter (ITU-R BS.1770 Annex 2) as an allocation-free block processor.
 *
 * Sources and deviations
 * - ITU-R BS.1770-5 Annex 2 (https://www.itu.int/rec/R-REC-BS.1770/en): 4× oversampling with a
 *   48-tap, 4-phase polyphase FIR (12 taps per phase), true peak = max |y| in dBTP. The phase
 *   arrays {@link TRUE_PEAK_PHASES} were reconstructed from a text extraction of the Recommendation;
 *   the interleaved 48-tap filter h[4j + k] = P_k[j] is checked for the symmetry h[n] = h[47 − n]
 *   and validated against EBU Tech 3341 test 15 (https://tech.ebu.ch/docs/tech/tech3341.pdf) in
 *   test/meter/truepeak.test.mjs.
 * - Oversampling factor: the smallest of 1, 2 or 4 that reaches ≥ 176.4 kHz (the effective rate
 *   the Annex reaches at 44.1 kHz): 4× below 88.2 kHz, 2× at 88.2–176.4 kHz, none from 176.4 kHz
 *   (so none at 192 kHz). 2× uses phases 0 and 2 of the same filter, i.e. the 4× output decimated
 *   by 2: they sit at evenly spaced fractional positions 0.125 and 0.625 of an input period.
 * - Deviation: no phase of this filter reproduces the input samples (all phases are fractional
 *   delays), so the input sample magnitudes are included in the maximum as well. The reading is
 *   therefore never below the sample peak.
 * - The Annex's optional −12.04 dB input attenuation is not applied (floating point has headroom).
 * - Silence reads FLOOR_DB (−120 dBTP); −Infinity and NaN are never returned.
 * @module
 */

import {
  amplitudeToDb,
  blockLength,
  checkSampleRate,
  checkState,
  readArray,
  readInteger,
} from './common.mjs';

/** @import { Samples } from './common.mjs' */

/** Taps per polyphase branch (ITU-R BS.1770-5 Annex 2). */
export const TRUE_PEAK_TAPS_PER_PHASE = 12;

/**
 * Polyphase branches P0..P3 of the BS.1770-5 Annex 2 interpolation filter (12 taps each).
 * @type {readonly (readonly number[])[]}
 */
export const TRUE_PEAK_PHASES = Object.freeze([
  Object.freeze([
    0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875,
    0.1373291015625, 0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125,
    0.014892578125, -0.00830078125,
  ]),
  Object.freeze([
    -0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625,
    0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375,
  ]),
  Object.freeze([
    -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625,
    0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875,
  ]),
  Object.freeze([
    -0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875,
    0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125,
    0.001708984375,
  ]),
]);

/**
 * Oversampling factor used at a sample rate (see the module notes).
 * @param {number} sampleRate
 * @returns {1 | 2 | 4}
 */
export function oversamplingFactor(sampleRate) {
  if (sampleRate >= 176400) return 1;
  if (sampleRate >= 88200) return 2;
  return 4;
}

/**
 * @typedef {object} TruePeakReading
 * @property {number} left Maximum left true peak since the last reset, in dBTP.
 * @property {number} right Maximum right true peak since the last reset, in dBTP.
 * @property {number} max Maximum of both channels since the last reset, in dBTP.
 * @property {number} blockLeft Left true peak of the most recent block, in dBTP.
 * @property {number} blockRight Right true peak of the most recent block, in dBTP.
 */

/**
 * @typedef {object} TruePeakState
 * @property {'truePeak'} kind
 * @property {number} sampleRate
 * @property {number[]} history
 * @property {number} position
 * @property {number[]} peaks
 */

/**
 * @typedef {object} TruePeakMeter
 * @property {(left: Samples, right?: Samples) => void} process Processes one block (any length);
 *   without `right` the left samples feed both channels.
 * @property {() => TruePeakReading} read
 * @property {() => void} reset
 * @property {() => TruePeakState} getState
 * @property {(state: unknown) => void} setState
 * @property {number} factor Oversampling factor in use (1, 2 or 4).
 * @property {readonly (Float64Array | Int32Array)[]} buffers Preallocated internal buffers.
 */

/**
 * Creates a stereo true-peak meter.
 * @param {{ sampleRate: number }} options
 * @returns {TruePeakMeter}
 */
export function createTruePeakMeter(options) {
  const sampleRate = checkSampleRate(options.sampleRate);
  const factor = oversamplingFactor(sampleRate);
  const taps = new Float64Array(4 * TRUE_PEAK_TAPS_PER_PHASE);
  for (let k = 0; k < 4; k++) {
    for (let j = 0; j < TRUE_PEAK_TAPS_PER_PHASE; j++) {
      taps[k * TRUE_PEAK_TAPS_PER_PHASE + j] = TRUE_PEAK_PHASES[k][j];
    }
  }
  // Offsets into `taps` of the phases in use: 4× → 0, 1, 2, 3; 2× → 0, 2; 1× → none.
  const phaseOffsets = new Int32Array(factor === 1 ? 0 : factor);
  for (let p = 0; p < phaseOffsets.length; p++) {
    phaseOffsets[p] = (p * 4 * TRUE_PEAK_TAPS_PER_PHASE) / factor;
  }
  const phaseCount = phaseOffsets.length;
  // Doubled 12-sample delay lines: left in [0, 24), right in [24, 48).
  const history = new Float64Array(48);
  // [max left, max right, block left, block right] as linear magnitudes.
  const peaks = new Float64Array(4);
  let position = 0;
  const buffers = Object.freeze([taps, phaseOffsets, history, peaks]);

  /**
   * @param {Samples} left
   * @param {Samples} [right]
   */
  function process(left, right) {
    const n = blockLength(left, right);
    const r = right === undefined ? left : right;
    let p = position;
    let pl = 0;
    let pr = 0;
    for (let i = 0; i < n; i++) {
      const xl = left[i];
      const xr = r[i];
      history[p] = xl;
      history[p + 12] = xl;
      history[p + 24] = xr;
      history[p + 36] = xr;
      const al = xl < 0 ? -xl : xl;
      const ar = xr < 0 ? -xr : xr;
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
      for (let q = 0; q < phaseCount; q++) {
        const base = phaseOffsets[q];
        let yl = 0;
        let yr = 0;
        // x[n − j] sits at history[p + 12 − j] (left) and history[p + 36 − j] (right).
        for (let j = 0; j < 12; j++) {
          const c = taps[base + j];
          yl += c * history[p + 12 - j];
          yr += c * history[p + 36 - j];
        }
        if (yl < 0) yl = -yl;
        if (yr < 0) yr = -yr;
        if (yl > pl) pl = yl;
        if (yr > pr) pr = yr;
      }
      p = p === 11 ? 0 : p + 1;
    }
    position = p;
    peaks[2] = pl;
    peaks[3] = pr;
    if (pl > peaks[0]) peaks[0] = pl;
    if (pr > peaks[1]) peaks[1] = pr;
  }

  return {
    process,
    read() {
      return {
        left: amplitudeToDb(peaks[0]),
        right: amplitudeToDb(peaks[1]),
        max: amplitudeToDb(peaks[0] > peaks[1] ? peaks[0] : peaks[1]),
        blockLeft: amplitudeToDb(peaks[2]),
        blockRight: amplitudeToDb(peaks[3]),
      };
    },
    reset() {
      history.fill(0);
      peaks.fill(0);
      position = 0;
    },
    getState() {
      return {
        kind: 'truePeak',
        sampleRate,
        history: Array.from(history),
        position,
        peaks: Array.from(peaks),
      };
    },
    setState(state) {
      const record = checkState(state, 'truePeak', sampleRate);
      const nextHistory = readArray(record.history, history.length, 'true-peak history');
      const nextPeaks = readArray(record.peaks, peaks.length, 'true-peak peaks');
      const nextPosition = readInteger(record.position, 0, 11, 'true-peak position');
      history.set(nextHistory);
      peaks.set(nextPeaks);
      position = nextPosition;
    },
    factor,
    buffers,
  };
}
