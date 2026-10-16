import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRELATION_DEFAULT_TIME_CONSTANT,
  createCorrelationMeter,
} from '../../src/meter/correlation.mjs';
import { feed, noise, sine } from './signals.mjs';

/**
 * @param {Float32Array} samples
 */
function invert(samples) {
  return samples.map((x) => -x);
}

for (const sampleRate of [44100, 48000, 96000, 192000]) {
  test(`correlation: mono +1, inverted −1, independent noises ≈ 0 at ${sampleRate} Hz`, (t) => {
    const signal = noise(2 * sampleRate, 1);
    const mono = createCorrelationMeter({ sampleRate });
    feed(mono, signal, signal);
    assert.deepEqual(mono.read(), { correlation: 1, active: true });

    const single = createCorrelationMeter({ sampleRate });
    feed(single, signal);
    assert.equal(single.read().correlation, 1);

    const inverted = createCorrelationMeter({ sampleRate });
    feed(inverted, signal, invert(signal));
    assert.deepEqual(inverted.read(), { correlation: -1, active: true });

    const independent = createCorrelationMeter({ sampleRate });
    feed(independent, signal, noise(2 * sampleRate, 2));
    const { correlation, active } = independent.read();
    t.diagnostic(`independent noises after 2 s: r = ${correlation.toFixed(4)}`);
    assert.ok(active);
    assert.ok(Math.abs(correlation) < 0.05, `r = ${correlation}`);
  });
}

test('correlation: quadrature sines ≈ 0, scaled copies +1, default τ = 300 ms', () => {
  assert.equal(CORRELATION_DEFAULT_TIME_CONSTANT, 0.3);
  const meter = createCorrelationMeter({ sampleRate: 48000 });
  feed(meter, sine(48000, 1000, 0.5, 96000), sine(48000, 1000, 0.5, 96000, Math.PI / 2));
  assert.ok(Math.abs(meter.read().correlation) < 0.01);
  const scaled = createCorrelationMeter({ sampleRate: 48000, timeConstant: 0.6 });
  const tone = sine(48000, 440, 0.8, 48000);
  feed(
    scaled,
    tone,
    tone.map((x) => 0.1 * x),
  );
  assert.ok(Math.abs(scaled.read().correlation - 1) < 1e-9);
});

test('correlation: silence and one silent channel read 0 with active = false', () => {
  const meter = createCorrelationMeter({ sampleRate: 48000 });
  assert.deepEqual(meter.read(), { correlation: 0, active: false });
  feed(meter, new Float32Array(48000), new Float32Array(48000));
  assert.deepEqual(meter.read(), { correlation: 0, active: false });
  feed(meter, noise(48000, 4), new Float32Array(48000));
  assert.deepEqual(meter.read(), { correlation: 0, active: false });
  feed(meter, noise(48000, 4), noise(48000, 4));
  assert.equal(meter.read().active, true);
  feed(meter, new Float32Array(48000 * 60), new Float32Array(48000 * 60));
  const reading = meter.read();
  assert.deepEqual(reading, { correlation: 0, active: false });
  assert.ok(!Number.isNaN(reading.correlation));
});

test('correlation: τ option changes the speed of response', () => {
  const sampleRate = 48000;
  const signal = noise(sampleRate / 2, 12);
  /** @param {number} timeConstant */
  const after = (timeConstant) => {
    const meter = createCorrelationMeter({ sampleRate, timeConstant });
    const long = noise(2 * sampleRate, 13);
    feed(meter, long, long);
    feed(meter, signal, invert(signal));
    return meter.read().correlation;
  };
  assert.ok(after(0.3) < after(0.6));
});

test('correlation: getState/setState round-trip resumes identically and validates', () => {
  const a = createCorrelationMeter({ sampleRate: 88200, timeConstant: 0.45 });
  const left = noise(50000, 41);
  const right = noise(50000, 42);
  feed(a, left.subarray(0, 12345), right.subarray(0, 12345));
  const b = createCorrelationMeter({ sampleRate: 88200, timeConstant: 0.45 });
  b.setState(JSON.parse(JSON.stringify(a.getState())));
  feed(a, left.subarray(12345), right.subarray(12345));
  feed(b, left.subarray(12345), right.subarray(12345));
  assert.deepEqual(b.read(), a.read());
  const state = a.getState();
  assert.throws(() => b.setState({ ...state, timeConstant: 0.3 }), RangeError);
  assert.throws(() => b.setState({ ...state, averages: [0, 0] }), TypeError);
  assert.throws(() => b.setState(42), TypeError);
  for (const timeConstant of [0, -1, 100, Number.NaN, '0.3']) {
    assert.throws(() => createCorrelationMeter({ sampleRate: 48000, timeConstant }), RangeError);
  }
  b.setState({ ...state, averages: [2, 1, 1] });
  assert.equal(b.read().correlation, 1, 'clamped to +1');
  b.setState({ ...state, averages: [-2, 1, 1] });
  assert.equal(b.read().correlation, -1, 'clamped to −1');
  a.reset();
  assert.equal(a.read().active, false);
  assert.throws(() => a.process(new Float32Array(5), new Float32Array(4)), RangeError);
});

test('correlation: 10 000 blocks keep the same internal buffers', () => {
  const meter = createCorrelationMeter({ sampleRate: 48000 });
  const before = [...meter.buffers];
  const block = noise(128, 3);
  for (let i = 0; i < 10000; i++) meter.process(block, block);
  for (let i = 0; i < before.length; i++) assert.equal(meter.buffers[i], before[i]);
  assert.equal(meter.read().correlation, 1);
});
