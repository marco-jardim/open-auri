#!/usr/bin/env node
// SPDX-License-Identifier: CC0-1.0
// Original synthesis, scores and output audio dedicated to the public domain under CC0 1.0.
// Node >= 22; no dependencies. Importing this module never writes files.
// Usage: node tools/gen-preview-audio.mjs web/static/audio/preview [--only rock] [--short]

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{'pt-BR': string, 'en-US': string}} LocalizedTitle
 * @typedef {Float64Array[]} Channels
 * @typedef {{sampleRate?: number}} SampleOptions
 * @typedef {{oversample?: number, radius?: number}} PeakOptions
 * @typedef {{sampleRate?: number, targetLufs?: number, ceilingDb?: number}} MasterOptions
 * @typedef {{sampleRate?: number, seed?: number, lowHz?: number, highHz?: number,
 *   rmsDb?: number}} NoiseOptions
 * @typedef {{sampleRate?: number, startHz?: number, endHz?: number, rmsDb?: number}} SweepOptions
 * @typedef {{sampleRate?: number, frequency?: number, rmsDb?: number}} SineOptions
 * @typedef {{sampleRate?: number, seed?: number, timeScale?: number}} SignalRenderOptions
 * @typedef {{sampleRate?: number, seed?: number, bars?: number}} GenreRenderOptions
 * @typedef {{sampleRate?: number, wet?: number}} ReverbOptions
 * @typedef {{seed?: number, short?: boolean}} ManifestOptions
 * @typedef {{sampleRate?: number, duration?: number, frequency?: number, seed?: number,
 *   open?: boolean, sub?: number, cutoff?: number, attack?: number,
 *   distorted?: boolean}} VoiceOptions
 * @typedef {(options?: VoiceOptions) => Float64Array} Voice
 * @typedef {'kick'|'snare'|'clap'|'hat'|'bass'|'pad'|'lead'|'guitar'|'rim'|'cowbell'} VoiceName
 * @typedef {{id: string, bpm: number, bars: number, title: LocalizedTitle}} Genre
 * @typedef {'silence'|'sine'|'sweep'|'octave-noise'|'pink-noise'|'phase'|'music'} SectionKind
 * @typedef {{frequencyHz?: number, centerHz?: number, lowHz?: number, highHz?: number,
 *   startHz?: number, endHz?: number, rmsDbfs?: number, rightPolarity?: number}} SectionDetails
 * @typedef {SectionDetails & {id: string, title: LocalizedTitle, start: number,
 *   end: number, kind: SectionKind}} Section
 * @typedef {{rmsDbfs: number, truePeakDbfs: number, integratedLufs: number|null,
 *   method: string}} Levels
 * @typedef {{id: string, filename: string, title: LocalizedTitle, kind: 'test-signals'|'music',
 *   duration: number, frames: number, sampleRate: number, sections: Section[], levels: Levels,
 *   bpm?: number, bars?: number, beatsPerBar?: number, boundaryFadeSeconds?: number,
 *   bytes?: number}} FileMetadata
 * @typedef {FileMetadata & {bpm: number, bars: number, beatsPerBar: number}} GenreMetadata
 * @typedef {{channels: Channels, metadata: FileMetadata}} SignalRender
 * @typedef {{channels: Channels, metadata: GenreMetadata}} GenreRender
 * @typedef {{version: number, license: string, licenseUrl: string, sampleRate: number,
 *   bitsPerSample: number, channels: number, seed: number, short: boolean,
 *   files: FileMetadata[]}} Manifest
 * @typedef {{b0: number, b1: number, b2: number, a1: number, a2: number}} Biquad
 * @typedef {{real: Float64Array, imaginary: Float64Array}} Spectrum
 */

export const SAMPLE_RATE = 48000;
export const SEED = 0x41555249;
export const PEAK_DBFS = -1.2; // 0.2 dB reconstruction/quantization margin below the -1 dBFS limit.
export const OCTAVE_CENTERS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const TAU = 2 * Math.PI;
const FADE_SECONDS = 0.075;
/**
 * @param {string} pt
 * @param {string} en
 * @returns {LocalizedTitle}
 */
const title = (pt, en) => ({ 'pt-BR': pt, 'en-US': en });

/** @type {Genre[]} */
export const GENRES = [
  { id: 'rock', bpm: 112, bars: 8, title: title('Rock', 'Rock') },
  { id: 'pop', bpm: 108, bars: 8, title: title('Pop', 'Pop') },
  { id: 'country', bpm: 104, bars: 8, title: title('Country', 'Country') },
  { id: 'percussion', bpm: 100, bars: 8, title: title('Percussão', 'Percussion') },
  { id: 'electronic', bpm: 120, bars: 8, title: title('Eletrônica', 'Electronic') },
  { id: 'hiphop', bpm: 88, bars: 8, title: title('Hip hop', 'Hip hop') },
  { id: 'funk', bpm: 130, bars: 12, title: title('Funk brasileiro', 'Brazilian funk') },
  { id: 'worship', bpm: 82, bars: 8, title: title('Worship / adoração', 'Worship') },
];

/**
 * Mulberry32: all randomness is local to a render, never Math.random().
 * @param {number} [seed]
 * @returns {() => number}
 */
export function createRng(seed = SEED) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} db
 * @returns {number}
 */
export const dbToGain = (db) => 10 ** (db / 20);
/**
 * @param {number} gain
 * @returns {number}
 */
export const gainToDb = (gain) => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);

/**
 * @param {number} duration
 * @param {number} sampleRate
 * @returns {number}
 */
function frameCount(duration, sampleRate) {
  if (!(duration > 0) || !Number.isFinite(duration)) throw new RangeError('Invalid duration');
  if (!Number.isInteger(sampleRate) || sampleRate < 1000) {
    throw new RangeError('Invalid sample rate');
  }
  return Math.max(1, Math.round(duration * sampleRate));
}

/**
 * Channels are equally sized Float64Arrays; RMS is per channel, not a sum.
 * @param {Channels} channels
 * @returns {number}
 */
export function rms(channels) {
  let energy = 0;
  let count = 0;
  for (const channel of channels) {
    for (const value of channel) energy += value * value;
    count += channel.length;
  }
  return count ? Math.sqrt(energy / count) : 0;
}

/**
 * @param {Channels} channels
 * @returns {number}
 */
export function samplePeak(channels) {
  let peak = 0;
  for (const channel of channels) {
    for (const value of channel) peak = Math.max(peak, Math.abs(value));
  }
  return peak;
}

/**
 * Windowed-sinc reconstruction peak estimate (4x, 24 taps by default), including edge ringing.
 * Not a certified BS.1770 meter. Mastering leaves an additional 0.2 dB of headroom; tests also
 * inspect 8x reconstruction. Coefficients are normalized for unity DC gain at every phase.
 * @param {Channels} channels
 * @param {PeakOptions} [options]
 * @returns {number}
 */
