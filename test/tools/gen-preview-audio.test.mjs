// SPDX-License-Identifier: CC0-1.0
// All renders stay in memory. Reduced durations/rates keep DSP coverage inexpensive.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GENRES,
  OCTAVE_CENTERS,
  PEAK_DBFS,
  SAMPLE_RATE,
  VOICES,
  createManifest,
  createReadme,
  createRng,
  dbToGain,
  encodeWav,
  fade,
  fft,
  gainToDb,
  integratedLoudness,
  master,
  parseArgs,
  renderGenre,
  renderTestSignals,
  reverb,
  rms,
  samplePeak,
  spectralBandLevels,
  sweepFrequencyAt,
  sweepPhaseAt,
  synthOctaveNoise,
  synthPinkNoise,
  synthSine,
  synthSweep,
  truePeak,
} from '../../tools/gen-preview-audio.mjs';

const LIMIT = dbToGain(-1);
/**
 * @typedef {import('../../tools/gen-preview-audio.mjs').FileMetadata} FileMetadata
 * @typedef {import('../../tools/gen-preview-audio.mjs').Biquad} Biquad
 */
/**
 * @param {number} actual
 * @param {number} expected
 * @param {number} [epsilon]
 * @returns {void}
 */
const near = (actual, expected, epsilon = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected} (±${epsilon})`);
};

/**
 * @param {FileMetadata} file
 * @returns {void}
 */
function checkSections(file) {
  let previousEnd = 0;
  /** @type {Set<string>} */
  const ids = new Set();
  for (const section of file.sections) {
    assert.ok(!ids.has(section.id));
    ids.add(section.id);
    assert.equal(section.start, previousEnd);
    assert.ok(section.end > section.start);
    assert.ok(section.end <= file.duration);
    assert.ok(section.title['pt-BR']);
    assert.ok(section.title['en-US']);
    assert.ok(section.kind);
    previousEnd = section.end;
  }
  assert.equal(previousEnd, file.duration);
}

/**
 * An unfaded reference: RMS and sine peak are deliberately different by 3.0103 dB.
 * @param {number} duration
 * @param {number} [rmsDb]
 * @param {number} [frequency]
 * @returns {Float64Array}
 */
function referenceSine(duration, rmsDb = -20, frequency = 1000) {
  const samples = new Float64Array(Math.round(duration * SAMPLE_RATE));
  const amplitude = Math.SQRT2 * dbToGain(rmsDb);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE);
  }
  return samples;
}

/**
 * Independent steady-state transfer-function calculation, not the time-domain meter.
 * @param {Biquad} coefficients
 * @param {number} frequency
 * @returns {number}
 */
function responsePower({ b0, b1, b2, a1, a2 }, frequency) {
  const omega = (2 * Math.PI * frequency) / SAMPLE_RATE;
  const nr = b0 + b1 * Math.cos(omega) + b2 * Math.cos(2 * omega);
  const ni = -b1 * Math.sin(omega) - b2 * Math.sin(2 * omega);
  const dr = 1 + a1 * Math.cos(omega) + a2 * Math.cos(2 * omega);
  const di = -a1 * Math.sin(omega) - a2 * Math.sin(2 * omega);
  return (nr * nr + ni * ni) / (dr * dr + di * di);
}

test('BS.1770 meter matches the 1 kHz stereo sine reference, including channel summation', () => {
  // Published ITU 48 kHz coefficients, independent of the meter's coefficient accessor.
  const shelf = {
    b0: 1.53512485958697,
    b1: -2.69169618940638,
    b2: 1.19839281085285,
    a1: -1.69065929318241,
    a2: 0.73248077421585,
  };
  const rlb = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };
  const kPower = responsePower(shelf, 1000) * responsePower(rlb, 1000);
  // Each channel has 0.01 mean square. Stereo SUMS powers, rather than averaging them.
  const expected = -0.691 + 10 * Math.log10(2 * 10 ** (-20 / 10) * kPower);
  near(expected, -16.99, 0.04);
  const sine = referenceSine(2);
  near(gainToDb(rms([sine])), -20, 1e-9);
  near(integratedLoudness([sine, sine]), expected, 0.1);
  near(
    integratedLoudness([sine, new Float64Array(sine.length)]),
    expected - 10 * Math.log10(2),
    0.1,
  );
  // A sine with -20 dBFS PEAK instead has -23.0103 dBFS RMS per channel, hence about -20 LUFS.
  const peakMinus20 = referenceSine(2, -20 - 10 * Math.log10(2));
  near(integratedLoudness([peakMinus20, peakMinus20]), expected - 10 * Math.log10(2), 0.1);
  near(integratedLoudness([peakMinus20, peakMinus20]), -20, 0.1);
});

test('BS.1770 absolute and relative gates exclude silence and very quiet passages', () => {
  const silence = new Float64Array(SAMPLE_RATE);
  assert.equal(integratedLoudness([silence, silence]), -Infinity);
  const belowGate = referenceSine(1, -90);
  assert.equal(integratedLoudness([belowGate, belowGate]), -Infinity);
  const short = referenceSine(0.1);
  assert.equal(integratedLoudness([short, short]), -Infinity);
  const loud = referenceSine(2);
  const quiet = referenceSine(4, -60);
  const combined = new Float64Array(loud.length + quiet.length);
  combined.set(loud);
  combined.set(quiet, loud.length);
  near(integratedLoudness([combined, combined]), integratedLoudness([loud, loud]), 0.5);
  assert.ok(gainToDb(rms([combined])) < gainToDb(rms([loud])) - 4);
});

test('the five diagnostic biquad bands isolate reference tones in their own bands', () => {
  for (const [index, frequency] of [60, 250, 1000, 3500, 11000].entries()) {
    const sine = referenceSine(0.5, -20, frequency);
    const bands = spectralBandLevels([sine, sine]);
    assert.ok(bands[index] > -24 && bands[index] < -19, `${frequency} Hz: ${bands}`);
    for (let other = 0; other < bands.length; other++) {
      if (index !== other) assert.ok(bands[index] > bands[other] + 10, `${frequency} Hz: ${bands}`);
    }
  }
});

test('WAV is little-endian 48 kHz, 24-bit interleaved stereo PCM', () => {
  const wav = encodeWav([Float64Array.of(0, 0.5, -0.5), Float64Array.of(0.25, -0.25, 0)]);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt32LE(28), 288000);
  assert.equal(wav.readUInt16LE(32), 6);
  assert.equal(wav.readUInt16LE(34), 24);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), 18);
  assert.equal(wav.length, 62);
  assert.equal(wav.readIntLE(44, 3), 0);
  assert.equal(wav.readIntLE(47, 3), Math.round(0.25 * 0x7fffff));
  assert.equal(wav.readIntLE(50, 3), Math.round(0.5 * 0x7fffff));
  assert.equal(wav.readIntLE(53, 3), Math.round(-0.25 * 0x7fffff));
  assert.equal(wav.readIntLE(56, 3), Math.round(-0.5 * 0x7fffff));
  assert.throws(() => encodeWav([Float64Array.of(2), Float64Array.of(0)]), /PCM/);
  assert.throws(() => encodeWav([Float64Array.of(NaN), Float64Array.of(0)]), /PCM/);
  assert.throws(() => encodeWav([new Float64Array(1), new Float64Array(2)]), /equal/);
});

test('seeded short signal and score renders give identical WAV bytes', () => {
  const options = { seed: 12345, timeScale: 0.02 };
  const a = renderTestSignals(options);
  const b = renderTestSignals(options);
  assert.deepEqual(encodeWav(a.channels), encodeWav(b.channels));
  assert.deepEqual(a.metadata, b.metadata);
  const c = renderTestSignals({ ...options, seed: 12346 });
  assert.notDeepEqual(encodeWav(a.channels), encodeWav(c.channels));
  const loopOptions = { seed: 812, bars: 2, sampleRate: 8000 };
  const loop = renderGenre('country', loopOptions);
  assert.deepEqual(
    encodeWav(loop.channels, loopOptions),
    encodeWav(renderGenre('country', loopOptions).channels, loopOptions),
  );
  checkSections(loop.metadata);
  const random = createRng(123);
  const sequence = Array.from({ length: 20 }, random);
  assert.deepEqual(sequence, Array.from({ length: 20 }, createRng(123)));
  assert.ok(sequence.every((value) => value >= 0 && value < 1));
});

test('log sweep phase derivative visits 20 Hz and 20 kHz', () => {
  const duration = 12;
  near(sweepFrequencyAt(0, duration), 20);
  near(sweepFrequencyAt(duration, duration), 20000, 1e-8);
  near(sweepFrequencyAt(duration / 2, duration), Math.sqrt(20 * 20000), 1e-8);
  const h = 1e-6;
  const startFrequency =
    (sweepPhaseAt(h, duration) - sweepPhaseAt(0, duration)) / (2 * Math.PI * h);
  const endFrequency =
    (sweepPhaseAt(duration, duration) - sweepPhaseAt(duration - h, duration)) / (2 * Math.PI * h);
  near(startFrequency, 20, 0.001);
  near(endFrequency, 20000, 0.02);
  // The actual rendered oscillator must use that phase trajectory (up to normalization gain).
  const sweep = synthSweep(0.3);
  const i = 5000;
  const j = 6000;
  near(
    sweep[i] * Math.sin(sweepPhaseAt(j / SAMPLE_RATE, 0.3)),
    sweep[j] * Math.sin(sweepPhaseAt(i / SAMPLE_RATE, 0.3)),
    1e-10,
  );
  assert.throws(() => synthSweep(1, { endHz: 24000 }), /frequencies/);
});

test('FFT round trips and every octave burst concentrates energy inside its octave', () => {
  const real = Float64Array.of(0, 1, 2, 3, -1, -2, 0, 4);
  const original = real.slice();
  const imaginary = new Float64Array(real.length);
  fft(real, imaginary);
  fft(real, imaginary, true);
  real.forEach((value, index) => near(value, original[index]));
  for (const center of OCTAVE_CENTERS) {
    const samples = synthOctaveNoise(center, 1.5, { seed: 100 + center });
    near(gainToDb(rms([samples])), -20, 1e-8);
    assert.equal(samples[0], 0);
    assert.equal(samples.at(-1), 0);
    const n = 131072;
    const spectrum = new Float64Array(n);
    spectrum.set(samples);
    const quadrature = new Float64Array(n);
    fft(spectrum, quadrature);
    let total = 0;
    let inBand = 0;
    for (let bin = 1; bin < n / 2; bin++) {
      const hz = (bin * SAMPLE_RATE) / n;
      const energy = spectrum[bin] ** 2 + quadrature[bin] ** 2;
      total += energy;
      if (hz >= center / Math.SQRT2 && hz <= center * Math.SQRT2) inBand += energy;
    }
    assert.ok(inBand / total > 0.9, `${center} Hz: in-band energy = ${inBand / total}`);
    assert.ok(samplePeak([samples]) < LIMIT);
  }
});

test('reference, sweep and pink levels include fades; helpers are calibrated', () => {
  const sine = synthSine(0.4);
  near(gainToDb(rms([sine])), -18, 1e-9);
  near(gainToDb(rms([synthSweep(0.4)])), -18, 1e-9);
  near(gainToDb(rms([synthPinkNoise(0.4)])), -20, 1e-9);
  near(rms([Float64Array.of(1, -1), Float64Array.of(1, -1)]), 1);
  near(samplePeak([Float64Array.of(0.1, -0.4)]), 0.4);
  near(dbToGain(gainToDb(0.25)), 0.25);
  const constant = new Float64Array(480).fill(1);
  const faded = fade(constant, 48000, 0.002);
  assert.equal(faded[0], 0);
  assert.equal(faded.at(-1), 0);
  assert.equal(faded[240], 1);
  assert.equal(constant[0], 1); // pure, no input mutation
  assert.equal(faded[95], 1);
  near(faded[47], faded[faded.length - 1 - 47]);
});

test('peak estimate detects inter-sample overshoot; mastering limits reconstructed peaks', () => {
  const samples = new Float64Array(24000);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.9 * Math.sin((Math.PI * i) / 2 + Math.PI / 4);
  }
  assert.ok(truePeak([samples]) > samplePeak([samples]) + 0.1);
  const channels = [samples.map((value) => value * 4), samples.map((value) => -value * 3)];
  const before = channels[0].slice();
  const output = master(channels, { targetLufs: -3 });
  assert.deepEqual(channels[0], before);
  assert.ok(samplePeak(output) <= dbToGain(PEAK_DBFS) + 1e-10);
  assert.ok(truePeak(output) <= dbToGain(PEAK_DBFS) + 1e-10);
  assert.ok(truePeak(output, { oversample: 8 }) <= LIMIT);
  output[0].forEach((value, index) => near(output[1][index], -0.75 * value));
  const silence = master([new Float64Array(10), new Float64Array(10)]);
  assert.equal(samplePeak(silence), 0);
});

test('all instrument voices and stereo reverb are finite, deterministic and non-silent', () => {
  for (const [name, voice] of Object.entries(VOICES)) {
    const options = { sampleRate: 12000, duration: 0.2, frequency: 220, seed: 42 };
    const samples = voice(options);
    assert.equal(samples.length, 2400, name);
    assert.deepEqual(samples, voice(options), name);
    assert.ok(samples.every(Number.isFinite), name);
    assert.ok(rms([samples]) > 0.001, name);
    assert.equal(Math.abs(samples[0]), 0, name);
    assert.equal(Math.abs(samples[samples.length - 1]), 0, name);
  }
  const impulse = new Float64Array(8000);
  impulse[100] = 1;
  const output = reverb([impulse, impulse], { sampleRate: 8000 });
  assert.ok(output.every((channel) => channel.every(Number.isFinite)));
  assert.ok(output[0].slice(300).some((value) => Math.abs(value) > 0.0001));
  assert.notDeepEqual(output[0], output[1]);
  assert.deepEqual(output, reverb([impulse, impulse], { sampleRate: 8000 }));
  assert.equal(impulse[100], 1);
});

test('signal manifest is contiguous, includes gaps and has exact phase polarity', () => {
  const { channels, metadata } = renderTestSignals({ timeScale: 0.04, seed: 12 });
  checkSections(metadata);
  near(metadata.duration, 62 * 0.04, 1 / SAMPLE_RATE);
  assert.equal(metadata.sections.filter((section) => section.kind === 'octave-noise').length, 10);
  assert.equal(metadata.sections.filter((section) => section.kind === 'silence').length, 13);
  for (const section of metadata.sections) {
    const start = Math.round(section.start * SAMPLE_RATE);
    const end = Math.round(section.end * SAMPLE_RATE);
    const left = channels[0].slice(start, end);
    const right = channels[1].slice(start, end);
    assert.equal(Math.abs(left[0]), 0);
    assert.equal(Math.abs(left[left.length - 1]), 0);
    if (section.kind === 'silence') assert.equal(samplePeak([left, right]), 0);
    else {
      assert.ok(section.rmsDbfs !== undefined);
      near(gainToDb(rms([left, right])), section.rmsDbfs, 1e-8);
    }
    for (let i = 0; i < left.length; i++) near(right[i], left[i] * (section.rightPolarity ?? 1));
  }
  assert.ok(samplePeak(channels) < LIMIT);
  assert.ok(truePeak(channels, { oversample: 8 }) < LIMIT);
  const inPhase = metadata.sections.find((section) => section.id === 'in-phase');
  const opposite = metadata.sections.find((section) => section.id === 'opposite-phase');
  assert.ok(inPhase && opposite);
  assert.deepEqual(
    channels[0].slice(
      Math.round(inPhase.start * SAMPLE_RATE),
      Math.round(inPhase.end * SAMPLE_RATE),
    ),
    channels[0].slice(
      Math.round(opposite.start * SAMPLE_RATE),
      Math.round(opposite.end * SAMPLE_RATE),
    ),
  );
});

test('eight genre scores are whole-bar, click-safe, stereo, peak-limited loops', () => {
  assert.deepEqual(
    GENRES.map((genre) => genre.id),
    ['rock', 'pop', 'country', 'percussion', 'electronic', 'hiphop', 'funk', 'worship'],
  );
  /** @type {FileMetadata[]} */
  const files = [];
  for (const genre of GENRES) {
    const productionDuration = (genre.bars * 4 * 60) / genre.bpm;
    assert.ok(productionDuration >= 16 && productionDuration <= 24, genre.id);
    const { channels, metadata } = renderGenre(genre.id, { bars: 1, seed: 345 });
    files.push(metadata);
    const expectedFrames = Math.round(
      ((metadata.bars * metadata.beatsPerBar * 60) / metadata.bpm) * SAMPLE_RATE,
    );
    assert.equal(channels[0].length, expectedFrames);
    assert.equal(channels[1].length, expectedFrames);
    assert.equal(metadata.frames, expectedFrames);
    assert.equal(metadata.duration, expectedFrames / SAMPLE_RATE);
    assert.ok(
      channels.every((channel) => channel.every(Number.isFinite)),
      genre.id,
    );
    assert.notDeepEqual(channels[0], channels[1], genre.id);
    for (const channel of channels) {
      assert.equal(Math.abs(channel[0]), 0);
      assert.equal(Math.abs(channel[channel.length - 1]), 0);
    }
    assert.ok(samplePeak(channels) <= LIMIT, genre.id);
    assert.ok(truePeak(channels, { oversample: 8 }) <= LIMIT, genre.id);
    assert.ok(metadata.levels.integratedLufs !== null);
    near(metadata.levels.integratedLufs, -16, 0.3);
    near(integratedLoudness(channels), -16, 0.3);
    const bands = spectralBandLevels(channels);
    assert.ok(bands.every(Number.isFinite), genre.id);
    assert.ok(bands[0] - bands[1] <= 6, `${genre.id}: sub/low mids = ${bands[0] - bands[1]} dB`);
    assert.ok(
      bands[3] - bands[1] >= -14,
      `${genre.id}: presence/low mids = ${bands[3] - bands[1]} dB`,
    );
    assert.ok(bands[4] - bands[1] >= -18, `${genre.id}: air/low mids = ${bands[4] - bands[1]} dB`);
    assert.ok(
      bands[3] <= bands[1] && bands[4] <= bands[1],
      `${genre.id}: unnaturally rising treble`,
    );
    checkSections(metadata);
    const wav = encodeWav(channels);
    for (let offset = 44; offset < wav.length; offset += 3) {
      assert.ok(Math.abs(wav.readIntLE(offset, 3) / 0x7fffff) <= LIMIT, genre.id);
    }
  }
  const manifest = createManifest(files, { short: true });
  assert.equal(manifest.license, 'CC0-1.0');
  assert.equal(manifest.sampleRate, SAMPLE_RATE);
  assert.equal(manifest.bitsPerSample, 24);
  assert.equal(manifest.channels, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(manifest)).files, files);
  const readme = createReadme(manifest);
  assert.match(readme, /CC0 1\.0/);
  assert.match(readme, /node tools\/gen-preview-audio\.mjs web\/static\/audio\/preview/);
  assert.match(readme, /SHORT DIAGNOSTIC/);
  for (const file of files) assert.ok(readme.includes(file.filename));
});

test('CLI selection and diagnostic options reject invalid or missing arguments', () => {
  assert.deepEqual(parseArgs(['out', '--only', 'funk', '--short']), {
    outputDir: 'out',
    only: 'funk',
    short: true,
  });
  assert.equal(parseArgs(['--only', 'test-signals', 'out']).only, 'test-signals');
  assert.throws(() => parseArgs([]), /Usage/);
  assert.throws(() => parseArgs(['out', '--only']), /requires/);
  assert.throws(() => parseArgs(['out', '--only', 'unknown']), /requires/);
  assert.throws(() => parseArgs(['out', '--wat']), /Unexpected/);
  assert.throws(() => parseArgs(['out', 'other']), /Unexpected/);
  assert.throws(() => renderGenre('unknown'), /Unknown genre/);
  assert.throws(() => renderGenre('rock', { bars: 0 }), /bar count/);
  assert.throws(() => renderTestSignals({ timeScale: 0 }), /time scale/);
  assert.throws(() => synthPinkNoise(0.1, { lowHz: 0 }), /noise band/);
  assert.throws(() => synthOctaveNoise(40000, 0.1), /noise band/);
});

test('48 kHz electronic music also respects the decoded PCM and 8x peak limits', () => {
  const { channels, metadata } = renderGenre('electronic', { bars: 1, seed: 100 });
  assert.equal(metadata.sampleRate, SAMPLE_RATE);
  assert.equal(metadata.frames, 96000);
  checkSections(metadata);
  assert.ok(truePeak(channels, { oversample: 8 }) <= LIMIT);
  const wav = encodeWav(channels);
  assert.equal(wav.length, 576044);
  for (let offset = 44; offset < wav.length; offset += 3) {
    assert.ok(Math.abs(wav.readIntLE(offset, 3) / 0x7fffff) <= LIMIT);
  }
});
