import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRUE_PEAK_PHASES,
  TRUE_PEAK_TAPS_PER_PHASE,
  createTruePeakMeter,
  oversamplingFactor,
} from '../../src/meter/truepeak.mjs';
import { FLOOR_DB } from '../../src/meter/common.mjs';
import { feed, noise, sine } from './signals.mjs';

test('BS.1770 Annex 2 filter: 4 phases × 12 taps, symmetric h[n] = h[47 − n], published DC gains', (t) => {
  assert.equal(TRUE_PEAK_PHASES.length, 4);
  /** @type {number[]} */
  const h = new Array(48);
  for (let k = 0; k < 4; k++) {
    assert.equal(TRUE_PEAK_PHASES[k].length, TRUE_PEAK_TAPS_PER_PHASE);
    for (let j = 0; j < 12; j++) h[4 * j + k] = TRUE_PEAK_PHASES[k][j];
  }
  for (let n = 0; n < 48; n++) assert.equal(h[n], h[47 - n], `h[${n}] != h[${47 - n}]`);
  for (let k = 0; k < 4; k++) {
    const sum = TRUE_PEAK_PHASES[k].reduce((a, b) => a + b, 0);
    t.diagnostic(`phase ${k} DC gain ${sum.toFixed(6)}`);
    // The published phases are not unity-gain at DC: 0 and 3 sum to 1.0015869140625, 1 and 2 to
    // 0.9730224609375 (−0.24 dB). This pins the table as printed; EBU Tech 3341 test 15 covers accuracy.
    assert.equal(sum, k === 0 || k === 3 ? 1.0015869140625 : 0.9730224609375);
  }
});

test('oversampling factor: 4× below 88.2 kHz, 2× at 88.2/96 kHz, none at ≥ 176.4 kHz', () => {
  assert.equal(oversamplingFactor(22050), 4);
  assert.equal(oversamplingFactor(44100), 4);
  assert.equal(oversamplingFactor(48000), 4);
  assert.equal(oversamplingFactor(88200), 2);
  assert.equal(oversamplingFactor(96000), 2);
  assert.equal(oversamplingFactor(176400), 1);
  assert.equal(oversamplingFactor(192000), 1);
  assert.equal(createTruePeakMeter({ sampleRate: 96000 }).factor, 2);
});

for (const sampleRate of [44100, 48000, 88200, 96000]) {
  test(`true peak: fs/4 sine with phase π/4 reads above the sample peak, within 0.1 dB of the amplitude at ${sampleRate} Hz`, (t) => {
    const amplitude = 0.5;
    const tone = sine(sampleRate, sampleRate / 4, amplitude, sampleRate, Math.PI / 4);
    const meter = createTruePeakMeter({ sampleRate });
    feed(meter, tone, tone);
    let samplePeak = 0;
    for (const x of tone) samplePeak = Math.max(samplePeak, Math.abs(x));
    const sampleDb = 20 * Math.log10(samplePeak);
    const { left, right, max } = meter.read();
    t.diagnostic(`sample peak ${sampleDb.toFixed(3)} dBFS, true peak ${left.toFixed(3)} dBTP`);
    assert.ok(left > sampleDb + 2.5);
    assert.ok(Math.abs(left - 20 * Math.log10(amplitude)) <= 0.1, `left ${left}`);
    assert.equal(left, right);
    assert.equal(max, left);
  });
}

test('EBU Tech 3341 test 15: stereo fs/4 sine, amplitude 0.5, reads −6.0 +0.2/−0.4 dBTP at 48 kHz', (t) => {
  const tone = sine(48000, 12000, 0.5, 48000);
  const meter = createTruePeakMeter({ sampleRate: 48000 });
  feed(meter, tone, tone);
  const { left, right } = meter.read();
  t.diagnostic(`test 15: ${left.toFixed(3)} / ${right.toFixed(3)} dBTP`);
  for (const value of [left, right]) assert.ok(value >= -6.4 && value <= -5.8, `${value}`);
});