export function truePeak(channels, { oversample = 4, radius = 12 } = {}) {
  if (!Number.isInteger(oversample) || oversample < 2) throw new RangeError('Invalid oversample');
  if (!Number.isInteger(radius) || radius < 2) throw new RangeError('Invalid radius');
  let peak = samplePeak(channels);
  for (let phase = 1; phase < oversample; phase++) {
    /** @type {number[]} */
    const coefficients = [];
    let sum = 0;
    for (let tap = -radius + 1; tap <= radius; tap++) {
      const x = phase / oversample - tap;
      const window = 0.42 + 0.5 * Math.cos((Math.PI * x) / radius);
      const blackman = window + 0.08 * Math.cos((TAU * x) / radius);
      const coefficient = (Math.sin(Math.PI * x) / (Math.PI * x)) * blackman;
      coefficients.push(coefficient);
      sum += coefficient;
    }
    for (let tap = 0; tap < coefficients.length; tap++) coefficients[tap] /= sum;
    for (const channel of channels) {
      for (let i = -radius; i < channel.length + radius; i++) {
        let value = 0;
        for (let tap = 0; tap < coefficients.length; tap++) {
          const index = i + tap - radius + 1;
          if (index >= 0 && index < channel.length) value += channel[index] * coefficients[tap];
        }
        peak = Math.max(peak, Math.abs(value));
      }
    }
  }
  return peak;
}

/**
 * Raised-cosine edges, including exact zero at both endpoints. Returns a new array.
 * @param {Float64Array} samples
 * @param {number} [sampleRate]
 * @param {number} [seconds]
 * @returns {Float64Array}
 */
export function fade(samples, sampleRate = SAMPLE_RATE, seconds = FADE_SECONDS) {
  const result = samples.slice();
  const length = Math.min(Math.round(seconds * sampleRate), Math.floor(result.length / 2));
  for (let i = 0; i < length; i++) {
    const gain = length > 1 ? 0.5 - 0.5 * Math.cos((Math.PI * i) / (length - 1)) : 0;
    result[i] = gain === 0 ? 0 : result[i] * gain;
    result[result.length - 1 - i] = gain === 0 ? 0 : result[result.length - 1 - i] * gain;
  }
  return result;
}

/**
 * @param {Float64Array} samples
 * @param {number} targetDb
 * @returns {Float64Array}
 */
function normalizeMono(samples, targetDb) {
  const level = rms([samples]);
  const gain = level ? dbToGain(targetDb) / level : 1;
  return samples.map((value) => value * gain);
}

/**
 * @param {Channels} channels
 * @param {number} [ceilingDb]
 * @returns {Channels}
 */
export function constrainPeak(channels, ceilingDb = PEAK_DBFS) {
  const peak = truePeak(channels);
  const gain = peak ? Math.min(1, dbToGain(ceilingDb) / peak) : 1;
  return channels.map((channel) => channel.map((value) => value * gain));
}

/**
 * Direct-form II transposed biquad; each call starts with zero state.
 * @param {Float64Array} samples
 * @param {Biquad} coefficients
 * @returns {Float64Array}
 */
export function biquad(samples, { b0, b1, b2, a1, a2 }) {
  let z1 = 0;
  let z2 = 0;
  return samples.map((value) => {
    const output = b0 * value + z1;
    z1 = b1 * value - a1 * output + z2;
    z2 = b2 * value - a2 * output;
    return output;
  });
}

/**
 * ITU-R BS.1770-4, Annex 1, Tables 1/2, exactly at the production rate.
 * Other rates use the corresponding bilinear/prewarped filter design for diagnostic renders.
 * @param {number} [sampleRate]
 * @returns {[Biquad, Biquad]}
 */
export function kWeightingCoefficients(sampleRate = SAMPLE_RATE) {
  if (sampleRate === SAMPLE_RATE) {
    return [
      {
        b0: 1.53512485958697,
        b1: -2.69169618940638,
        b2: 1.19839281085285,
        a1: -1.69065929318241,
        a2: 0.73248077421585,
      },
      { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 },
    ];
  }
  if (!(sampleRate >= 8000)) throw new RangeError('K-weighting requires at least 8 kHz');
  const k = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  const q = 0.7071752369554196;
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  const denominator = 1 + k / q + k * k;
  const shelf = {
    b0: (vh + (vb * k) / q + k * k) / denominator,
    b1: (2 * (k * k - vh)) / denominator,
    b2: (vh - (vb * k) / q + k * k) / denominator,
    a1: (2 * (k * k - 1)) / denominator,
    a2: (1 - k / q + k * k) / denominator,
  };
  const kh = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  const qh = 0.5003270373238773;
  const dh = 1 + kh / qh + kh * kh;
  return [
    shelf,
    {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: (2 * (kh * kh - 1)) / dh,
      a2: (1 - kh / qh + kh * kh) / dh,
    },
  ];
}

/**
 * Stereo BS.1770 integrated LUFS: K-weighting, 400 ms blocks/100 ms hops, -70 LUFS absolute
 * gate, then a -10 LU relative gate. Stereo channel powers SUM (both channel weights are 1).
 * No complete block or no block above the absolute gate means -Infinity, not a fabricated LUFS.
 * @param {Channels} channels
 * @param {SampleOptions} [options]
 * @returns {number}
 */
export function integratedLoudness(channels, { sampleRate = SAMPLE_RATE } = {}) {
  if (channels.length !== 2 || channels[0].length !== channels[1].length) {
    throw new RangeError('Loudness requires equal-length stereo channels');
  }
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const length = channels[0].length;
  if (length < block) return -Infinity;
  const [shelf, highPass] = kWeightingCoefficients(sampleRate);
  const energy = new Float64Array(length);
  for (const channel of channels) {
    const weighted = biquad(biquad(channel, shelf), highPass);
    for (let i = 0; i < length; i++) energy[i] += weighted[i] ** 2;
  }
  const prefix = new Float64Array(length + 1);
  for (let i = 0; i < length; i++) prefix[i + 1] = prefix[i] + energy[i];
  const absolute = 10 ** ((-70 + 0.691) / 10);
  /** @type {number[]} */
  const blocks = [];
  for (let start = 0; start + block <= length; start += hop) {
    const power = (prefix[start + block] - prefix[start]) / block;
    if (power >= absolute) blocks.push(power);
  }
  if (!blocks.length) return -Infinity;
  const relative = (blocks.reduce((sum, power) => sum + power, 0) / blocks.length) * 0.1;
  const gated = blocks.filter((power) => power >= relative);
  return -0.691 + 10 * Math.log10(gated.reduce((sum, power) => sum + power, 0) / gated.length);
}

/**
 * Loudness-normalize with an iterative stereo-linked soft knee. Re-meter AFTER limiting,
 * rather than silently missing the LUFS target when peak control removes energy. Reconstruction
 * overshoot tightens the limiter ceiling and triggers another loudness pass, not just attenuation.
 * @param {Channels} channels
 * @param {MasterOptions} [options]
 * @returns {Channels}
 */
export function master(
  channels,
  { sampleRate = SAMPLE_RATE, targetLufs = -16, ceilingDb = PEAK_DBFS } = {},
) {
  const level = integratedLoudness(channels, { sampleRate });
  if (!Number.isFinite(level)) return constrainPeak(channels, ceilingDb);
  let gain = dbToGain(targetLufs - level);
  let ceiling = dbToGain(ceilingDb - 0.4);
  /** @type {Channels} */
  let result = channels;
  for (let attempt = 0; attempt < 5; attempt++) {
    const knee = ceiling * 0.65;
    let measured = -Infinity;
    for (let pass = 0; pass < 16; pass++) {
      result = channels.map((channel) => channel.map((value) => value * gain));
      for (let i = 0; i < result[0].length; i++) {
        const peak = Math.max(Math.abs(result[0][i]), Math.abs(result[1][i]));
        if (peak <= knee) continue;
        const limited = knee + (ceiling - knee) * Math.tanh((peak - knee) / (ceiling - knee));
        for (const channel of result) channel[i] *= limited / peak;
      }
      measured = integratedLoudness(result, { sampleRate });
      const difference = targetLufs - measured;
      if (Math.abs(difference) < 0.025) break;
      gain *= dbToGain(Math.max(-6, Math.min(6, difference)));
    }
    const peak = truePeak(result);
    if (peak <= dbToGain(ceilingDb) && Math.abs(measured - targetLufs) <= 0.25) return result;
    if (peak > dbToGain(ceilingDb)) ceiling *= (dbToGain(ceilingDb) / peak) * 0.98;
  }
  const output = constrainPeak(result, ceilingDb);
  if (Math.abs(integratedLoudness(output, { sampleRate }) - targetLufs) > 0.25) {
    throw new Error('Cannot meet loudness and true-peak targets together');
  }
  return output;
}

