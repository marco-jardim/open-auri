import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  K_WEIGHTING_48K,
  LOUDNESS_OFFSET_DB,
  MOMENTARY_HOPS,
  SHORT_TERM_HOPS,
  createLoudnessMeter,
  deriveKWeighting,
  kWeighting,
} from '../../src/meter/loudness.mjs';
import { FLOOR_DB } from '../../src/meter/common.mjs';
import { concat, dbToAmplitude, feed, noise, sine } from './signals.mjs';

test('K-weighting derived at 48 kHz matches the BS.1770 table within 1e-6', (t) => {
  const derived = deriveKWeighting(48000);
  let worst = 0;
  for (const stage of /** @type {const} */ (['shelf', 'rlb'])) {
    for (const part of /** @type {const} */ (['b', 'a'])) {
      for (let i = 0; i < 3; i++) {
        worst = Math.max(
          worst,
          Math.abs(derived[stage][part][i] - K_WEIGHTING_48K[stage][part][i]),
        );
      }
    }
  }
  t.diagnostic(`max |derived − table| at 48 kHz = ${worst.toExponential(3)}`);
  assert.ok(worst < 1e-6, `error ${worst}`);
  assert.equal(kWeighting(48000), K_WEIGHTING_48K);
  assert.notEqual(kWeighting(44100).shelf.a[1], K_WEIGHTING_48K.shelf.a[1]);
  assert.equal(LOUDNESS_OFFSET_DB, -0.691);
});

/**
 * Runs a stereo (or mono) signal and returns the readings after every block.
 * @param {number} sampleRate
 * @param {Float32Array} left
 * @param {Float32Array} [right]
 */
function run(sampleRate, left, right) {
  const meter = createLoudnessMeter({ sampleRate });
  /** @type {{ time: number, momentary: number, shortTerm: number }[]} */
  const readings = [];
  feed(meter, left, right, (end) => {
    const { momentary, shortTerm } = meter.read();
    readings.push({ time: end / sampleRate, momentary, shortTerm });
  });
  return { meter, readings };
}

for (const [sampleRate, level] of /** @type {const} */ ([
  [48000, -23],
  [48000, -33],
  [96000, -23],
  [44100, -23],
])) {
  test(`EBU Tech 3341 test ${level === -23 ? 1 : 2}: stereo 1 kHz at ${level} dBFS gives M = S = ${level} ±0.1 LUFS at ${sampleRate} Hz`, (t) => {
    const tone = sine(sampleRate, 1000, dbToAmplitude(level), 4 * sampleRate);
    const { meter, readings } = run(sampleRate, tone, tone);
    const { momentary, shortTerm, momentaryReady, shortTermReady } = meter.read();
    t.diagnostic(`M = ${momentary.toFixed(4)} LUFS, S = ${shortTerm.toFixed(4)} LUFS`);
    assert.ok(Math.abs(momentary - level) <= 0.1, `M ${momentary}`);
    assert.ok(Math.abs(shortTerm - level) <= 0.1, `S ${shortTerm}`);
    assert.ok(momentaryReady && shortTermReady);
    for (const r of readings) {
      if (r.time >= 0.41) assert.ok(Math.abs(r.momentary - level) <= 0.1, `M at ${r.time}`);
    }
  });
}

/**
 * Alternating 1 kHz levels with phase continuity.
 * @param {number} sampleRate
 * @param {[number, number][]} pattern [seconds, dBFS] pairs.
 * @param {number} repeats
 */
function alternating(sampleRate, pattern, repeats) {
  /** @type {Float32Array[]} */
  const parts = [];
  let start = 0;
  for (let r = 0; r < repeats; r++) {
    for (const [seconds, db] of pattern) {
      const length = Math.round(seconds * sampleRate);
      parts.push(sine(sampleRate, 1000, dbToAmplitude(db), length, 0, start));
      start += length;
    }
  }
  return concat(parts);
}

test('EBU Tech 3341 test 9: S stays −23.0 ±0.1 after 3 s for 1.34 s −20 / 1.66 s −30 dBFS', (t) => {
  const signal = alternating(
    48000,
    [
      [1.34, -20],
      [1.66, -30],
    ],
    5,
  );
  const { readings } = run(48000, signal, signal);
  let low = Infinity;
  let high = -Infinity;
  for (const r of readings) {
    if (r.time < 3.01) continue;
    low = Math.min(low, r.shortTerm);
    high = Math.max(high, r.shortTerm);
  }
  t.diagnostic(`S range after 3 s: ${low.toFixed(4)} … ${high.toFixed(4)} LUFS`);
  assert.ok(low >= -23.1 && high <= -22.9, `${low} … ${high}`);
});

