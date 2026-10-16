import test from 'node:test';
import assert from 'node:assert/strict';
import { NEUTRO, OFFICIAL_PRESETS } from '../../src/catalog/presets.mjs';
import {
  commitReport,
  crc16Ccitt,
  designSection,
  encodePayload,
  encodeReports,
  encodeSection,
  HID_REPORT_ID,
  magnitudeDb,
  preampWord,
  SAMPLE_RATE,
} from '../../src/dsp/eq0xcb.mjs';
import { GRID } from '../../src/dsp/grid.mjs';
import { parseEqualizerApo, serializeEqualizerApo } from '../../src/io/equalizer-apo.mjs';
import { parseMeasurement, toGrid } from '../../src/io/measurement.mjs';
import { createVuMeter } from '../../src/meter/ballistics.mjs';
import { createLoudnessMeter } from '../../src/meter/loudness.mjs';
import { createTruePeakMeter } from '../../src/meter/truepeak.mjs';
import { appendEntry, parseJournal, serializeJournal } from '../../src/policy/journal.mjs';
import { gateForWrite } from '../../src/safety/gate.mjs';
import { parseEnvelope, serializeEnvelope, validateEnvelope } from '../../src/share/envelope.mjs';
import { decodeS1, encodeS1 } from '../../src/share/s1.mjs';
import { solvePeq, targetFromPoints } from '../../src/solver/peq.mjs';
import { createFakeClock, FakeHIDDevice } from '../../src/transport/fake-device.mjs';
import { GateRejectedError, writeCurve } from '../../src/transport/webhid.mjs';

const CATALOG = [...OFFICIAL_PRESETS, NEUTRO];

async function simulateWrite(curve) {
  const clock = createFakeClock(0, { autoAdvance: true });
  const device = new FakeHIDDevice({ clock });
  let gateCalls = 0;
  const result = await writeCurve(device, curve.bands, curve.preampDb, {
    clock,
    gate(bands, preampDb, options) {
      gateCalls++;
      return gateForWrite(bands, preampDb, options);
    },
  });
  assert.equal(gateCalls, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.committed, true);
  assert.equal(result.reportsSent, 9);
  assert.equal(device.attempts, 10);
  const expectedReports = [...encodeReports(curve.bands, curve.preampDb), commitReport()];
  assert.deepEqual(
    device.sent.map(({ bytes }) => bytes),
    expectedReports,
  );
  assert.ok(device.sent.every(({ reportId }) => reportId === HID_REPORT_ID));
  assert.deepEqual(
    device.sent.map(({ at }) => at),
    [0, 16, 32, 48, 64, 80, 96, 112, 128, 294],
  );
  const payload = encodePayload(curve.bands, curve.preampDb);
  const receivedPayload = device.sent.slice(0, 9).flatMap(({ bytes }) => [...bytes.slice(1)]);
  assert.deepEqual(receivedPayload.slice(0, payload.length), payload);
  assert.ok(receivedPayload.slice(payload.length).every((byte) => byte === 0));
  const crc = payload.at(-2) | (payload.at(-1) << 8);
  assert.equal(crc, crc16Ccitt(payload.slice(0, -2)));
  assert.equal(result.crc, crc);
  assert.equal(clock.pending(), 0);
  return { result, device, crc };
}

test('integration catalog contains all 11 official presets and Neutro', () => {
  assert.equal(OFFICIAL_PRESETS.length, 11);
  assert.equal(CATALOG.length, 12);
});