/**
 * Radix-2, in-place complex FFT; inverse includes 1/N scaling.
 * @param {Float64Array} real
 * @param {Float64Array} imaginary
 * @param {boolean} [inverse]
 * @returns {void}
 */
export function fft(real, imaginary, inverse = false) {
  const n = real.length;
  if (n < 2 || (n & (n - 1)) !== 0 || imaginary.length !== n) {
    throw new RangeError('FFT requires equal power-of-two arrays');
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = ((inverse ? 1 : -1) * TAU) / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let base = 0; base < n; base += size) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < size / 2; j++) {
        const a = base + j;
        const b = a + size / 2;
        const tr = wr * real[b] - wi * imaginary[b];
        const ti = wr * imaginary[b] + wi * real[b];
        real[b] = real[a] - tr;
        imaginary[b] = imaginary[a] - ti;
        real[a] += tr;
        imaginary[a] += ti;
        const next = wr * stepReal - wi * stepImaginary;
        wi = wr * stepImaginary + wi * stepReal;
        wr = next;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imaginary[i] /= n;
    }
  }
}

/** @type {ReadonlyArray<readonly [number, number]>} */
export const ANALYSIS_BANDS = [
  [20, 120],
  [120, 500],
  [500, 2000],
  [2000, 6000],
  [6000, 20000],
];

/**
 * RBJ constant-peak band-pass / Butterworth low- and high-pass coefficients.
 * @param {'lowpass'|'highpass'|'bandpass'} type
 * @param {number} frequency
 * @param {number} [sampleRate]
 * @param {number} [q]
 * @returns {Biquad}
 */
export function filterCoefficients(type, frequency, sampleRate = SAMPLE_RATE, q = Math.SQRT1_2) {
  const omega = (TAU * Math.min(frequency, sampleRate * 0.49)) / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = type === 'bandpass' ? alpha : (1 + (type === 'highpass' ? cosine : -cosine)) / 2;
  return {
    b0: b0 / a0,
    b1: type === 'bandpass' ? 0 : ((type === 'highpass' ? -2 : 2) * b0) / a0,
    b2: (type === 'bandpass' ? -b0 : b0) / a0,
    a1: (-2 * cosine) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Five band RMS values in dBFS, using cascaded biquad high-/low-pass band edges (24 dB/oct).
 * These are diagnostic bands, not additional filters in the music signal path.
 * @param {Channels} channels
 * @param {SampleOptions} [options]
 * @returns {number[]}
 */
export function spectralBandLevels(channels, { sampleRate = SAMPLE_RATE } = {}) {
  return ANALYSIS_BANDS.map(([low, high]) => {
    if (low >= sampleRate * 0.49) return -Infinity;
    const hp = filterCoefficients('highpass', low, sampleRate);
    const lp = filterCoefficients('lowpass', high, sampleRate);
    const filtered = channels.map((channel) => {
      let result = channel;
      for (let polePair = 0; polePair < 2; polePair++) result = biquad(biquad(result, hp), lp);
      return result;
    });
    return gainToDb(rms(filtered));
  });
}

/**
 * @param {number} frequency
 * @returns {number}
 */
function analysisBand(frequency) {
  if (frequency < 20 || frequency >= 20000) return -1;
  if (frequency < 120) return 0;
  if (frequency < 500) return 1;
  if (frequency < 2000) return 2;
  return frequency < 6000 ? 3 : 4;
}

/**
 * Broad, stereo-linked mastering EQ guard, not a noise overlay. Only existing instrument
 * energy is adjusted. Smooth 0.24-octave crossovers avoid brick-wall EQ ringing. Three small
 * corrections allow crossover spill; the arrangement remains the source of each band's timbre.
 * Targets leave 5–6 dB margin inside the presence/air diagnostic bounds (-14/-18 dB vs low mids).
 * @param {Channels} channels
 * @param {SampleOptions} [options]
 * @returns {Channels}
 */
export function balanceSpectrum(channels, { sampleRate = SAMPLE_RATE } = {}) {
  // Reduced-rate timing fixtures have no 6–20 kHz band; never pretend they do.
  if (sampleRate < 44100) return channels.map((channel) => channel.slice());
  const length = channels[0].length;
  let n = 2;
  while (n < length) n *= 2;
  /** @type {Spectrum[]} */
  const spectra = channels.map((channel) => {
    const real = new Float64Array(n);
    const imaginary = new Float64Array(n);
    real.set(channel);
    fft(real, imaginary);
    return { real, imaginary };
  });
  const lower = [-10, 0, -6, -9, -12];
  const upper = [1, 0, -1, -5, -8];
  for (let pass = 0; pass < 3; pass++) {
    const powers = new Float64Array(5);
    for (let bin = 1; bin <= n / 2; bin++) {
      const band = analysisBand((bin * sampleRate) / n);
      if (band < 0) continue;
      for (const spectrum of spectra) {
        powers[band] += spectrum.real[bin] ** 2 + spectrum.imaginary[bin] ** 2;
      }
    }
    if (powers[1] === 0) break;
    const corrections = powers.map((power, index) => {
      const relative = 10 * Math.log10(Math.max(power, 1e-30) / powers[1]);
      const desired = Math.max(lower[index], Math.min(upper[index], relative));
      return Math.max(-12, Math.min(12, desired - relative));
    });
    for (let bin = 1; bin <= n / 2; bin++) {
      const frequency = (bin * sampleRate) / n;
      const band = analysisBand(frequency);
      if (band < 0) continue;
      let correction = corrections[band];
      for (let edge = 1; edge < ANALYSIS_BANDS.length; edge++) {
        const distance = Math.log2(frequency / ANALYSIS_BANDS[edge][0]);
        if (Math.abs(distance) >= 0.12) continue;
        const weight = 0.5 + 0.5 * Math.sin((Math.PI * distance) / 0.24);
        correction = corrections[edge - 1] * (1 - weight) + corrections[edge] * weight;
      }
      const gain = dbToGain(correction);
      for (const spectrum of spectra) {
        spectrum.real[bin] *= gain;
        spectrum.imaginary[bin] *= gain;
        if (bin < n / 2) {
          spectrum.real[n - bin] *= gain;
          spectrum.imaginary[n - bin] *= gain;
        }
      }
    }
  }
  return spectra.map(({ real, imaginary }) => {
    real[0] = imaginary[0] = 0;
    // Suppress DC/infrasonic content and unused ultrasonic hat energy, with cosine transitions.
    for (let bin = 1; bin <= n / 2; bin++) {
      const frequency = (bin * sampleRate) / n;
      const high = Math.max(0, Math.min(1, (frequency - 20000) / 2000));
      const gain =
        (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, frequency / 20))) *
        (0.5 + 0.5 * Math.cos(Math.PI * high));
      real[bin] *= gain;
      imaginary[bin] *= gain;
      if (bin < n / 2) {
        real[n - bin] *= gain;
        imaginary[n - bin] *= gain;
      }
    }
    fft(real, imaginary, true);
    return real.slice(0, length);
  });
}

