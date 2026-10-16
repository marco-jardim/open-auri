import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PPM_TYPES,
  VU_DEFAULT_REFERENCE,
  VU_OMEGA_N,
  VU_REFERENCE_LEVELS,
  VU_ZETA,
  createPpmMeter,
  createVuMeter,
  quasiPeakEquilibrium,
  vuStepResponse,
} from '../../src/meter/ballistics.mjs';
import { FLOOR_DB } from '../../src/meter/common.mjs';
import { dbToAmplitude, feed, noise, sine } from './signals.mjs';

const RATES = [44100, 48000, 88200, 96000, 192000];

test('VU constants: analytic step reaches 99 % at 300 ms with 1.0–1.5 % overshoot', (t) => {
  let t99 = Number.NaN;
  for (let i = 1; i <= 100000; i++) {
    if (vuStepResponse(i * 1e-5) >= 0.99) {
      t99 = i * 1e-5;
      break;
    }
  }
  const overshoot = Math.exp((-Math.PI * VU_ZETA) / Math.sqrt(1 - VU_ZETA * VU_ZETA));
  const peakTime = Math.PI / (VU_OMEGA_N * Math.sqrt(1 - VU_ZETA * VU_ZETA));
  t.diagnostic(`analytic t99 = ${t99.toFixed(5)} s, overshoot = ${(overshoot * 100).toFixed(3)} %`);
  assert.ok(Math.abs(t99 - 0.3) < 1e-3, `t99 = ${t99}`);
  assert.ok(overshoot >= 0.01 && overshoot <= 0.015, `overshoot = ${overshoot}`);
  assert.ok(Math.abs(vuStepResponse(peakTime) - 1 - overshoot) < 1e-12);
  assert.equal(vuStepResponse(0), 0);
});

for (const sampleRate of RATES) {
  test(`VU: 1 kHz sine at the alignment level reads 0 VU ±0.1 at ${sampleRate} Hz`, (t) => {
    for (const reference of VU_REFERENCE_LEVELS) {
      const meter = createVuMeter({ sampleRate, reference });
      const tone = sine(sampleRate, 1000, dbToAmplitude(reference), 3 * sampleRate);
      feed(meter, tone, tone);
      const { left, right } = meter.read();
      t.diagnostic(`ref ${reference} dBFS: ${left.toFixed(4)} / ${right.toFixed(4)} VU`);
      assert.ok(Math.abs(left) <= 0.1, `left ${left}`);
      assert.ok(Math.abs(right) <= 0.1, `right ${right}`);
    }
  });
}

test('VU: default reference is −18 dBFS and mono input drives both needles', () => {
  assert.equal(VU_DEFAULT_REFERENCE, -18);
  const meter = createVuMeter({ sampleRate: 48000 });
  feed(meter, sine(48000, 1000, dbToAmplitude(-24), 3 * 48000));
  const reading = meter.read();
  assert.ok(Math.abs(reading.left + 6) <= 0.1);
  assert.equal(reading.left, reading.right);
  assert.equal(reading.leftDeflection, reading.rightDeflection);
});

for (const sampleRate of [48000, 96000]) {
  test(`VU: step response 99 % in 300 ms ±10 %, overshoot 1.0–1.5 %, fall 300 ms at ${sampleRate} Hz`, (t) => {
    const meter = createVuMeter({ sampleRate, reference: -18 });
    const tone = sine(sampleRate, 1000, dbToAmplitude(-18), 2 * sampleRate);
    /** @type {number[]} */
    const times = [];
    /** @type {number[]} */
    const deflections = [];
    feed(meter, tone, tone, (end) => {
      times.push(end / sampleRate);
      deflections.push(meter.read().leftDeflection);
    });
    const final = deflections[deflections.length - 1];
    const rise = times[deflections.findIndex((d) => d >= 0.99 * final)];
    const overshoot = (Math.max(...deflections) / final - 1) * 100;
    t.diagnostic(`rise to 99 % = ${rise.toFixed(4)} s, overshoot = ${overshoot.toFixed(3)} %`);
    assert.ok(Math.abs(final - 1) < 0.01, `final ${final}`);
    assert.ok(rise >= 0.27 && rise <= 0.33, `rise ${rise}`);
    assert.ok(overshoot >= 1.0 && overshoot <= 1.5, `overshoot ${overshoot}`);

    const quiet = new Float32Array(sampleRate);
    /** @type {number[]} */
    const fall = [];
    /** @type {number[]} */
    const readings = [];
    feed(meter, quiet, quiet, () => {
      const reading = meter.read();
      fall.push(reading.leftDeflection);
      readings.push(reading.left);
    });
    const fallTime = (fall.findIndex((d) => d <= 0.01 * final) + 1) * (128 / sampleRate);
    t.diagnostic(`fall to 1 % = ${fallTime.toFixed(4)} s`);
    assert.ok(fallTime >= 0.27 && fallTime <= 0.33, `fall ${fallTime}`);
    assert.ok(Math.min(...fall) < 0, 'needle swings below rest after a stop');
    for (const value of readings) assert.ok(Number.isFinite(value) && value >= FLOOR_DB);
  });
}