test('EBU Tech 3341 test 12: M stays −23.0 ±0.1 after 1 s for 0.18 s −20 / 0.22 s −30 dBFS', (t) => {
  const signal = alternating(
    48000,
    [
      [0.18, -20],
      [0.22, -30],
    ],
    20,
  );
  const { readings } = run(48000, signal, signal);
  let low = Infinity;
  let high = -Infinity;
  for (const r of readings) {
    if (r.time < 1) continue;
    low = Math.min(low, r.momentary);
    high = Math.max(high, r.momentary);
  }
  t.diagnostic(`M range after 1 s: ${low.toFixed(4)} … ${high.toFixed(4)} LUFS`);
  assert.ok(low >= -23.1 && high <= -22.9, `${low} … ${high}`);
});

test('0 dBFS 1 kHz sine on one channel (or mono) reads −3.01 LKFS ±0.05', (t) => {
  const tone = sine(48000, 1000, 1, 4 * 48000);
  const stereo = run(48000, tone, new Float32Array(tone.length)).meter.read();
  const mono = run(48000, tone).meter.read();
  t.diagnostic(
    `one channel: M = ${stereo.momentary.toFixed(4)}, mono: M = ${mono.momentary.toFixed(4)}`,
  );
  for (const value of [stereo.momentary, stereo.shortTerm, mono.momentary, mono.shortTerm]) {
    assert.ok(Math.abs(value + 3.01) <= 0.05, `${value}`);
  }
});

test('loudness: silence reads the finite floor; readiness flags; hop granularity', () => {
  const meter = createLoudnessMeter({ sampleRate: 48000 });
  assert.equal(meter.hopLength, 480);
  assert.deepEqual(meter.read(), {
    momentary: FLOOR_DB,
    shortTerm: FLOOR_DB,
    momentaryReady: false,
    shortTermReady: false,
  });
  const tone = sine(48000, 1000, 0.5, 479);
  meter.process(tone, tone);
  assert.equal(meter.read().momentary, FLOOR_DB, 'no reading before the first hop completes');
  meter.process(tone.subarray(0, 1), tone.subarray(0, 1));
  assert.ok(meter.read().momentary > FLOOR_DB);
  feed(meter, new Float32Array(480 * (MOMENTARY_HOPS - 1)), new Float32Array(480 * 39));
  assert.equal(meter.read().momentaryReady, true);
  assert.equal(meter.read().shortTermReady, false);
  feed(meter, new Float32Array(480 * SHORT_TERM_HOPS), new Float32Array(480 * SHORT_TERM_HOPS));
  const reading = meter.read();
  assert.equal(reading.momentary, FLOOR_DB);
  assert.equal(reading.shortTerm, FLOOR_DB);
  assert.equal(reading.shortTermReady, true);
  assert.equal(createLoudnessMeter({ sampleRate: 22050 }).hopLength, 221);
});

test('loudness: getState/setState round-trip resumes identically and validates', () => {
  const a = createLoudnessMeter({ sampleRate: 96000 });
  const left = noise(5 * 96000, 31, 0.3);
  const right = noise(5 * 96000, 32, 0.3);
  feed(a, left.subarray(0, 123457), right.subarray(0, 123457));
  const b = createLoudnessMeter({ sampleRate: 96000 });
  b.setState(JSON.parse(JSON.stringify(a.getState())));
  feed(a, left.subarray(123457), right.subarray(123457));
  feed(b, left.subarray(123457), right.subarray(123457));
  assert.deepEqual(b.read(), a.read());
  const state = a.getState();
  assert.throws(() => b.setState({ ...state, sampleRate: 48000 }), RangeError);
  assert.throws(() => b.setState({ ...state, ring: [1] }), TypeError);
  assert.throws(() => b.setState({ ...state, scalars: [0, 960, 0, 0, 0, 0] }), TypeError);
  assert.throws(() => b.setState({ ...state, scalars: [0, 0, 300, 0, 0, 0] }), TypeError);
  assert.throws(() => b.setState({ ...state, scalars: [0, 0, 0, 301, 0, 0] }), TypeError);
  assert.deepEqual(b.getState(), a.getState(), 'failed setState leaves the meter untouched');
  a.reset();
  assert.equal(a.read().shortTerm, FLOOR_DB);
  assert.throws(() => a.process(new Float32Array(3), new Float32Array(2)), RangeError);
});

test('loudness: 10 000 blocks keep the same internal buffers', () => {
  const meter = createLoudnessMeter({ sampleRate: 48000 });
  const before = [...meter.buffers];
  const block = noise(128, 9, 0.2);
  for (let i = 0; i < 10000; i++) meter.process(block, block);
  for (let i = 0; i < before.length; i++) assert.equal(meter.buffers[i], before[i]);
  assert.ok(Number.isFinite(meter.read().shortTerm));
});