/**
 * Pink spectral density (power proportional to 1/f), with conjugate-symmetric random phases.
 * @param {number} duration
 * @param {NoiseOptions} [options]
 * @returns {Float64Array}
 */
export function synthPinkNoise(
  duration,
  { sampleRate = SAMPLE_RATE, seed = SEED, lowHz = 20, highHz = 20000, rmsDb = -20 } = {},
) {
  const length = frameCount(duration, sampleRate);
  const upper = Math.min(highHz, sampleRate * 0.49);
  if (!(lowHz > 0 && lowHz < upper)) throw new RangeError('Invalid noise band');
  let n = 2;
  // Retain useful frequency resolution even for diagnostic renders shorter than an octave cycle.
  while (n < Math.max(length, (4 * sampleRate) / lowHz)) n *= 2;
  const real = new Float64Array(n);
  const imaginary = new Float64Array(n);
  const random = createRng(seed);
  for (let bin = 1; bin < n / 2; bin++) {
    const frequency = (bin * sampleRate) / n;
    if (frequency < lowHz || frequency > upper) continue;
    // Small in-band edge taper reduces ringing without widening the requested octave.
    const edge = Math.min(frequency - lowHz, upper - frequency) / ((upper - lowHz) * 0.08);
    const amplitude = Math.sin((Math.PI / 2) * Math.min(1, edge)) / Math.sqrt(frequency);
    const phase = TAU * random();
    real[bin] = real[n - bin] = amplitude * Math.cos(phase);
    imaginary[bin] = amplitude * Math.sin(phase);
    imaginary[n - bin] = -imaginary[bin];
  }
  fft(real, imaginary, true);
  return normalizeMono(fade(real.slice(0, length), sampleRate), rmsDb);
}

/**
 * An octave-wide, spectrally band-passed pink burst, normalized after the 75 ms fades.
 * @param {number} centerHz
 * @param {number} duration
 * @param {NoiseOptions} [options]
 * @returns {Float64Array}
 */
export function synthOctaveNoise(centerHz, duration, options = {}) {
  return synthPinkNoise(duration, {
    ...options,
    lowHz: centerHz / Math.SQRT2,
    highHz: centerHz * Math.SQRT2,
    rmsDb: options.rmsDb ?? -20,
  });
}

/**
 * @param {number} time
 * @param {number} duration
 * @param {number} [startHz]
 * @param {number} [endHz]
 * @returns {number}
 */
export function sweepFrequencyAt(time, duration, startHz = 20, endHz = 20000) {
  return startHz * (endHz / startHz) ** (time / duration);
}

/**
 * @param {number} time
 * @param {number} duration
 * @param {number} [startHz]
 * @param {number} [endHz]
 * @returns {number}
 */
export function sweepPhaseAt(time, duration, startHz = 20, endHz = 20000) {
  const rate = Math.log(endHz / startHz) / duration;
  return rate === 0 ? TAU * startHz * time : (TAU * startHz * Math.expm1(rate * time)) / rate;
}

/**
 * @param {number} duration
 * @param {SweepOptions} [options]
 * @returns {Float64Array}
 */
export function synthSweep(
  duration,
  { sampleRate = SAMPLE_RATE, startHz = 20, endHz = 20000, rmsDb = -18 } = {},
) {
  if (!(startHz > 0 && endHz >= startHz && endHz < sampleRate / 2)) {
    throw new RangeError('Invalid sweep frequencies');
  }
  const samples = new Float64Array(frameCount(duration, sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin(sweepPhaseAt(i / sampleRate, duration, startHz, endHz));
  }
  return normalizeMono(fade(samples, sampleRate), rmsDb);
}

/**
 * @param {number} duration
 * @param {SineOptions} [options]
 * @returns {Float64Array}
 */
export function synthSine(
  duration,
  { sampleRate = SAMPLE_RATE, frequency = 1000, rmsDb = -18 } = {},
) {
  const samples = new Float64Array(frameCount(duration, sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((TAU * frequency * i) / sampleRate);
  }
  return normalizeMono(fade(samples, sampleRate), rmsDb);
}

/**
 * One-pole low-pass, used for instrument timbre rather than the analytical octave bands.
 * @param {Float64Array} samples
 * @param {number} cutoff
 * @param {number} [sampleRate]
 * @returns {Float64Array}
 */
export function lowPass(samples, cutoff, sampleRate = SAMPLE_RATE) {
  const coefficient = 1 - Math.exp((-TAU * Math.min(cutoff, sampleRate * 0.45)) / sampleRate);
  let state = 0;
  return samples.map((value) => {
    state += coefficient * (value - state);
    return state;
  });
}

/**
 * @param {number} time
 * @param {number} duration
 * @param {number} attack
 * @param {number} decay
 * @param {number} sustain
 * @param {number} release
 * @returns {number}
 */
function adsr(time, duration, attack, decay, sustain, release) {
  const on =
    time < attack ? time / attack : sustain + (1 - sustain) * Math.exp(-(time - attack) / decay);
  const off = Math.min(1, Math.max(0, (duration - time) / release));
  return on * off;
}

// PolyBLEP keeps the saw/pulse discontinuities from aliasing into the comparison material.
/**
 * @param {number} phase
 * @param {number} step
 * @returns {number}
 */
function polyBlep(phase, step) {
  if (phase < step) {
    const t = phase / step;
    return t + t - t * t - 1;
  }
  if (phase > 1 - step) {
    const t = (phase - 1) / step;
    return t * t + t + t + 1;
  }
  return 0;
}

/**
 * @param {number} phase
 * @param {number} step
 * @returns {number}
 */
function saw(phase, step) {
  return 2 * phase - 1 - polyBlep(phase, step);
}

/**
 * @param {VoiceOptions} options
 * @param {number} defaultDuration
 * @returns {{sampleRate: number, duration: number, samples: Float64Array}}
 */
function voiceBuffer(options, defaultDuration) {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const duration = options.duration ?? defaultDuration;
  return { sampleRate, duration, samples: new Float64Array(frameCount(duration, sampleRate)) };
}

/**
 * @param {VoiceOptions} [options]
 * @returns {Float64Array}
 */
export function synthKick(options = {}) {
  const { sampleRate, duration, samples } = voiceBuffer(options, 0.5);
  const frequency = options.frequency ?? 46;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    const phase = TAU * (frequency * t + 120 * 0.022 * (1 - Math.exp(-t / 0.022)));
    samples[i] = Math.sin(phase) * Math.exp(-t / 0.16) * Math.min(1, t / 0.002);
  }
  return fade(samples, sampleRate, Math.min(0.006, duration / 4));
}

/**
 * @param {VoiceOptions} [options]
 * @returns {Float64Array}
 */
export function synthSnare(options = {}) {
  const { sampleRate, samples } = voiceBuffer(options, 0.27);
  const random = createRng(options.seed);
  let smooth = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    const noise = 2 * random() - 1;
    smooth += 0.2 * (noise - smooth);
    samples[i] =
      0.75 * (noise - smooth) * Math.exp(-t / 0.065) +
      0.35 * Math.sin(TAU * 185 * t) * Math.exp(-t / 0.045);
  }
  const crack = biquad(samples, filterCoefficients('bandpass', 3000, sampleRate, 0.9));
  return fade(
    samples.map((value, i) => 0.7 * value + 1.5 * crack[i]),
    sampleRate,
    0.003,
  );
}