for (const preset of CATALOG) {
  test(`APO → gate → S1 → envelope → simulated HID → journal: ${preset.id}`, async () => {
    const imported = parseEqualizerApo(serializeEqualizerApo(preset));
    assert.deepEqual(imported.warnings, []);
    assert.deepEqual(imported.bands, preset.bands);
    assert.equal(imported.preampDb, preset.preampDb);
    const verdict = gateForWrite(imported.bands, imported.preampDb);
    assert.equal(verdict.ok, true, JSON.stringify(verdict.reasons));
    const code = encodeS1(imported);
    const decoded = decodeS1(code);
    assert.deepEqual(decoded.bands, imported.bands);
    assert.equal(decoded.preampDb, imported.preampDb);
    assert.equal(encodeS1(decoded), code);

    // Test publication structure, not an assertion about the official curves' license.
    const validated = validateEnvelope({
      format: 'open-auri/preset@1',
      name: `Integration ${preset.id}`,
      description: 'Local synthetic publication fixture',
      source: 'custom',
      license: 'CC0-1.0',
      code,
      bands: decoded.bands,
      preampDb: decoded.preampDb,
      lang: 'en-US',
      createdAt: '2026-10-16T00:00:00Z',
    });
    assert.equal(validated.ok, true, JSON.stringify(validated));
    const serialized = serializeEnvelope(validated.value);
    const parsed = parseEnvelope(serialized);
    assert.deepEqual(parsed, validated);
    assert.equal(serializeEnvelope(parsed.value), serialized);

    const { result, device, crc } = await simulateWrite(parsed.value);
    assert.equal(crc, preset.crc);
    assert.equal(verdict.metrics.payloadCrc, `0x${crc.toString(16).padStart(4, '0')}`);
    const previous = [];
    const journal = appendEntry(previous, {
      schema: 1,
      at: Date.parse(parsed.value.createdAt) + result.finishedAt,
      name: parsed.value.name,
      crc: result.crc,
      bands: parsed.value.bands,
      preampDb: parsed.value.preampDb,
      status: 'simulated',
      device: device.productName,
    });
    assert.deepEqual(previous, []);
    const restored = parseJournal(serializeJournal(journal));
    assert.equal(restored.dropped, 0);
    assert.deepEqual(restored.entries, journal);
    assert.equal(restored.entries[0].status, 'simulated');
    assert.equal(restored.entries[0].crc, crc);
    assert.deepEqual(restored.entries[0].bands, preset.bands);
  });
}

for (const preset of OFFICIAL_PRESETS) {
  test(`reversed ${preset.id}: d:prefix-peak prevents every HID report`, async () => {
    const imported = parseEqualizerApo(
      serializeEqualizerApo({ ...preset, bands: [...preset.bands].reverse() }),
    );
    const verdict = gateForWrite(imported.bands, imported.preampDb);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some(({ code }) => code === 'd:prefix-peak'));
    const clock = createFakeClock();
    const device = new FakeHIDDevice({ clock });
    await assert.rejects(
      writeCurve(device, imported.bands, imported.preampDb, { gate: gateForWrite, clock }),
      (error) => {
        assert.ok(error instanceof GateRejectedError);
        assert.deepEqual(error.reasons, verdict.reasons);
        return true;
      },
    );
    assert.equal(device.opened, false);
    assert.equal(device.attempts, 0);
    assert.deepEqual(device.sent, []);
    assert.equal(clock.pending(), 0);
  });
}

test('AutoEq measurement + flat target → solver → gate → S1 → simulated HID', async (t) => {
  const preset = OFFICIAL_PRESETS[0];
  const csv = [
    'frequency,raw',
    ...GRID.map((frequency) => {
      const value = -magnitudeDb(preset.bands, frequency) + 0.15 * Math.log2(frequency / 1000);
      return `${frequency},${value}`;
    }),
  ].join('\n');
  const imported = parseMeasurement(csv);
  assert.equal(imported.format, 'autoeq-csv');
  const measurement = toGrid(imported.frequencies, imported.values);
  const target = targetFromPoints([
    { freqHz: 20, gainDb: 0 },
    { freqHz: 20000, gainDb: 0 },
  ]);
  const solved = solvePeq({
    measurement,
    target,
    maxIterations: 120,
    maxTimeMs: Infinity,
    seed: 20261016,
  });
  assert.notEqual(solved.stopReason, 'time');
  assert.ok(solved.bands.some(({ kind }) => kind !== 'OFF'));
  assert.ok(solved.iterations > 0);
  assert.ok(solved.rmsDb < 1.5, `solver RMS ${solved.rmsDb} dB`);
  const verdict = gateForWrite(solved.bands, solved.preampDb);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.reasons));
  const decoded = decodeS1(encodeS1(solved));
  assert.deepEqual(decoded.bands, solved.bands);
  assert.equal(decoded.preampDb, solved.preampDb);
  await simulateWrite(decoded);
  t.diagnostic(`solver: ${solved.iterations} iterations, RMS ${solved.rmsDb} dB`);
});

