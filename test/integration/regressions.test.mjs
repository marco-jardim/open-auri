import test from 'node:test';
import assert from 'node:assert/strict';
import { TRUE_PEAK_PHASES } from '../../src/meter/truepeak.mjs';
import { gate, gateForWrite } from '../../src/safety/gate.mjs';
import { THRESHOLDS } from '../../src/safety/thresholds.mjs';
import { createFakeClock, FakeHIDDevice } from '../../src/transport/fake-device.mjs';
import { GateRejectedError, writeCurve } from '../../src/transport/webhid.mjs';

test('regression: true-peak phases retain the published non-unity DC gains', () => {
  assert.deepEqual(
    TRUE_PEAK_PHASES.map((phase) => phase.reduce((sum, coefficient) => sum + coefficient, 0)),
    [1.0015869140625, 0.9730224609375, 0.9730224609375, 1.0015869140625],
  );
});

test('regression: LP 20968 Hz Q 2 edge peak is seen by drag and full; above the cap nothing is written', async (t) => {
  const bands = [
    { kind: 'PK', freqHz: 1000, gainDb: -1, qFactor: 1 },
    { kind: 'LP', freqHz: 20968, qFactor: 2 },
    ...Array.from({ length: 8 }, () => ({ kind: 'OFF' })),
  ];
  const options = { experimental: true };
  const probe = gateForWrite(bands, -6, options);
  assert.ok(probe.metrics.outputAudible.frequencyHz < 20000, 'edge interval peak must be refined');
  const relativePeak = probe.metrics.outputAudible.db - probe.metrics.quantizedPreampDb;
  const preampCapDb = THRESHOLDS.outputAudibleDb - relativePeak;
  const highestWord = Math.floor(10 ** (preampCapDb / 20) * 2 ** 23);
  const acceptedDb = 20 * Math.log10(highestWord / 2 ** 23);
  const preampDb = 20 * Math.log10((highestWord + 1) / 2 ** 23);
  const fullAtCap = gateForWrite(bands, acceptedDb, options);
  const dragAtCap = gate(bands, acceptedDb, { ...options, grid: 'drag' });
  assert.equal(fullAtCap.ok, true, JSON.stringify(fullAtCap.reasons));
  assert.equal(dragAtCap.ok, true, JSON.stringify(dragAtCap.reasons));
  assert.ok(
    Math.abs(dragAtCap.metrics.outputAudible.db - fullAtCap.metrics.outputAudible.db) < 1e-9,
  );
  const full = gateForWrite(bands, preampDb, options);
  const drag = gate(bands, preampDb, { ...options, grid: 'drag' });
  assert.equal(full.metrics.grid, 'full');
  for (const verdict of [full, drag]) {
    assert.equal(verdict.ok, false);
    assert.deepEqual(
      verdict.reasons.map(({ code }) => code),
      ['e:output-audible'],
    );
  }
  const clock = createFakeClock();
  const device = new FakeHIDDevice({ clock });
  await assert.rejects(
    writeCurve(device, bands, preampDb, {
      clock,
      experimental: true,
      gate: () => ({ ok: true, reasons: [] }),
    }),
    GateRejectedError,
  );
  assert.equal(device.opened, false);
  assert.equal(device.attempts, 0);
  assert.deepEqual(device.sent, []);
  assert.equal(clock.pending(), 0);
  t.diagnostic(`LP 20968 Hz Q 2, Q23 word ${highestWord}, preamp ${preampDb} dB`);
});