/**
 * @param {VoiceOptions} [options]
 * @returns {Float64Array}
 */
export function synthClap(options = {}) {
  const { sampleRate, samples } = voiceBuffer(options, 0.3);
  const random = createRng(options.seed);
  let smooth = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    const noise = 2 * random() - 1;
    smooth += 0.15 * (noise - smooth);
    let envelope = 0.25 * Math.exp(-t / 0.09);
    for (const onset of [0, 0.012, 0.025]) {
      if (t >= onset) envelope += Math.exp(-(t - onset) / 0.012);
    }
    samples[i] = 0.4 * (noise - smooth) * envelope + 0.08 * Math.sin(TAU * 430 * t) * envelope;
  }
  const crack = biquad(samples, filterCoefficients('bandpass', 3400, sampleRate, 0.8));
  return fade(
    samples.map((value, i) => 0.7 * value + 1.4 * crack[i]),
    sampleRate,
    0.003,
  );
}

/**
 * @param {VoiceOptions} [options]
 * @returns {Float64Array}
 */
export function synthHat(options = {}) {
  const { sampleRate, samples } = voiceBuffer(options, options.open ? 0.32 : 0.09);
  const random = createRng(options.seed);
  for (let i = 0; i < samples.length; i++) {
    const noise = 2 * random() - 1;
    samples[i] = noise * Math.exp(-i / sampleRate / (options.open ? 0.14 : 0.04));
  }
  const bright = biquad(samples, filterCoefficients('highpass', sampleRate * 0.095, sampleRate));
  return fade(lowPass(bright, 18000, sampleRate), sampleRate, 0.002);
}

/**
 * @param {VoiceOptions} [options]
 * @returns {Float64Array}
 */
export function synthBass(options = {}) {
  const { sampleRate, duration, samples } = voiceBuffer(options, 0.5);
  const frequency = options.frequency ?? 55;
  const step = frequency / sampleRate;
  for (let i = 0; i < samples.length; i++) {
    const phase = (i * step) % 1;
    const pulse = saw(phase, step) - saw((phase + 0.5) % 1, step);
    const sub = options.sub ?? 0.3;
    samples[i] =
      ((1 - sub) * pulse * 0.5 + sub * Math.sin(TAU * phase)) *
      adsr(i / sampleRate, duration, 0.008, 0.09, 0.7, 0.06);
  }
  return fade(lowPass(samples, options.cutoff ?? 850, sampleRate), sampleRate, 0.005);
}

/**
 * @param {VoiceOptions} [options]
 * @returns {Float64Array}
 */
export function synthPad(options = {}) {
  const { sampleRate, duration, samples } = voiceBuffer(options, 2.5);
  const frequency = options.frequency ?? 220;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    let value = 0;
    for (const detune of [0.996, 1, 1.004]) {
      const step = (frequency * detune) / sampleRate;
      value += saw((i * step) % 1, step) / 3;
    }
    samples[i] = value * adsr(t, duration, options.attack ?? 0.15, 0.3, 0.65, 0.45);
  }
  return fade(lowPass(samples, options.cutoff ?? 2400, sampleRate), sampleRate, 0.008);
}

/**
 * @param {VoiceOptions} [options]
 * @returns {Float64Array}
 */
export function synthLead(options = {}) {
  const { sampleRate, duration, samples } = voiceBuffer(options, 0.35);
  const frequency = options.frequency ?? 440;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    const modulation = 2.4 * Math.exp(-t / 0.2) * Math.sin(TAU * frequency * 2 * t);
    samples[i] =
      Math.sin(TAU * frequency * t + modulation) * adsr(t, duration, 0.006, 0.1, 0.4, 0.07);
  }
  return fade(lowPass(samples, 7000, sampleRate), sampleRate, 0.004);
}

/**
 * Karplus–Strong pluck: a seeded excitation circulating through a damped delay line.
 * @param {VoiceOptions} [options]
 * @returns {Float64Array}
 */
export function synthGuitar(options = {}) {
  const { sampleRate, duration, samples } = voiceBuffer(options, 1.8);
  const frequency = options.frequency ?? 196;
  const delay = Math.max(2, Math.round(sampleRate / frequency - 0.5));
  const line = new Float64Array(delay);
  const random = createRng(options.seed);
  for (let i = 0; i < delay; i++) line[i] = 2 * random() - 1;
  let position = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = line[position];
    line[position] = 0.5 * (value + line[(position + 1) % delay]) * 0.992;
    position = (position + 1) % delay;
    samples[i] =
      (options.distorted ? Math.tanh(4 * value) : value) *
      adsr(i / sampleRate, duration, 0.002, 0.3, 0.8, 0.08);
  }
  return fade(lowPass(samples, options.distorted ? 4800 : 8500, sampleRate), sampleRate, 0.003);
}

/**
 * Midrange rim click, with a short noise attack and two inharmonic resonances.
 * @param {VoiceOptions} [options]
 * @returns {Float64Array}
 */
export function synthRim(options = {}) {
  const { sampleRate, samples } = voiceBuffer(options, 0.18);
  const frequency = options.frequency ?? 780;
  const random = createRng(options.seed);
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    samples[i] =
      (0.6 * Math.sin(TAU * frequency * t) + 0.4 * Math.sin(TAU * frequency * 2.31 * t)) *
        Math.exp(-t / 0.035) +
      0.25 * (2 * random() - 1) * Math.exp(-t / 0.006);
  }
  return fade(samples, sampleRate, 0.002);
}

/**
 * Inharmonic bell, adding pitched percussion body/presence rather than more sub.
 * @param {VoiceOptions} [options]
 * @returns {Float64Array}
 */
export function synthCowbell(options = {}) {
  const { sampleRate, samples } = voiceBuffer(options, 0.3);
  const frequency = options.frequency ?? 560;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    samples[i] =
      Math.tanh(2 * (Math.sin(TAU * frequency * t) + 0.7 * Math.sin(TAU * frequency * 1.49 * t))) *
      Math.exp(-t / 0.08);
  }
  return fade(lowPass(samples, 6500, sampleRate), sampleRate, 0.002);
}

/** @type {Record<VoiceName, Voice>} */
export const VOICES = {
  kick: synthKick,
  snare: synthSnare,
  clap: synthClap,
  hat: synthHat,
  bass: synthBass,
  pad: synthPad,
  lead: synthLead,
  guitar: synthGuitar,
  rim: synthRim,
  cowbell: synthCowbell,
};

/**
 * Four damped parallel combs, followed by two serial all-passes, independently per side.
 * @param {Channels} channels
 * @param {ReverbOptions} [options]
 * @returns {Channels}
 */
export function reverb(channels, { sampleRate = SAMPLE_RATE, wet = 0.2 } = {}) {
  return channels.map((input, side) => {
    const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((seconds, index) => ({
      buffer: new Float64Array(Math.round((seconds + side * 0.0013) * sampleRate)),
      position: 0,
      feedback: 0.73 + index * 0.017,
      smooth: 0,
    }));
    const allpasses = [0.005, 0.0017].map((seconds) => ({
      buffer: new Float64Array(Math.max(1, Math.round((seconds + side * 0.0003) * sampleRate))),
      position: 0,
    }));
    const output = new Float64Array(input.length);
    // Warm up from the preceding cyclic input, so loop tails are not simply truncated.
    const warmup = Math.min(input.length, 3 * sampleRate);
    for (let i = -warmup; i < input.length; i++) {
      const dry = input[(i + input.length) % input.length];
      let value = 0;
      for (const comb of combs) {
        const delayed = comb.buffer[comb.position];
        comb.smooth += 0.65 * (delayed - comb.smooth);
        comb.buffer[comb.position] = dry + comb.feedback * comb.smooth;
        comb.position = (comb.position + 1) % comb.buffer.length;
        value += delayed / combs.length;
      }
      for (const allpass of allpasses) {
        const delayed = allpass.buffer[allpass.position];
        const next = delayed - 0.5 * value;
        allpass.buffer[allpass.position] = value + 0.5 * next;
        allpass.position = (allpass.position + 1) % allpass.buffer.length;
        value = next;
      }
      if (i >= 0) output[i] = dry * (1 - wet * 0.3) + wet * value;
    }
    return output;
  });
}