for (const sampleRate of [44100, 48000, 96000, 192000]) {
  test(`true peak is never below the sample peak (noise and sines) at ${sampleRate} Hz`, () => {
    const meter = createTruePeakMeter({ sampleRate });
    const left = noise(sampleRate, 11, 0.9);
    const right = sine(sampleRate, 997, 0.7, sampleRate, 1);
    let peakLeft = 0;
    let peakRight = 0;
    let start = 0;
    feed(meter, left, right, (end) => {
      let blockLeft = 0;
      let blockRight = 0;
      for (let i = start; i < end; i++) {
        blockLeft = Math.max(blockLeft, Math.abs(left[i]));
        blockRight = Math.max(blockRight, Math.abs(right[i]));
      }
      start = end;
      peakLeft = Math.max(peakLeft, blockLeft);
      peakRight = Math.max(peakRight, blockRight);
      const reading = meter.read();
      assert.ok(reading.blockLeft >= 20 * Math.log10(blockLeft) - 1e-9);
      assert.ok(reading.blockRight >= 20 * Math.log10(blockRight) - 1e-9);
    });
    const { left: tpLeft, right: tpRight, max } = meter.read();
    assert.ok(tpLeft >= 20 * Math.log10(peakLeft) - 1e-9);
    assert.ok(tpRight >= 20 * Math.log10(peakRight) - 1e-9);
    assert.equal(max, Math.max(tpLeft, tpRight));
    if (sampleRate === 192000) assert.ok(Math.abs(tpLeft - 20 * Math.log10(peakLeft)) < 1e-6);
  });
}

test('true peak: silence reads the finite floor; mono input; reset', () => {
  const meter = createTruePeakMeter({ sampleRate: 48000 });
  assert.equal(meter.read().max, FLOOR_DB);
  feed(meter, new Float32Array(4800));
  assert.deepEqual(meter.read(), {
    left: FLOOR_DB,
    right: FLOOR_DB,
    max: FLOOR_DB,
    blockLeft: FLOOR_DB,
    blockRight: FLOOR_DB,
  });
  feed(meter, sine(48000, 1000, 0.25, 4800));
  assert.equal(meter.read().left, meter.read().right);
  meter.process(new Float32Array(0));
  assert.equal(meter.read().blockLeft, FLOOR_DB);
  assert.ok(meter.read().left > -12.1);
  meter.reset();
  assert.equal(meter.read().max, FLOOR_DB);
});

test('true peak: getState/setState round-trip resumes identically and validates', () => {
  const a = createTruePeakMeter({ sampleRate: 44100 });
  const left = noise(20000, 21);
  const right = noise(20000, 22);
  feed(a, left.subarray(0, 7777), right.subarray(0, 7777));
  const b = createTruePeakMeter({ sampleRate: 44100 });
  b.setState(JSON.parse(JSON.stringify(a.getState())));
  feed(a, left.subarray(7777), right.subarray(7777), undefined, 100);
  feed(b, left.subarray(7777), right.subarray(7777), undefined, 100);
  assert.deepEqual(b.read(), a.read());
  assert.deepEqual(b.getState(), a.getState());
  const state = a.getState();
  assert.throws(() => b.setState({ ...state, position: 12 }), TypeError);
  assert.throws(() => b.setState({ ...state, position: 1.5 }), TypeError);
  assert.throws(() => b.setState({ ...state, history: [] }), TypeError);
  assert.throws(() => b.setState({ ...state, kind: 'vu' }), TypeError);
  assert.throws(() => createTruePeakMeter({ sampleRate: 1000 }), RangeError);
  assert.throws(() => b.process(new Float32Array(2), new Float32Array(1)), RangeError);
  assert.deepEqual(b.read(), a.read(), 'failed setState leaves the meter untouched');
});

test('true peak: 10 000 blocks keep the same internal buffers', () => {
  const meter = createTruePeakMeter({ sampleRate: 48000 });
  const before = [...meter.buffers];
  const block = noise(128, 5);
  for (let i = 0; i < 10000; i++) meter.process(block, block);
  for (let i = 0; i < before.length; i++) assert.equal(meter.buffers[i], before[i]);
  assert.ok(Number.isFinite(meter.read().max));
});
