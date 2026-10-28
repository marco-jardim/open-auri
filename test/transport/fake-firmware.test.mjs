import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HID_REPORT_ID,
  NEUTRAL_BANDS,
  OFF,
  COMMIT_COMMAND,
  commitReport,
  encodePayload,
  encodeReports,
} from '../../src/dsp/eq0xcb.mjs';
import {
  FakeFirmware,
  FakeHID,
  FakeHIDDevice,
  createFakeClock,
} from '../../src/transport/fake-device.mjs';

const PRE = -0.5;
const PEAK_BANDS = [{ kind: 'PK', freqHz: 2000, gainDb: -3, qFactor: 1 }, ...Array(9).fill(OFF)];
const NEUTRAL = Uint8Array.from(encodePayload(NEUTRAL_BANDS, PRE));
const PEAK = Uint8Array.from(encodePayload(PEAK_BANDS, -3));
const neutralReports = () => encodeReports(NEUTRAL_BANDS, PRE);
const peakReports = () => encodeReports(PEAK_BANDS, -3);

function setup(firmwareOptions) {
  const clock = createFakeClock(0, { autoAdvance: true });
  const firmware = new FakeFirmware(firmwareOptions);
  const device = new FakeHIDDevice({ clock, firmware });
  const hid = new FakeHID({ devices: [device] });
  return { clock, firmware, device, hid };
}

async function send(device, reports) {
  if (!device.opened) await device.open();
  for (const report of reports) await device.sendReport(HID_REPORT_ID, report);
}

/** Reports 0..8 with the last CRC byte flipped (report 7, byte 10), as in B7. */
function corruptedCrc(reports) {
  const copy = reports.map((report) => report.slice());
  copy[7][10] ^= 0xff;
  return copy;
}

test('a factory firmware has no live or committed curve and applies on report 8', () => {
  const firmware = new FakeFirmware();
  assert.equal(firmware.live, null);
  assert.equal(firmware.committed, null);
  assert.equal(firmware.applyOn, 8);
  assert.deepEqual(
    [firmware.appliedCount, firmware.commitCount, firmware.rejectedCrcCount],
    [0, 0, 0],
  );
  assert.deepEqual(firmware.ignored, []);
});

test('the 9 data reports alone set live but not committed', async () => {
  const { firmware, device } = setup();
  await send(device, neutralReports());
  assert.deepEqual(firmware.live, NEUTRAL);
  assert.equal(firmware.committed, null);
  assert.equal(firmware.appliedCount, 1);
  assert.equal(firmware.commitCount, 0);
  assert.equal(device.sent.length, 9);
  assert.equal(device.attempts, 9);
});

test('a later data-only sequence replaces live and leaves committed alone', async () => {
  const { firmware, device } = setup();
  await send(device, [...neutralReports(), commitReport()]);
  await send(device, peakReports());
  assert.deepEqual(firmware.live, PEAK);
  assert.deepEqual(firmware.committed, NEUTRAL);
  assert.equal(firmware.appliedCount, 2);
});

test('the commit persists live to committed', async () => {
  const { firmware, device } = setup();
  await send(device, [...neutralReports(), commitReport()]);
  assert.deepEqual(firmware.live, NEUTRAL);
  assert.deepEqual(firmware.committed, NEUTRAL);
  assert.equal(firmware.commitCount, 1);
  assert.equal(device.sent.length, 10);
});

test('the unpadded 5-byte commit is recognised too', () => {
  const firmware = new FakeFirmware();
  for (const report of peakReports()) firmware.receive(report);
  firmware.receive(Uint8Array.from(COMMIT_COMMAND));
  assert.deepEqual(firmware.committed, PEAK);
  assert.equal(firmware.commitCount, 1);
});

test('a commit with no live curve is ignored and recorded', () => {
  const firmware = new FakeFirmware();
  firmware.receive(commitReport());
  assert.equal(firmware.committed, null);
  assert.equal(firmware.commitCount, 0);
  assert.deepEqual(firmware.ignored, [{ bytes: commitReport(), reason: 'commit-without-live' }]);
});