/**
 * @param {Channels} channels
 * @param {number} sampleRate
 * @returns {Levels}
 */
function levels(channels, sampleRate) {
  const integrated = integratedLoudness(channels, { sampleRate });
  return {
    rmsDbfs: gainToDb(rms(channels)),
    truePeakDbfs: gainToDb(truePeak(channels)),
    integratedLufs: Number.isFinite(integrated) ? integrated : null,
    method: 'BS.1770-4 gated integrated LUFS; per-channel RMS; 4x, 24-tap sinc true peak',
  };
}

/**
 * timeScale is a diagnostic/test option; the production timeline is exactly 62 seconds.
 * @param {SignalRenderOptions} [options]
 * @returns {SignalRender}
 */
export function renderTestSignals({ sampleRate = SAMPLE_RATE, seed = SEED, timeScale = 1 } = {}) {
  if (!(timeScale > 0) || !Number.isFinite(timeScale)) throw new RangeError('Invalid time scale');
  /** @type {{samples: Float64Array, invertRight: boolean}[]} */
  const chunks = [];
  /** @type {Section[]} */
  const sections = [];
  let frames = 0;
  /**
   * @param {string} id
   * @param {LocalizedTitle} names
   * @param {SectionKind} kind
   * @param {Float64Array} samples
   * @param {SectionDetails} [extra]
   * @param {boolean} [invertRight]
   * @returns {void}
   */
  function append(id, names, kind, samples, extra = {}, invertRight = false) {
    const start = frames / sampleRate;
    frames += samples.length;
    sections.push({ id, title: names, start, end: frames / sampleRate, kind, ...extra });
    chunks.push({ samples, invertRight });
  }
  /**
   * @param {string} id
   * @param {number} seconds
   * @returns {void}
   */
  function gap(id, seconds) {
    append(
      id,
      title('Silêncio', 'Silence'),
      'silence',
      new Float64Array(frameCount(seconds * timeScale, sampleRate)),
    );
  }
  const options = { sampleRate, seed };
  append(
    'reference',
    title('Referência de nível: 1 kHz', 'Level reference: 1 kHz'),
    'sine',
    synthSine(6 * timeScale, options),
    { frequencyHz: 1000, rmsDbfs: -18 },
  );
  gap('after-reference', 1);
  append(
    'sweep',
    title('Varredura: 20 Hz a 20 kHz', 'Sweep: 20 Hz to 20 kHz'),
    'sweep',
    synthSweep(12 * timeScale, options),
    { startHz: 20, endHz: 20000, rmsDbfs: -18 },
  );
  gap('after-sweep', 1);
  for (const centerHz of OCTAVE_CENTERS) {
    append(
      `octave-${centerHz}`,
      title(`Ruído rosa: ${centerHz} Hz`, `Pink noise: ${centerHz} Hz`),
      'octave-noise',
      synthOctaveNoise(centerHz, 2 * timeScale, { ...options, seed: seed + centerHz }),
      { centerHz, lowHz: centerHz / Math.SQRT2, highHz: centerHz * Math.SQRT2, rmsDbfs: -20 },
    );
    gap(`after-octave-${centerHz}`, 0.4);
  }
  append(
    'pink',
    title('Ruído rosa de banda larga', 'Full-band pink noise'),
    'pink-noise',
    synthPinkNoise(8 * timeScale, options),
    { lowHz: 20, highHz: 20000, rmsDbfs: -20 },
  );
  gap('before-phase', 2);
  const phase = synthPinkNoise(4 * timeScale, { ...options, seed: seed ^ 0x50484153 });
  append('in-phase', title('Estéreo: em fase', 'Stereo: in phase'), 'phase', phase, {
    rightPolarity: 1,
    rmsDbfs: -20,
  });
  append(
    'opposite-phase',
    title('Estéreo: canal direito invertido', 'Stereo: right inverted'),
    'phase',
    phase,
    { rightPolarity: -1, rmsDbfs: -20 },
    true,
  );
  const channels = [new Float64Array(frames), new Float64Array(frames)];
  let offset = 0;
  for (const { samples, invertRight } of chunks) {
    channels[0].set(samples, offset);
    for (let i = 0; i < samples.length; i++) {
      channels[1][offset + i] = samples[i] * (invertRight ? -1 : 1);
    }
    offset += samples.length;
  }
  const limited = constrainPeak(channels);
  return {
    channels: limited,
    metadata: {
      id: 'test-signals',
      filename: 'test-signals.wav',
      title: title('Sinais de teste', 'Test signals'),
      kind: 'test-signals',
      duration: frames / sampleRate,
      frames,
      sampleRate,
      sections,
      levels: levels(limited, sampleRate),
    },
  };
}

/**
 * @param {number} note
 * @returns {number}
 */
const midiHz = (note) => 440 * 2 ** ((note - 69) / 12);

/**
 * Original four-chord scores with genre-specific rhythm, voicing and spectral balance.
 * bars can be reduced for tests without changing tempo. Durations are rounded only once,
 * to the nearest sample at a whole-bar boundary (maximum error: half a sample).
 * @param {string} id
 * @param {GenreRenderOptions} [options]
 * @returns {GenreRender}
 */