// Floating-point state evolution using the exact Q27 coefficients and Q23 preamp
// sent to the device; this does not model the firmware's unknown state arithmetic.
function filterQuantized(input, curve) {
  const preampGain = preampWord(curve.preampDb) / 2 ** 23;
  const output = Float64Array.from(input, (sample) => sample * preampGain);
  for (const band of curve.bands) {
    const [b0, b2, negA1, b1, negA2] = encodeSection(designSection(band)).map(
      (word) => word / 2 ** 27,
    );
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < output.length; i++) {
      const x = output[i];
      const y = b0 * x + s1;
      s1 = b1 * x + negA1 * y + s2;
      s2 = b2 * x + negA2 * y;
      output[i] = y;
    }
  }
  return output;
}

test('96 kHz Q27/Q23 preset IIR output agrees with VU, loudness and true-peak meters', (t) => {
  const preset = OFFICIAL_PRESETS[0];
  const tone = Float64Array.from(
    { length: 4 * SAMPLE_RATE },
    (_, i) => 10 ** (-18 / 20) * Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE),
  );
  const output = filterQuantized(tone, preset);
  const inputVu = createVuMeter({ sampleRate: SAMPLE_RATE, reference: -18 });
  const outputVu = createVuMeter({ sampleRate: SAMPLE_RATE, reference: -18 });
  const inputLoudness = createLoudnessMeter({ sampleRate: SAMPLE_RATE });
  const outputLoudness = createLoudnessMeter({ sampleRate: SAMPLE_RATE });
  const truePeak = createTruePeakMeter({ sampleRate: SAMPLE_RATE });
  let samplePeak = 0;
  for (let start = 0; start < tone.length; start += 257) {
    const dry = tone.subarray(start, start + 257);
    const wet = output.subarray(start, start + 257);
    inputVu.process(dry);
    outputVu.process(wet);
    inputLoudness.process(dry);
    outputLoudness.process(wet);
    truePeak.process(wet);
    let blockPeak = 0;
    for (const sample of wet) {
      assert.ok(Number.isFinite(sample));
      blockPeak = Math.max(blockPeak, Math.abs(sample));
    }
    samplePeak = Math.max(samplePeak, blockPeak);
    assert.ok(truePeak.read().blockLeft >= 20 * Math.log10(blockPeak));
  }
  const expectedGain = magnitudeDb(preset.bands, 1000) + preset.preampDb;
  const vuChange = outputVu.read().left - inputVu.read().left;
  assert.ok(Math.abs(inputVu.read().left) <= 0.1);
  assert.ok(Math.abs(vuChange - expectedGain) <= 0.2, `${vuChange} vs ${expectedGain} dB`);
  assert.ok(Math.abs(outputVu.read().left - expectedGain) <= 0.2);
  assert.equal(outputVu.read().left, outputVu.read().right);
  const dryLoudness = inputLoudness.read();
  const wetLoudness = outputLoudness.read();
  assert.equal(wetLoudness.momentaryReady, true);
  assert.equal(wetLoudness.shortTermReady, true);
  for (const key of ['momentary', 'shortTerm']) {
    assert.ok(Number.isFinite(wetLoudness[key]));
    assert.ok(Math.abs(wetLoudness[key] - dryLoudness[key] - expectedGain) <= 0.2);
  }
  assert.equal(truePeak.factor, 2);
  assert.ok(truePeak.read().max >= 20 * Math.log10(samplePeak));
  assert.equal(truePeak.read().left, truePeak.read().right);
  t.diagnostic(`384000 samples: expected gain ${expectedGain} dB, VU change ${vuChange} dB`);
});
