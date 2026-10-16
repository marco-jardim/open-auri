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

test('regression: LP 20968 Hz Q 2 drag approval cannot authorize a write', async (t) => {
  const bands = [
    { kind: 'PK', freqHz: 1000, gainDb: -1, qFactor: 1 },
    { kind: 'LP', freqHz: 20968, qFactor: 2 },
    ...Array.from({ length: 8 }, () => ({ kind: 'OFF' })),
  ];
  const options = { experimental: true, grid: 'drag' };
  const probe = gate(bands, -6, options);
  assert.equal(probe.metrics.outputAudible.frequencyHz, 20000);
  const relativePeak = probe.metrics.outputAudible.db - probe.metrics.quantizedPreampDb;
  const preampCapDb = THRESHOLDS.outputAudibleDb - relativePeak;
  const highestWord = Math.floor(10 ** (preampCapDb / 20) * 2 ** 23);
  const preampDb = 20 * Math.log10(highestWord / 2 ** 23);
  const drag = gate(bands, preampDb, options);
  assert.equal(drag.ok, true, JSON.stringify(drag.reasons));
  const full = gateForWrite(bands, preampDb, options);
  assert.equal(full.metrics.grid, 'full');
  assert.equal(full.ok, false);
  assert.deepEqual(
    full.reasons.map(({ code }) => code),
    ['e:output-audible'],
  );
  assert.ok(full.metrics.outputAudible.frequencyHz < 20000);
  assert.ok(full.metrics.outputAudible.db > drag.metrics.outputAudible.db);
  const clock = createFakeClock();
  const device = new FakeHIDDevice({ clock });
  await assert.rejects(
    writeCurve(device, bands, preampDb, {
      clock,
      experimental: true,
      gate: (curve, preamp, gateOptions) =>
        gateForWrite(curve, preamp, { ...gateOptions, ...options }),
    }),
    GateRejectedError,
  );
  assert.equal(device.opened, false);
  assert.equal(device.attempts, 0);
  assert.deepEqual(device.sent, []);
  assert.equal(clock.pending(), 0);
  t.diagnostic(`LP 20968 Hz Q 2, Q23 word ${highestWord}, preamp ${preampDb} dB`);
});