export function renderGenre(id, { sampleRate = SAMPLE_RATE, seed = SEED, bars } = {}) {
  const genre = GENRES.find((entry) => entry.id === id);
  if (!genre) throw new RangeError(`Unknown genre: ${id}`);
  bars ??= genre.bars;
  if (!Number.isInteger(bars) || bars < 1) throw new RangeError('Invalid bar count');
  const beatSeconds = 60 / genre.bpm;
  const frames = frameCount(bars * 4 * beatSeconds, sampleRate);
  const channels = [new Float64Array(frames), new Float64Array(frames)];
  const random = createRng(
    seed ^ [...id].reduce((hash, char) => Math.imul(hash, 31) + char.charCodeAt(0), 0),
  );
  const subHeavy = id === 'hiphop' || id === 'electronic' || id === 'funk';
  const roots =
    id === 'worship' ? [50, 57, 59, 55] : id === 'country' ? [43, 48, 50, 43] : [45, 48, 43, 50];

  /**
   * @param {VoiceName} voice
   * @param {number} beat
   * @param {number} duration
   * @param {number} midi
   * @param {number} gain
   * @param {number} [pan]
   * @param {VoiceOptions} [extra]
   * @returns {void}
   */
  function note(voice, beat, duration, midi, gain, pan = 0, extra = {}) {
    const sound = VOICES[voice]({
      sampleRate,
      seed: Math.floor(random() * 4294967296),
      frequency: midiHz(midi),
      duration: duration * beatSeconds,
      ...extra,
    });
    const offset = Math.round(beat * beatSeconds * sampleRate);
    const left = Math.cos(((pan + 1) * Math.PI) / 4) * gain;
    const right = Math.sin(((pan + 1) * Math.PI) / 4) * gain;
    // Fold note releases into the beginning of the loop instead of truncating tails.
    for (let i = 0; i < sound.length; i++) {
      const index = (offset + i) % frames;
      channels[0][index] += sound[i] * left;
      channels[1][index] += sound[i] * right;
    }
  }
  /**
   * @param {VoiceName} voice
   * @param {number} beat
   * @param {number} gain
   * @param {number} [pan]
   * @param {VoiceOptions} [extra]
   * @returns {void}
   */
  function drum(voice, beat, gain, pan = 0, extra = {}) {
    const seconds = voice === 'kick' ? 0.48 : voice === 'hat' ? (extra.open ? 0.32 : 0.09) : 0.28;
    note(voice, beat, seconds / beatSeconds, 31, gain, pan, extra);
  }

  for (let bar = 0; bar < bars; bar++) {
    const start = bar * 4;
    const root = roots[bar % roots.length];
    const minor = id !== 'country' && id !== 'worship' && bar % 4 === 0;
    const chord = [root + 12, root + (minor ? 15 : 16), root + 19];
    const sparse = id === 'worship';
    const kicks =
      id === 'electronic'
        ? [0, 1, 2, 3]
        : id === 'funk'
          ? [0, 0.75, 1.5, 2.5, 3.25]
          : id === 'hiphop'
            ? [0, 1.75, 2.5]
            : id === 'country'
              ? [0, 2]
              : [0, 1.5, 2];
    for (const beat of kicks) drum('kick', start + beat, sparse ? 0.45 : 0.7);
    for (const beat of [1, 3]) {
      drum(
        id === 'pop' || id === 'electronic' || id === 'funk' ? 'clap' : 'snare',
        start + beat,
        sparse ? 0.32 : 0.75,
        -0.08,
      );
    }
    const hatStep = id === 'hiphop' || id === 'funk' ? 0.25 : 0.5;
    for (let beat = 0; beat < 4; beat += hatStep) {
      const swing = id === 'hiphop' && (beat * 4) % 2 === 1 ? 0.055 : 0;
      drum(
        'hat',
        start + beat + swing,
        (beat % 1 === 0 ? 0.4 : 0.3) * (sparse ? 0.55 : 1),
        beat % 1 === 0 ? 0.4 : -0.35,
        { open: id === 'electronic' && beat % 1 === 0.5 },
      );
    }

    if (id === 'percussion' || id === 'funk') {
      // Pitched drum voices form a syncopated low/mid/high tamborzão-style answer.
      for (const [beat, pitch, pan] of [
        [0.5, 48, -0.5],
        [1.25, 55, 0.5],
        [2.25, 48, -0.4],
        [3.5, 58, 0.5],
      ]) {
        note('kick', start + beat, 0.38, pitch, 0.5, pan);
      }
      for (const beat of [0.75, 2.75, 3.75]) drum('snare', start + beat, 0.2, 0.45);
      for (const beat of [0.75, 2.25, 3.5]) {
        note('rim', start + beat, 0.3, 79, 0.35, -0.4);
      }
      for (const beat of [0, 1.5, 2.75]) {
        note('cowbell', start + beat, 0.5, 72, id === 'percussion' ? 0.5 : 0.25, 0.45);
      }
      if (id === 'percussion') continue;
    }

    const bassBeats =
      id === 'hiphop' ? [0, 1.75, 2.5] : id === 'funk' ? [0, 0.75, 1.5, 2.5, 3.25] : [0, 1, 2, 3];
    for (let index = 0; index < bassBeats.length; index++) {
      const octave = id === 'hiphop' || id === 'electronic' ? 24 : 12;
      const pitch = root - octave + (id === 'country' && index % 2 === 1 ? 7 : 0);
      note(
        'bass',
        start + bassBeats[index],
        id === 'hiphop' ? 1.1 : 0.7,
        pitch,
        subHeavy ? 0.5 : 0.55,
        0,
        { sub: subHeavy ? 0.8 : 0.25, cutoff: subHeavy ? 240 : 1100 },
      );
    }

    if (id === 'rock') {
      for (const beat of [0, 0.75, 1.5, 2, 2.75, 3.5]) {
        for (const pan of [-0.75, 0.75]) {
          for (const interval of [0, 7]) {
            note('guitar', start + beat + (pan > 0 ? 0.012 : 0), 0.8, root + interval, 0.58, pan, {
              distorted: true,
            });
          }
        }
      }
    } else if (id === 'country' || id === 'worship') {
      for (let eighth = 0; eighth < 8; eighth++) {
        note(
          'guitar',
          start + eighth / 2,
          sparse ? 2.4 : 1.2,
          chord[eighth % chord.length] + (eighth % 4 === 3 ? 12 : 0),
          0.65,
          eighth % 2 ? 0.55 : -0.55,
        );
      }
      if (!sparse) {
        for (const beat of [1, 3]) {
          chord.forEach((pitch, index) =>
            note('guitar', start + beat + index * 0.025, 0.8, pitch, 0.35, -0.25),
          );
        }
      }
    }

    if (id !== 'country' && id !== 'funk') {
      chord.forEach((pitch, index) =>
        note(
          'pad',
          start,
          4.7,
          pitch + (sparse ? 12 : 0),
          sparse ? 0.65 : id === 'rock' ? 0.12 : 0.3,
          (index - 1) * 0.65,
          { attack: sparse ? 0.4 : 0.06, cutoff: sparse ? 6500 : 3500 },
        ),
      );
    }
    if (id === 'pop' || id === 'electronic' || id === 'hiphop' || id === 'funk') {
      for (const [index, beat] of [0.5, 1.25, 2.5, 3.5].entries()) {
        note(
          'lead',
          start + beat,
          0.4,
          chord[(index + bar) % 3] + 24,
          id === 'hiphop' ? 0.3 : 0.4,
          index % 2 ? 0.35 : -0.35,
        );
      }
    }
  }
  const wet = id === 'worship' ? 0.48 : id === 'hiphop' || id === 'funk' ? 0.09 : 0.18;
  const output = master(
    balanceSpectrum(reverb(channels, { sampleRate, wet }), { sampleRate }).map((channel) =>
      fade(channel, sampleRate),
    ),
    { sampleRate },
  );
  /** @type {Section[]} */
  const sections = Array.from({ length: bars }, (_, index) => ({
    id: `bar-${index + 1}`,
    title: title(`Compasso ${index + 1}`, `Bar ${index + 1}`),
    start: Math.round(index * 4 * beatSeconds * sampleRate) / sampleRate,
    end: Math.round((index + 1) * 4 * beatSeconds * sampleRate) / sampleRate,
    kind: 'music',
  }));
  return {
    channels: output,
    metadata: {
      id,
      filename: `genre-${id}.wav`,
      title: genre.title,
      kind: 'music',
      duration: frames / sampleRate,
      frames,
      sampleRate,
      bpm: genre.bpm,
      bars,
      beatsPerBar: 4,
      boundaryFadeSeconds: FADE_SECONDS,
      sections,
      levels: levels(output, sampleRate),
    },
  };
}

/**
 * Encode RIFF/WAVE PCM, 24-bit little-endian, interleaved stereo, with no metadata timestamps.
 * @param {Channels} channels
 * @param {SampleOptions} [options]
 * @returns {Buffer}
 */
