// Integration: writeCurve/applyCurve driving FakeHIDDevice's FakeFirmware, so the
// assertions are about what the cable plays (`live`, RAM) and keeps (`committed`,
// flash), not only about the bytes sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NEUTRAL_BANDS, OFF, encodePayload } from '../../src/dsp/eq0xcb.mjs';
import {
  DeviceDisconnectedError,
  REPORT_GAP_MS,
  SETTLE_MS,
  applyCurve,
  writeCurve,
} from '../../src/transport/webhid.mjs';
import {
  FakeFirmware,
  FakeHID,
  FakeHIDDevice,
  createFakeClock,
} from '../../src/transport/fake-device.mjs';

const PRE = -0.5;
const CUT_PRE = -4;
const CUT = [{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 }, ...Array(9).fill(OFF)];
const NEUTRAL = Uint8Array.from(encodePayload(NEUTRAL_BANDS, PRE));
const CUT_PAYLOAD = Uint8Array.from(encodePayload(CUT, CUT_PRE));
const LIVE_MS = 9 * REPORT_GAP_MS + SETTLE_MS;

/** A cable whose flash already holds the Neutro curve. */
function setup(deviceOptions = {}, { autoAdvance = true } = {}) {
  const clock = createFakeClock(0, { autoAdvance });
  const firmware = new FakeFirmware({ committed: NEUTRAL });
  const device = new FakeHIDDevice({ clock, firmware, ...deviceOptions });
  const hid = new FakeHID({ devices: [device] });
  return { clock, firmware, device, hid };
}

test('applyCurve changes the live curve, never the committed one', async () => {
  const { clock, firmware, device, hid } = setup();
  const result = await applyCurve(device, CUT, CUT_PRE, { clock, hid });
  assert.equal(result.status, 'ok');
  assert.deepEqual(firmware.live, CUT_PAYLOAD);
  assert.deepEqual(firmware.committed, NEUTRAL);
  assert.equal(firmware.appliedCount, 1);
  assert.equal(firmware.commitCount, 0);
  assert.deepEqual(firmware.ignored, []);
});

test('writeCurve changes both the live and the committed curve', async () => {
  const { clock, firmware, device, hid } = setup();
  const result = await writeCurve(device, CUT, CUT_PRE, { clock, hid });
  assert.equal(result.status, 'ok');
  assert.equal(result.committed, true);
  assert.deepEqual(firmware.live, CUT_PAYLOAD);
  assert.deepEqual(firmware.committed, CUT_PAYLOAD);
  assert.equal(firmware.appliedCount, 1);
  assert.equal(firmware.commitCount, 1);
});

test('interrupted before report 8: the live curve is unchanged', async () => {
  for (const call of [applyCurve, writeCurve]) {
    // Abort in a gap (reports 0..2 sent) and a failure of report 8 itself.
    const aborted = setup({}, { autoAdvance: false });
    const controller = new AbortController();
    const pending = call(aborted.device, CUT, CUT_PRE, {
      clock: aborted.clock,
      hid: aborted.hid,
      signal: controller.signal,
    });
    await aborted.clock.advance(40);
    controller.abort();
    const abortedResult = await pending;
    assert.equal(abortedResult.status, 'interrupted', call.name);
    assert.equal(abortedResult.reportsAttempted, 3, call.name);

    const failing = setup({ throwAtReport: 8 });
    const failedResult = await call(failing.device, CUT, CUT_PRE, failing);
    assert.equal(failedResult.status, 'interrupted', call.name);
    assert.equal(failedResult.reportsSent, 8, call.name);

    for (const { firmware } of [aborted, failing]) {
      assert.deepEqual(firmware.live, NEUTRAL, call.name);
      assert.deepEqual(firmware.committed, NEUTRAL, call.name);
      assert.equal(firmware.appliedCount, 0, call.name);
      assert.equal(firmware.commitCount, 0, call.name);
    }
  }
});

test('interrupted after report 8: the live curve is already the new one', async () => {
  // writeCurve aborted in the settle: report 8 was accepted, the commit never sent.
  const { clock, firmware, device, hid } = setup({}, { autoAdvance: false });
  const controller = new AbortController();
  const pending = writeCurve(device, CUT, CUT_PRE, { clock, hid, signal: controller.signal });
  await clock.advance(8 * REPORT_GAP_MS + 1);
  assert.equal(device.sent.length, 9);
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.equal(result.reportsSent, 9);
  assert.equal(result.committed, false);
  assert.deepEqual(firmware.live, CUT_PAYLOAD);
  assert.deepEqual(firmware.committed, NEUTRAL);
  assert.equal(firmware.commitCount, 0);

  // applyCurve unplugged in the settle: 'interrupted' after the full settle; the
  // chip played the new curve until the unplug, and a replug restores flash.
  const live = setup({}, { autoAdvance: false });
  const applying = applyCurve(live.device, CUT, CUT_PRE, { clock: live.clock, hid: live.hid });
  await live.clock.advance(8 * REPORT_GAP_MS + 1);
  assert.deepEqual(live.firmware.live, CUT_PAYLOAD);
  const fresh = live.hid.replug(live.device);
  await live.clock.advance(LIVE_MS);
  const applied = await applying;
  assert.equal(applied.status, 'interrupted');
  assert.ok(applied.error instanceof DeviceDisconnectedError);
  assert.equal(applied.reportsSent, 9);
  assert.equal(applied.finishedAt, LIVE_MS);
  assert.deepEqual(fresh.firmware.live, NEUTRAL);
  assert.deepEqual(live.firmware.committed, NEUTRAL);
});

test('a replug restores the committed curve after a live apply', async () => {
  const { clock, firmware, device, hid } = setup();
  await applyCurve(device, CUT, CUT_PRE, { clock, hid });
  assert.deepEqual(firmware.live, CUT_PAYLOAD);
  const fresh = hid.replug(device);
  assert.equal(fresh.firmware, firmware);
  assert.deepEqual(firmware.live, NEUTRAL);
  assert.deepEqual(firmware.committed, NEUTRAL);
  // After a writeCurve, the replug restores the new committed curve instead.
  const saved = await writeCurve(fresh, CUT, CUT_PRE, { clock, hid });
  assert.equal(saved.status, 'ok');
  hid.replug(fresh);
  assert.deepEqual(firmware.live, CUT_PAYLOAD);
  assert.deepEqual(firmware.committed, CUT_PAYLOAD);
});