test('replug restores the committed curve on a new device sharing the firmware', async () => {
  const { firmware, device, hid } = setup();
  await hid.requestDevice({ filters: [] });
  await send(device, [...neutralReports(), commitReport()]);
  await send(device, peakReports());
  assert.deepEqual(firmware.live, PEAK);

  const events = [];
  hid.addEventListener('disconnect', (event) => events.push(['disconnect', event.device]));
  hid.addEventListener('connect', (event) => {
    events.push(['connect', event.device]);
    // The new curve is already in place when 'connect' fires.
    assert.deepEqual(event.device.firmware.live, NEUTRAL);
  });
  const fresh = hid.replug(device);

  assert.notEqual(fresh, device);
  assert.deepEqual(events, [
    ['disconnect', device],
    ['connect', fresh],
  ]);
  assert.equal(device.connected, false);
  assert.equal(device.opened, false);
  assert.equal(fresh.connected, true);
  assert.equal(fresh.opened, false);
  assert.equal(fresh.firmware, firmware);
  assert.equal(fresh.clock, device.clock);
  assert.deepEqual(
    [fresh.vendorId, fresh.productId, fresh.productName],
    [device.vendorId, device.productId, device.productName],
  );
  assert.deepEqual(fresh.sent, []);
  assert.equal(fresh.attempts, 0);
  assert.deepEqual(firmware.live, NEUTRAL);
  assert.deepEqual(firmware.committed, NEUTRAL);
  assert.deepEqual(await hid.getDevices(), [fresh]);
  // The old device keeps its history.
  assert.equal(device.sent.length, 19);
});

test('replug with nothing committed goes back to the factory curve', async () => {
  const { firmware, device, hid } = setup();
  await send(device, peakReports());
  const fresh = hid.replug(device);
  assert.equal(firmware.live, null);
  assert.equal(fresh.firmware.live, null);
  assert.deepEqual(await hid.getDevices(), [], 'an ungranted device stays ungranted');
});

test('replug clears the report buffer (RAM is lost)', async () => {
  const { firmware, device, hid } = setup();
  const reports = neutralReports();
  await send(device, reports.slice(0, 8));
  const fresh = hid.replug(device);
  await send(fresh, reports.slice(8));
  assert.equal(firmware.live, null);
  assert.equal(firmware.appliedCount, 0);
  assert.equal(firmware.rejectedCrcCount, 1);
});

test('replug of an already unplugged device only fires connect; options override', async () => {
  const { firmware, device, hid } = setup({ committed: PEAK });
  hid.disconnect(device);
  const events = [];
  hid.addEventListener('disconnect', () => events.push('disconnect'));
  hid.addEventListener('connect', () => events.push('connect'));
  const fresh = hid.replug(device, { throwAtReport: 0 });
  assert.deepEqual(events, ['connect']);
  assert.equal(fresh.faults.throwAtReport, 0);
  await fresh.open();
  await assert.rejects(fresh.sendReport(HID_REPORT_ID, neutralReports()[0]), {
    name: 'NotAllowedError',
  });
  assert.deepEqual(firmware.live, PEAK);
});

test('a bad CRC is silently ignored: the previous curve stays', async () => {
  const { firmware, device } = setup();
  await send(device, [...peakReports(), commitReport()]);
  await send(device, corruptedCrc(neutralReports()));
  assert.deepEqual(firmware.live, PEAK);
  assert.deepEqual(firmware.committed, PEAK);
  assert.equal(firmware.rejectedCrcCount, 1);
  assert.equal(firmware.appliedCount, 1);
  // A commit after the rejected sequence persists the curve still playing.
  await send(device, [commitReport()]);
  assert.deepEqual(firmware.committed, PEAK);
  assert.equal(firmware.commitCount, 2);
});

test('partial sequences (0..6, 0..7) change nothing; a following full one applies', async () => {
  const { firmware, device } = setup({ committed: PEAK });
  const reports = neutralReports();
  await send(device, reports.slice(0, 7));
  assert.deepEqual(firmware.live, PEAK);
  await send(device, reports.slice(0, 8));
  assert.deepEqual(firmware.live, PEAK);
  assert.equal(firmware.appliedCount, 0);
  assert.equal(firmware.rejectedCrcCount, 0);
  await send(device, reports);
  assert.deepEqual(firmware.live, NEUTRAL);
  assert.equal(firmware.appliedCount, 1);
  assert.deepEqual(firmware.committed, PEAK);
});

test('a report lost before report 8 (disconnect) leaves the previous curve', async () => {
  const clock = createFakeClock(0, { autoAdvance: true });
  const firmware = new FakeFirmware({ committed: PEAK });
  const device = new FakeHIDDevice({ clock, firmware, disconnectAtReport: 8 });
  await device.open();
  const reports = neutralReports();
  for (const report of reports.slice(0, 8)) await device.sendReport(HID_REPORT_ID, report);
  await assert.rejects(device.sendReport(HID_REPORT_ID, reports[8]), { name: 'NetworkError' });
  assert.deepEqual(firmware.live, PEAK);
  assert.equal(firmware.appliedCount, 0);
});