test('VU: silence reads the finite floor, never NaN or −Infinity', () => {
  const meter = createVuMeter({ sampleRate: 44100 });
  assert.equal(meter.read().left, FLOOR_DB);
  feed(meter, new Float32Array(44100), new Float32Array(44100));
  const reading = meter.read();
  assert.equal(reading.left, FLOOR_DB);
  assert.equal(reading.right, FLOOR_DB);
  assert.equal(reading.leftDeflection, 0);
});

test('VU: getState/setState round-trip resumes identically; reset clears', () => {
  const a = createVuMeter({ sampleRate: 48000, reference: -20 });
  const signal = noise(48000, 7);
  const other = noise(48000, 8);
  feed(a, signal.subarray(0, 20000), other.subarray(0, 20000));
  const b = createVuMeter({ sampleRate: 48000, reference: -20 });
  b.setState(JSON.parse(JSON.stringify(a.getState())));
  assert.deepEqual(b.read(), a.read());
  feed(a, signal.subarray(20000), other.subarray(20000));
  feed(b, signal.subarray(20000), other.subarray(20000));
  assert.deepEqual(b.read(), a.read());
  a.reset();
  assert.equal(a.read().left, FLOOR_DB);
});

test('VU: rejects invalid options, states and blocks', () => {
  for (const sampleRate of [8000, 1e6, Number.NaN, Infinity]) {
    assert.throws(() => createVuMeter({ sampleRate }), RangeError);
  }
  assert.throws(() => createVuMeter({ sampleRate: '48000' }), RangeError);
  assert.throws(() => createVuMeter({ sampleRate: 48000, reference: -12 }), RangeError);
  const meter = createVuMeter({ sampleRate: 48000 });
  const state = meter.getState();
  assert.throws(() => meter.setState(null), TypeError);
  assert.throws(() => meter.setState({ ...state, kind: 'ppm' }), TypeError);
  assert.throws(() => meter.setState({ ...state, sampleRate: 44100 }), RangeError);
  assert.throws(() => meter.setState({ ...state, reference: -20 }), RangeError);
  assert.throws(() => meter.setState({ ...state, filter: [0, 0] }), TypeError);
  assert.throws(() => meter.setState({ ...state, filter: [0, 0, 0, 0, 0, Number.NaN] }), TypeError);
  assert.throws(() => meter.setState({ ...state, filter: 'x' }), TypeError);
  assert.throws(() => meter.process(new Float32Array(128), new Float32Array(64)), RangeError);
});

test('VU: 10 000 blocks keep the same internal buffers', () => {
  const meter = createVuMeter({ sampleRate: 48000 });
  const before = [...meter.buffers];
  assert.ok(Object.isFrozen(meter.buffers));
  const block = sine(48000, 1000, 0.1, 128);
  for (let i = 0; i < 10000; i++) meter.process(block, block);
  assert.equal(meter.buffers.length, before.length);
  for (let i = 0; i < before.length; i++) assert.equal(meter.buffers[i], before[i]);
  assert.ok(Number.isFinite(meter.read().left));
});

/**
 * Reading relative to the continuous tone for a burst of `seconds` (5 kHz, starting at phase 0).
 * @param {number} sampleRate
 * @param {'I' | 'II'} type
 * @param {number} seconds
 * @param {number} continuous
 */
function burstReading(sampleRate, type, seconds, continuous) {
  const meter = createPpmMeter({ sampleRate, type });
  const burst = sine(sampleRate, 5000, 0.5, Math.round(seconds * sampleRate));
  feed(meter, burst, burst);
  return meter.read().left - continuous;
}

/** @type {Record<'I' | 'II', [number, number, number][]>} */
const BURSTS = {
  // Wikipedia "Peak programme meter" (no tolerances published there; test tolerances).
  I: [
    [0.01, -1, 0.5],
    [0.005, -2, 0.75],
    [0.003, -4, 1],
    [0.0004, -15, 2],
  ],
  // EBU Tech 3205 Table 2 (the 100 ms row has no tolerance in the brief; ±0.5 dB here).
  II: [
    [0.1, 0, 0.5],
    [0.01, -2, 0.5],
    [0.005, -4, 0.75],
    [0.0015, -9, 1],
    [0.0005, -17, 2],
  ],
};