export function encodeWav(channels, { sampleRate = SAMPLE_RATE } = {}) {
  if (channels.length !== 2 || channels[0].length !== channels[1].length) {
    throw new RangeError('WAV requires two equal-length channels');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 1000) {
    throw new RangeError('Invalid sample rate');
  }
  const dataBytes = channels[0].length * 6;
  if (dataBytes > 0xffffffff - 36) throw new RangeError('Audio exceeds RIFF size limit');
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 6, 28);
  buffer.writeUInt16LE(6, 32);
  buffer.writeUInt16LE(24, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let i = 0; i < channels[0].length; i++) {
    for (const channel of channels) {
      const value = channel[i];
      if (!Number.isFinite(value) || Math.abs(value) > 1) {
        throw new RangeError('Invalid PCM sample');
      }
      buffer.writeIntLE(Math.round(value * 0x7fffff), offset, 3);
      offset += 3;
    }
  }
  return buffer;
}

/**
 * @param {FileMetadata[]} files
 * @param {ManifestOptions} [options]
 * @returns {Manifest}
 */
export function createManifest(files, { seed = SEED, short = false } = {}) {
  const sampleRate = files[0]?.sampleRate ?? SAMPLE_RATE;
  if (files.some((file) => file.sampleRate !== sampleRate)) {
    throw new RangeError('Manifest sample rates must match');
  }
  return {
    version: 1,
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    sampleRate,
    bitsPerSample: 24,
    channels: 2,
    seed,
    short,
    files,
  };
}

/**
 * @param {Manifest} manifest
 * @returns {string}
 */
export function createReadme(manifest) {
  const tracks = manifest.files.map((file) => {
    const sections = file.sections.map(
      (section) =>
        `  - ${section.start.toFixed(3)}–${section.end.toFixed(3)} s: ${section.title['en-US']} / ${section.title['pt-BR']} (${section.kind})`,
    );
    return [`- **${file.filename}** — ${file.duration.toFixed(3)} s`, ...sections].join('\n');
  });
  return `# Open-auri preview audio / Áudio de prévia

## CC0 1.0

All compositions, performances, test signals and synthesis in this collection are original.
The authors dedicate them to the public domain under **CC0 1.0 Universal** (CC0-1.0):
https://creativecommons.org/publicdomain/zero/1.0/
No samples, recordings, soundfonts, external scores or npm dependencies are used.

## Regenerate

Requires Node.js >= 22, from the repository root:

\`\`\`sh
node tools/gen-preview-audio.mjs web/static/audio/preview
node tools/gen-preview-audio.mjs web/static/audio/preview --only funk
node --test test/tools/gen-preview-audio.test.mjs
\`\`\`

IDs: test-signals, rock, pop, country, percussion, electronic, hiphop, funk, worship.
--only writes just the selected WAV and an inventory for that invocation; it does not delete
older WAVs in the directory. --short produces diagnostic renders (one bar / 8% signal times),
not production previews. The seed is fixed, and there are no timestamps in the outputs.
Byte determinism is intended for the same Node/runtime; transcendental rounding may vary
across JavaScript engines or architectures.

## Format and listening notes

48 kHz, 24-bit PCM stereo WAV masters. Start quietly: these are analytical EQ comparison
signals, not a hearing test, an SPL calibration, or a substitute for calibrated equipment.
Reference and sweep: -18 dBFS RMS. Octave and full-band pink noise: -20 dBFS RMS per channel,
normalized after 75 ms raised-cosine fades. Octaves use center / sqrt(2) through center * sqrt(2).
The reference timeline is 62 s: 6 s reference, 1 s silence, 12 s logarithmic sweep, 1 s silence,
ten 2 s octave bursts each followed by 0.4 s silence, 8 s full-band pink noise, 2 s silence,
4 s identical-channel pink noise, then the same 4 s with right polarity inverted.
Inverted polarity intentionally cancels in mono; it is not a level-matching passage.

Music uses original genre-inspired scores, not imitations of particular songs or artists:
rock has double-panned distorted guitar mids; pop has chords and FM melody; country has
plucked guitar and alternating bass; percussion isolates drums; electronic has four-on-the-floor
and deep bass; hip hop has swung hats and sub; Brazilian funk has a roughly 130 BPM tamborzão
groove; worship has acoustic plucks, bright detuned pads and a longer stereo reverb impression.
All are integer-bar 4/4 loops (16–24 s), rounded to the nearest sample. Releases wrap around;
75 ms cosine boundary fades make repetition/crossfading click-safe. No extra tail extends a bar.
The drum/hat micro-envelopes are shorter than the track/section boundary fades.

Music targets -16.0 integrated LUFS (within 0.3 LU). The BS.1770-4 stereo meter uses the ITU
48 kHz high-shelf and RLB high-pass, summed channel powers, 400 ms blocks with 75% overlap,
a -70 LUFS absolute gate and a -10 LU relative gate. A stereo-linked soft-knee limiter is
followed by re-metering, so peak limiting does not silently change the loudness target.
Peak mastering uses 4x 24-tap windowed-sinc reconstruction and a -1.2 dBTP ceiling, leaving
0.2 dB below -1 dBTP. Tests additionally inspect 8x reconstruction.
Brighter hats, snare/clap crack, FM leads and pitched percussion carry the upper spectrum.
Broad stereo-linked EQ gently bounds the existing instrument bands; it adds no noise layer.
Diagnostic bands are 20–120, 120–500, 500–2000, 2000–6000 and 6000–20000 Hz. Presence and air
must be no more than 14 and 18 dB below low mids, respectively; sub is at most 6 dB above them.
The manifest reports integrated LUFS, actual RMS and estimated true peak, frame counts,
tempo/bar counts, and contiguous bilingual sections including silence. Times are seconds,
ends are exclusive.
Do not normalize individual sections again when analytically comparing EQ curves.

## Contents${manifest.short ? ' (SHORT DIAGNOSTIC RENDERS)' : ''}

${tracks.join('\n\n')}
`;
}

/**
 * @param {string[]} argv
 * @returns {{outputDir: string, only: string|undefined, short: boolean}}
 */
export function parseArgs(argv) {
  /** @type {string|undefined} */
  let outputDir;
  /** @type {string|undefined} */
  let only;
  let short = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--only') {
      only = argv[++i];
      if (!only || (only !== 'test-signals' && !GENRES.some((genre) => genre.id === only))) {
        throw new Error('--only requires test-signals or a genre ID');
      }
    } else if (arg === '--short') short = true;
    else if (arg.startsWith('-') || outputDir) throw new Error(`Unexpected argument: ${arg}`);
    else outputDir = arg;
  }
  if (!outputDir) {
    throw new Error('Usage: node tools/gen-preview-audio.mjs <output-dir> [--only <id>] [--short]');
  }
  return { outputDir, only, short };
}

/** @returns {Promise<void>} */
async function main() {
  const { outputDir, only, short } = parseArgs(process.argv.slice(2));
  await mkdir(outputDir, { recursive: true });
  const ids = ['test-signals', ...GENRES.map((genre) => genre.id)].filter(
    (id) => !only || only === id,
  );
  /** @type {FileMetadata[]} */
  const files = [];
  for (const id of ids) {
    const { channels, metadata } =
      id === 'test-signals'
        ? renderTestSignals({ timeScale: short ? 0.08 : 1 })
        : renderGenre(id, short ? { bars: 1 } : {});
    const wav = encodeWav(channels);
    await writeFile(join(outputDir, metadata.filename), wav);
    files.push({ ...metadata, bytes: wav.length });
    console.log(`${metadata.filename}: ${metadata.duration.toFixed(3)} s, ${wav.length} bytes`);
  }
  const manifest = createManifest(files, { short });
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outputDir, 'README.md'), createReadme(manifest));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