test('applyOn 7: the curve takes effect on report 7, report 8 is just buffered', () => {
  const firmware = new FakeFirmware({ applyOn: 7 });
  const reports = neutralReports();
  for (const report of reports.slice(0, 7)) firmware.receive(report);
  assert.equal(firmware.live, null);
  firmware.receive(reports[7]);
  assert.deepEqual(firmware.live, NEUTRAL);
  assert.equal(firmware.appliedCount, 1);
  firmware.receive(reports[8]);
  assert.equal(firmware.appliedCount, 1);
  for (const report of corruptedCrc(peakReports()).slice(0, 8)) firmware.receive(report);
  assert.deepEqual(firmware.live, NEUTRAL);
  assert.equal(firmware.rejectedCrcCount, 1);
});

test('report 8 re-sent alone re-applies the buffered curve (a RAM buffer)', () => {
  const firmware = new FakeFirmware();
  const reports = peakReports();
  for (const report of reports) firmware.receive(report);
  firmware.receive(reports[8]);
  assert.deepEqual(firmware.live, PEAK);
  assert.equal(firmware.appliedCount, 2);
});

test('short data reports are zero-padded', () => {
  const firmware = new FakeFirmware();
  const reports = neutralReports();
  // Report 7 carries 10 payload bytes and report 8 none: trimmed reports still apply.
  const trimmed = [...reports.slice(0, 7), reports[7].slice(0, 11), reports[8].slice(0, 1)];
  for (const report of trimmed) firmware.receive(report);
  assert.deepEqual(firmware.live, NEUTRAL);
});

test('unknown reports are ignored and recorded', () => {
  const firmware = new FakeFirmware();
  const unknown = new Uint8Array(31);
  unknown[0] = 9;
  firmware.receive(unknown);
  firmware.receive(new Uint8Array(0));
  assert.deepEqual(firmware.ignored, [
    { bytes: unknown, reason: 'unknown-report' },
    { bytes: new Uint8Array(0), reason: 'unknown-report' },
  ]);
  assert.equal(firmware.live, null);
  assert.equal(firmware.appliedCount + firmware.rejectedCrcCount, 0);
});

test('the initial committed payload is also the initial live curve', () => {
  const firmware = new FakeFirmware({ committed: [...PEAK] });
  assert.deepEqual(firmware.committed, PEAK);
  assert.deepEqual(firmware.live, PEAK);
});

test('constructor options are validated', () => {
  assert.throws(() => new FakeFirmware({ applyOn: 6 }), RangeError);
  assert.throws(() => new FakeFirmware({ committed: new Uint8Array(219) }), RangeError);
});

test('getters return copies', () => {
  const firmware = new FakeFirmware({ committed: PEAK });
  firmware.live[0] ^= 0xff;
  firmware.committed[0] ^= 0xff;
  firmware.receive(new Uint8Array([9]));
  firmware.ignored[0].bytes[0] = 0;
  assert.deepEqual(firmware.live, PEAK);
  assert.deepEqual(firmware.committed, PEAK);
  assert.deepEqual(firmware.ignored[0].bytes, new Uint8Array([9]));
  // The caller's buffer is copied too.
  const source = PEAK.slice();
  const other = new FakeFirmware({ committed: source });
  source[0] ^= 0xff;
  assert.deepEqual(other.committed, PEAK);
});

test('every FakeHIDDevice gets its own factory firmware by default', async () => {
  const a = new FakeHIDDevice();
  const b = new FakeHIDDevice();
  assert.ok(a.firmware instanceof FakeFirmware);
  assert.notEqual(a.firmware, b.firmware);
  await send(a, neutralReports());
  assert.deepEqual(a.firmware.live, NEUTRAL);
  assert.equal(b.firmware.live, null);
});

test('the firmware gets its own copy of each delivered report', async () => {
  const { firmware, device } = setup();
  const reports = neutralReports();
  await send(device, reports);
  device.sent[0].bytes[1] ^= 0xff;
  reports[0][1] ^= 0xff;
  firmware.receive(reports[8]);
  assert.deepEqual(firmware.live, NEUTRAL);
});