for (const sampleRate of [48000, 96000]) {
  for (const type of /** @type {const} */ (['I', 'II'])) {
    test(`PPM type ${type}: 5 kHz tone bursts meet the table at ${sampleRate} Hz`, (t) => {
      const meter = createPpmMeter({ sampleRate, type });
      const tone = sine(sampleRate, 5000, 0.5, sampleRate);
      feed(meter, tone, tone);
      const continuous = meter.read().left;
      t.diagnostic(`continuous 5 kHz at −6.02 dBFS reads ${continuous.toFixed(3)} dBFS`);
      assert.ok(Math.abs(continuous - 20 * Math.log10(0.5)) <= 0.2);
      for (const [seconds, target, tolerance] of BURSTS[type]) {
        const relative = burstReading(sampleRate, type, seconds, continuous);
        t.diagnostic(`${seconds * 1000} ms burst: ${relative.toFixed(3)} dB (target ${target})`);
        assert.ok(
          Math.abs(relative - target) <= tolerance,
          `${seconds * 1000} ms: ${relative} dB, expected ${target} ±${tolerance}`,
        );
      }
    });
  }
}

for (const sampleRate of [44100, 48000, 96000]) {
  test(`PPM: steady 1 kHz sine reads its peak level ±0.1 dB at ${sampleRate} Hz`, (t) => {
    for (const type of /** @type {const} */ (['I', 'II'])) {
      const meter = createPpmMeter({ sampleRate, type });
      const tone = sine(sampleRate, 1000, dbToAmplitude(-18), 2 * sampleRate);
      feed(meter, tone, tone);
      const { left, right } = meter.read();
      t.diagnostic(`type ${type}: ${left.toFixed(4)} dBFS`);
      assert.ok(Math.abs(left + 18) <= 0.1, `left ${left}`);
      assert.equal(left, right);
    }
  });
}

for (const [type, drop, seconds] of /** @type {const} */ ([
  ['I', 20, 1.7],
  ['II', 24, 2.8],
])) {
  test(`PPM type ${type}: returns ${drop} dB in ${seconds} s ±0.3 s`, (t) => {
    const sampleRate = 48000;
    const meter = createPpmMeter({ sampleRate, type });
    const tone = sine(sampleRate, 1000, 1, sampleRate);
    feed(meter, tone);
    const start = meter.read().left;
    const quiet = new Float32Array(4 * sampleRate);
    let elapsed = Number.NaN;
    feed(meter, quiet, undefined, (end) => {
      if (Number.isNaN(elapsed) && meter.read().left <= start - drop) elapsed = end / sampleRate;
    });
    t.diagnostic(`fell ${drop} dB in ${elapsed.toFixed(4)} s`);
    assert.ok(Math.abs(elapsed - seconds) <= 0.3, `elapsed ${elapsed}`);
  });
}

test('PPM: constants, equilibrium, channel independence and silence floor', () => {
  assert.equal(PPM_TYPES.I.decayDbPerSecond, 20 / 1.7);
  assert.equal(PPM_TYPES.II.decayDbPerSecond, 24 / 2.8);
  const v = quasiPeakEquilibrium(PPM_TYPES.II.slowAttack, PPM_TYPES.II.decayDbPerSecond);
  assert.ok(v > 0.95 && v < 0.97, `equilibrium ${v}`);
  assert.ok(quasiPeakEquilibrium(1e-9, 1) > 0.999999);
  const meter = createPpmMeter({ sampleRate: 48000 });
  assert.equal(meter.read().left, FLOOR_DB);
  const tone = sine(48000, 1000, 0.5, 48000);
  feed(meter, tone, new Float32Array(48000));
  const reading = meter.read();
  assert.ok(Math.abs(reading.left - 20 * Math.log10(0.5)) < 0.1);
  assert.equal(reading.right, FLOOR_DB);
  feed(meter, new Float32Array(48000 * 30), new Float32Array(48000 * 30));
  assert.equal(meter.read().left, FLOOR_DB);
});

test('PPM: getState/setState round-trip, reset and validation', () => {
  const a = createPpmMeter({ sampleRate: 44100, type: 'I' });
  const signal = noise(30000, 3);
  feed(a, signal.subarray(0, 10000));
  const b = createPpmMeter({ sampleRate: 44100, type: 'I' });
  b.setState(JSON.parse(JSON.stringify(a.getState())));
  feed(a, signal.subarray(10000));
  feed(b, signal.subarray(10000));
  assert.deepEqual(b.read(), a.read());
  a.reset();
  assert.equal(a.read().left, FLOOR_DB);
  assert.throws(() => createPpmMeter({ sampleRate: 48000, type: 'III' }), RangeError);
  const state = b.getState();
  assert.throws(() => a.setState({ ...state, type: 'II' }), RangeError);
  assert.throws(() => a.setState({ ...state, rectifiers: [1, 2, 3] }), TypeError);
  assert.throws(() => a.process(new Float32Array(4), new Float32Array(3)), RangeError);
});

test('PPM: 10 000 blocks keep the same internal buffers', () => {
  const meter = createPpmMeter({ sampleRate: 96000, type: 'II' });
  const before = [...meter.buffers];
  const block = sine(96000, 5000, 0.3, 128);
  for (let i = 0; i < 10000; i++) meter.process(block);
  for (let i = 0; i < before.length; i++) assert.equal(meter.buffers[i], before[i]);
  assert.ok(Number.isFinite(meter.read().left));
});
