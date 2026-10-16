import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  USB_VID,
  USB_PID,
  HID_REPORT_ID,
  NEUTRAL_BANDS,
  commitReport,
  encodeReports,
} from '../../src/dsp/eq0xcb.mjs';
import {
  ConcurrentWriteError,
  DeviceDisconnectedError,
  GateRejectedError,
  PRODUCT_NAME,
  REPORT_GAP_MS,
  SETTLE_MS,
  WRITE_SPACING_MS,
  requestCable,
  systemClock,
  writeCurve,
  writeMany,
} from '../../src/transport/webhid.mjs';
import {
  FAKE_PRODUCT_NAME,
  FakeHID,
  FakeHIDConnectionEvent,
  FakeHIDDevice,
  createFakeClock,
} from '../../src/transport/fake-device.mjs';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);
const presetIds = Object.keys(fixture.presets);
const COMMIT = [...commitReport()];

const approve = () => ({ ok: true, reasons: [] });

function countingGate(verdict = { ok: true, reasons: [] }) {
  const calls = [];
  const gate = (bands, preampDb, options) => {
    calls.push({ bands, preampDb, options });
    return verdict;
  };
  return { gate, calls };
}

function setup(deviceOptions = {}, { autoAdvance = true } = {}) {
  const clock = createFakeClock(0, { autoAdvance });
  const device = new FakeHIDDevice({ clock, ...deviceOptions });
  const hid = new FakeHID({ devices: [device] });
  return { clock, device, hid };
}

const bytesOf = (device) => device.sent.map(({ bytes }) => [...bytes]);
const isCommit = (bytes) =>
  bytes.length === COMMIT.length && bytes.every((b, i) => b === COMMIT[i]);

// --- Exact bytes and timing --------------------------------------------------

test('sends the fixture reports plus the commit for the 11 official presets', async () => {
  assert.equal(presetIds.length, 11);
  for (const id of presetIds) {
    const { preampDb, eqBands, reports, payload } = fixture.presets[id];
    const { clock, device, hid } = setup();
    const result = await writeCurve(device, eqBands, preampDb, { gate: approve, clock, hid });
    assert.equal(result.status, 'ok', id);
    assert.equal(result.reportsSent, 9, id);
    assert.equal(result.committed, true, id);
    assert.equal(result.crc, payload[218] | (payload[219] << 8), id);
    assert.equal(result.error, undefined, id);
    assert.deepEqual(bytesOf(device), [...reports, COMMIT], id);
    assert.ok(
      device.sent.every(({ reportId }) => reportId === HID_REPORT_ID),
      id,
    );
    assert.ok(
      device.sent.every(({ bytes }) => bytes.length === 31),
      id,
    );
  }
});

test('timing: 16 ms between reports, 150 ms settle, ~0.29 s in total', async () => {
  for (const id of presetIds) {
    const { preampDb, eqBands } = fixture.presets[id];
    const { clock, device, hid } = setup({}, { autoAdvance: true });
    const result = await writeCurve(device, eqBands, preampDb, { gate: approve, clock, hid });
    const times = device.sent.map(({ at }) => at);
    assert.equal(times.length, 10);
    assert.equal(times[0], result.startedAt);
    for (let i = 1; i < 9; i++) {
      assert.ok(Math.abs(times[i] - times[i - 1] - 16) <= 5, `${id} gap ${i}`);
    }
    // Sequence per docs/protocol-0xcb.md: 16 ms after each report, then 150 ms.
    const settle = times[9] - (times[8] + REPORT_GAP_MS);
    assert.ok(Math.abs(settle - 150) <= 5, `${id} settle ${settle}`);
    const total = result.finishedAt - result.startedAt;
    assert.ok(total >= 280 && total <= 300, `${id} total ${total}`);
  }
  assert.equal(REPORT_GAP_MS, 16);
  assert.equal(SETTLE_MS, 150);
});

test('opens a closed device and does not reopen an open one', async () => {
  const { clock, device, hid } = setup();
  assert.equal(device.opened, false);
  await writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  assert.equal(device.opened, true);
  let opens = 0;
  const open = device.open.bind(device);
  device.open = () => {
    opens += 1;
    return open();
  };
  const again = await writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  assert.equal(again.status, 'ok');
  assert.equal(opens, 0);
});

// --- Gate --------------------------------------------------------------------

test('missing gate: throws before any I/O', async () => {
  const { clock, device, hid } = setup();
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, 0, { clock, hid }), TypeError);
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, 0), TypeError);
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, 0, { gate: { ok: true }, clock, hid }),
    TypeError,
  );
  assert.equal(device.attempts, 0);
  assert.equal(device.opened, false);
});

test('rejecting gate: GateRejectedError with reasons, nothing sent', async () => {
  const { clock, device, hid } = setup();
  const reasons = ['clipping', { code: 'Q_TOO_HIGH', band: 2 }];
  const { gate, calls } = countingGate({ ok: false, reasons });
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, 0, { gate, clock, hid }), (error) => {
    assert.ok(error instanceof GateRejectedError);
    assert.deepEqual(error.reasons, reasons);
    assert.match(error.message, /clipping; \{"code":"Q_TOO_HIGH","band":2\}/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(device.attempts, 0);
  assert.equal(device.opened, false);
});

test('gate verdicts other than ok === true are rejections', async () => {
  const { clock, device, hid } = setup();
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, 0, { gate: () => ({ ok: 'yes' }), clock, hid }),
    (error) => error instanceof GateRejectedError && /no reason given/.test(error.message),
  );
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, 0, { gate: () => null, clock, hid }),
    TypeError,
  );
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, 0, { gate: () => true, clock, hid }),
    TypeError,
  );
  assert.equal(device.attempts, 0);
});

test('the gate is re-run inside writeCurve even if the caller validated', async () => {
  const { clock, device, hid } = setup();
  const { gate, calls } = countingGate();
  const bands = fixture.presets.padrao.eqBands;
  assert.equal(gate(bands, -2.8, { experimental: false }).ok, true); // caller's own check
  await writeCurve(device, bands, -2.8, { gate, clock, hid });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].bands, bands);
  assert.equal(calls[1].preampDb, -2.8);
  assert.deepEqual(calls[1].options, { experimental: false });
  await writeCurve(device, bands, -2.8, { gate, clock, hid, experimental: true });
  assert.deepEqual(calls[2].options, { experimental: true });
  await writeCurve(device, bands, -2.8, { gate, clock, hid, experimental: 'yes' });
  assert.deepEqual(calls[3].options, { experimental: false });
});

test('bands the codec refuses throw before any I/O', async () => {
  const { clock, device, hid } = setup();
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, 3, { gate: approve, clock, hid }),
    RangeError,
  );
  assert.equal(device.attempts, 0);
});

// --- Interruptions -----------------------------------------------------------

test('disconnect at each report 0..9 interrupts without committing', async () => {
  for (let at = 0; at <= 9; at++) {
    const { clock, device, hid } = setup({ disconnectAtReport: at });
    const events = [];
    hid.addEventListener('disconnect', (event) => events.push(event.device));
    const result = await writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
    assert.equal(result.status, 'interrupted', `at ${at}`);
    assert.equal(result.committed, false, `at ${at}`);
    assert.equal(result.reportsSent, at, `at ${at}`);
    assert.equal(device.attempts, at + 1, `at ${at}`);
    assert.equal(device.sent.length, at, `at ${at}`);
    assert.ok(!bytesOf(device).some(isCommit), `at ${at}`);
    assert.ok(result.error instanceof DOMException, `at ${at}`);
    assert.equal(result.error.name, 'NetworkError');
    assert.deepEqual(events, [device]);
    assert.ok(result.finishedAt >= result.startedAt);
  }
});

test("a 'disconnect' event for the device stops the sequence while it sleeps", async () => {
  const { clock, device } = setup({}, { autoAdvance: false });
  const hid = new EventTarget();
  const pending = writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  await clock.advance(20);
  hid.dispatchEvent(new FakeHIDConnectionEvent('disconnect', { device }));
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.ok(result.error instanceof DeviceDisconnectedError);
  assert.equal(result.reportsSent, 2);
  assert.equal(result.committed, false);
  assert.equal(device.sent.length, 2);
  assert.equal(clock.pending(), 0);
});

test("'disconnect' events for other devices are ignored", async () => {
  const { clock, device } = setup();
  const other = new FakeHIDDevice({ clock });
  const hid = new EventTarget();
  const pending = writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  hid.dispatchEvent(new FakeHIDConnectionEvent('disconnect', { device: other }));
  hid.dispatchEvent(new Event('disconnect'));
  const result = await pending;
  assert.equal(result.status, 'ok');
  assert.equal(device.sent.length, 10);
});

test('a device closed mid-sequence is treated as disconnected', async () => {
  const { clock, device, hid } = setup({}, { autoAdvance: false });
  const pending = writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  await clock.advance(20);
  await device.close();
  await clock.advance(400);
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.ok(result.error instanceof DeviceDisconnectedError);
  assert.equal(result.reportsSent, 2);
  assert.equal(device.sent.length, 2);
});

test('sendReport failing interrupts and keeps the error', async () => {
  const failure = new DOMException('boom', 'NotAllowedError');
  for (const throwError of [undefined, failure]) {
    const { clock, device, hid } = setup({ throwAtReport: 3, throwError });
    const result = await writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
    assert.equal(result.status, 'interrupted');
    assert.equal(result.reportsSent, 3);
    assert.equal(result.committed, false);
    assert.equal(device.sent.length, 3);
    assert.ok(result.error instanceof DOMException);
    if (throwError) assert.equal(result.error, failure);
  }
});

test('open failing is an interruption with nothing sent', async () => {
  const openError = new DOMException('busy', 'InvalidStateError');
  const { clock, device, hid } = setup({ openError });
  const result = await writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.error, openError);
  assert.equal(result.reportsSent, 0);
  assert.equal(device.attempts, 0);
});

test('TypeErrors from the device are rethrown and release the device', async () => {
  const bug = new TypeError('bad argument');
  const { clock, device, hid } = setup({ throwAtReport: 1, throwError: bug });
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid }), bug);
  assert.ok(!bytesOf(device).some(isCommit));
  device.faults.throwAtReport = undefined;
  const result = await writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  assert.equal(result.status, 'ok');
});

test('abort before start: throws and sends nothing', async () => {
  const { clock, device, hid } = setup();
  const controller = new AbortController();
  controller.abort();
  const { gate, calls } = countingGate();
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, 0, { gate, clock, hid, signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(device.attempts, 0);
  assert.equal(calls.length, 0);
});

test('abort mid-way: interrupted, no commit', async () => {
  for (const [advanceMs, expectedSent] of [
    [40, 3],
    [200, 9],
  ]) {
    const { clock, device, hid } = setup({}, { autoAdvance: false });
    const controller = new AbortController();
    const pending = writeCurve(device, NEUTRAL_BANDS, 0, {
      gate: approve,
      clock,
      hid,
      signal: controller.signal,
    });
    await clock.advance(advanceMs);
    controller.abort();
    const result = await pending;
    assert.equal(result.status, 'interrupted');
    assert.equal(result.error.name, 'AbortError');
    assert.equal(result.reportsSent, expectedSent);
    assert.equal(result.committed, false);
    assert.equal(device.sent.length, expectedSent);
    assert.equal(clock.pending(), 0);
  }
});

// --- Concurrency -------------------------------------------------------------

test('a concurrent write on the same device is refused and sends nothing', async () => {
  const { clock, device, hid } = setup();
  const first = writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  const { gate, calls } = countingGate();
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, 0, { gate, clock, hid }),
    ConcurrentWriteError,
  );
  assert.equal(calls.length, 0);
  const result = await first;
  assert.equal(result.status, 'ok');
  assert.equal(device.sent.length, 10);
  const next = await writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  assert.equal(next.status, 'ok');
});

test('writes to different devices may run concurrently', async () => {
  const clock = createFakeClock(0, { autoAdvance: true });
  const a = new FakeHIDDevice({ clock });
  const b = new FakeHIDDevice({ clock });
  const hid = new FakeHID({ devices: [a, b] });
  const results = await Promise.all(
    [a, b].map((device) => writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid })),
  );
  assert.deepEqual(
    results.map(({ status }) => status),
    ['ok', 'ok'],
  );
  assert.deepEqual(bytesOf(a), bytesOf(b));
});

// --- writeMany ---------------------------------------------------------------

function manyDevices(count, faultsByIndex = {}, { autoAdvance = true } = {}) {
  const clock = createFakeClock(0, { autoAdvance });
  const make = (index) => new FakeHIDDevice({ clock, ...faultsByIndex[index] });
  const devices = Array.from({ length: count }, (_, index) => make(index));
  return { clock, devices, hid: new FakeHID({ devices }) };
}

test('writeMany writes sequentially, >= 2 s apart', async () => {
  const { clock, devices, hid } = manyDevices(3);
  const { preampDb, eqBands, reports } = fixture.presets.harman;
  const results = await writeMany(devices, eqBands, preampDb, { gate: approve, clock, hid });
  assert.deepEqual(
    results.map(({ status }) => status),
    ['ok', 'ok', 'ok'],
  );
  assert.deepEqual(
    results.map(({ device }) => device),
    devices,
  );
  for (const device of devices) assert.deepEqual(bytesOf(device), [...reports, COMMIT]);
  for (let i = 1; i < devices.length; i++) {
    const previousEnd = results[i - 1].finishedAt;
    assert.ok(results[i].startedAt - previousEnd >= WRITE_SPACING_MS);
    assert.ok(devices[i].sent[0].at - devices[i - 1].sent[9].at >= WRITE_SPACING_MS);
  }
  assert.equal(WRITE_SPACING_MS, 2000);
});

test('writeMany stops at the first failure and skips the rest', async () => {
  const { clock, devices, hid } = manyDevices(4, { 1: { throwAtReport: 2 } });
  const results = await writeMany(devices, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  assert.deepEqual(
    results.map(({ status }) => status),
    ['ok', 'interrupted', 'skipped', 'skipped'],
  );
  assert.equal(results[1].committed, false);
  assert.ok(results[1].error instanceof DOMException);
  assert.deepEqual(
    results.map(({ device }) => device),
    devices,
  );
  assert.equal(devices[2].attempts, 0);
  assert.equal(devices[3].attempts, 0);
  assert.equal(devices[2].opened, false);
});

test('writeMany reports a busy device as failed', async () => {
  const { clock, devices, hid } = manyDevices(2);
  const busy = writeCurve(devices[0], NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  const results = await writeMany(devices, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  assert.equal(results[0].status, 'failed');
  assert.ok(results[0].error instanceof ConcurrentWriteError);
  assert.equal(results[1].status, 'skipped');
  assert.equal(devices[1].attempts, 0);
  assert.equal((await busy).status, 'ok');
});

test('writeMany refuses without an approving gate and touches no device', async () => {
  const { clock, devices, hid } = manyDevices(2);
  await assert.rejects(writeMany(devices, NEUTRAL_BANDS, 0, { clock, hid }), TypeError);
  await assert.rejects(writeMany(devices, NEUTRAL_BANDS, 0), TypeError);
  const { gate, calls } = countingGate({ ok: false, reasons: ['nope'] });
  await assert.rejects(
    writeMany(devices, NEUTRAL_BANDS, 0, { gate, clock, hid }),
    GateRejectedError,
  );
  assert.equal(calls.length, 1);
  assert.ok(devices.every((device) => device.attempts === 0 && !device.opened));
});

test('writeMany re-runs the gate for every device', async () => {
  const { clock, devices, hid } = manyDevices(2);
  const { gate, calls } = countingGate();
  await writeMany(devices, NEUTRAL_BANDS, 0, { gate, clock, hid, experimental: true });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ options }) => options.experimental === true));
});

test('writeMany: abort before start throws, abort between writes fails the next', async () => {
  const before = manyDevices(2);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    writeMany(before.devices, NEUTRAL_BANDS, 0, {
      gate: approve,
      clock: before.clock,
      hid: before.hid,
      signal: aborted.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(before.devices[0].attempts, 0);

  const { clock, devices, hid } = manyDevices(3, {}, { autoAdvance: false });
  const controller = new AbortController();
  const pending = writeMany(devices, NEUTRAL_BANDS, 0, {
    gate: approve,
    clock,
    hid,
    signal: controller.signal,
  });
  await clock.advance(300);
  await clock.advance(1000);
  controller.abort();
  const results = await pending;
  assert.deepEqual(
    results.map(({ status }) => status),
    ['ok', 'failed', 'skipped'],
  );
  assert.equal(results[1].error.name, 'AbortError');
  assert.equal(devices[1].attempts, 0);
});

test('writeMany rethrows TypeErrors and unexpected clock errors', async () => {
  const bug = new TypeError('bug');
  const first = manyDevices(2, { 1: { throwAtReport: 0, throwError: bug } });
  await assert.rejects(
    writeMany(first.devices, NEUTRAL_BANDS, 0, {
      gate: approve,
      clock: first.clock,
      hid: first.hid,
    }),
    bug,
  );

  const clockError = new Error('clock broke');
  const { devices, hid } = manyDevices(2);
  const brokenClock = {
    now: () => 0,
    sleep: (ms) => (ms === WRITE_SPACING_MS ? Promise.reject(clockError) : Promise.resolve()),
  };
  await assert.rejects(
    writeMany(devices, NEUTRAL_BANDS, 0, { gate: approve, clock: brokenClock, hid }),
    clockError,
  );
  assert.equal(devices[1].attempts, 0);
});

test('writeMany with no devices returns an empty list', async () => {
  assert.deepEqual(await writeMany([], NEUTRAL_BANDS, 0, { gate: approve }), []);
});

// --- requestCable ------------------------------------------------------------

test('requestCable filters on the cable VID/PID and returns the first device', async () => {
  const { device, hid } = setup();
  const stranger = new FakeHIDDevice({ vendorId: 0x1234 });
  hid.addDevice(stranger);
  assert.equal(await requestCable(hid), device);
  assert.deepEqual(hid.requests, [{ filters: [{ vendorId: USB_VID, productId: USB_PID }] }]);
  assert.deepEqual(await hid.getDevices(), [device]);
  assert.equal(USB_VID, 0x3302);
  assert.equal(USB_PID, 0x8902);
  assert.equal(PRODUCT_NAME, 'USB DSP Audio');
});

test('requestCable returns null when nothing is chosen or matches', async () => {
  const cancelled = new FakeHID({ devices: [new FakeHIDDevice()], choose: () => [] });
  assert.equal(await requestCable(cancelled), null);
  const unrelated = new FakeHID({ devices: [new FakeHIDDevice({ productId: 1 })] });
  assert.equal(await requestCable(unrelated), null);
});

test('requestCable without WebHID throws', async () => {
  assert.equal(globalThis.navigator?.hid, undefined);
  await assert.rejects(requestCable(), /WebHID is not available/);
});

// --- systemClock -------------------------------------------------------------

test('systemClock drives a real write with the same bytes', async () => {
  const device = new FakeHIDDevice({ clock: systemClock });
  const { preampDb, eqBands, reports } = fixture.presets.padrao;
  const result = await writeCurve(device, eqBands, preampDb, { gate: approve });
  assert.equal(result.status, 'ok');
  assert.deepEqual(bytesOf(device), [...reports, COMMIT]);
  const total = result.finishedAt - result.startedAt;
  assert.ok(total >= 280, `total ${total}`);
});

test('systemClock.sleep honours AbortSignal', async () => {
  assert.equal(typeof systemClock.now(), 'number');
  await systemClock.sleep(1);
  const done = new AbortController();
  done.abort(new Error('early'));
  await assert.rejects(systemClock.sleep(10, done.signal), /early/);
  const controller = new AbortController();
  const pending = systemClock.sleep(10_000, controller.signal);
  controller.abort(new Error('late'));
  await assert.rejects(pending, /late/);
  await systemClock.sleep(1, new AbortController().signal);
});

// --- Fake clock --------------------------------------------------------------

test('fake clock: manual mode only moves on advance', async () => {
  const clock = createFakeClock(100);
  assert.equal(clock.now(), 100);
  const woke = [];
  clock.sleep(10).then(() => woke.push(['a', clock.now()]));
  clock.sleep(5).then(() => woke.push(['b', clock.now()]));
  clock.sleep(5).then(() => woke.push(['c', clock.now()]));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(woke, []);
  assert.equal(clock.pending(), 3);
  await clock.advance(7);
  assert.deepEqual(woke, [
    ['b', 105],
    ['c', 105],
  ]);
  assert.equal(clock.now(), 107);
  await clock.advance(3);
  assert.deepEqual(woke.at(-1), ['a', 110]);
  assert.equal(clock.pending(), 0);
});

test('fake clock: auto-advance wakes sleepers in order at exact times', async () => {
  const clock = createFakeClock(0, { autoAdvance: true });
  const woke = [];
  await Promise.all([
    clock.sleep(30).then(() => woke.push(clock.now())),
    clock.sleep(10).then(() => woke.push(clock.now())),
    clock.sleep(20).then(() => woke.push(clock.now())),
  ]);
  assert.deepEqual(woke, [10, 20, 30]);
});

test('fake clock: zero, invalid and aborted sleeps', async () => {
  const clock = createFakeClock();
  await clock.sleep(0);
  await assert.rejects(clock.sleep(-1), RangeError);
  await assert.rejects(clock.sleep(Number.NaN), RangeError);
  await assert.rejects(clock.advance(-1), RangeError);
  const done = new AbortController();
  done.abort(new Error('early'));
  await assert.rejects(clock.sleep(5, done.signal), /early/);
  const controller = new AbortController();
  const pending = clock.sleep(5, controller.signal);
  assert.equal(clock.pending(), 1);
  controller.abort(new Error('late'));
  await assert.rejects(pending, /late/);
  assert.equal(clock.pending(), 0);
  const signalled = clock.sleep(5, new AbortController().signal);
  await clock.advance(5);
  await signalled;
});

// --- Fake device and fake HID ------------------------------------------------

test('fake device: identity and descriptor match the cable', () => {
  const device = new FakeHIDDevice();
  assert.equal(device.vendorId, 0x3302);
  assert.equal(device.productId, 0x8902);
  assert.equal(device.productName, 'USB DSP Audio');
  assert.equal(FAKE_PRODUCT_NAME, PRODUCT_NAME);
  assert.deepEqual(device.collections[0].outputReports, [
    { reportId: 0xcb, items: [{ reportSize: 8, reportCount: 31 }] },
  ]);
  assert.equal(device.opened, false);
  assert.equal(device.connected, true);
  assert.ok(device instanceof EventTarget);
});

test('fake device: sendReport validation and byte copies', async () => {
  const device = new FakeHIDDevice();
  const report = encodeReports(NEUTRAL_BANDS, 0)[0];
  await assert.rejects(device.sendReport(HID_REPORT_ID, report), { name: 'InvalidStateError' });
  await device.open();
  await assert.rejects(device.sendReport(256, report), TypeError);
  await assert.rejects(device.sendReport(1.5, report), TypeError);
  await assert.rejects(device.sendReport(HID_REPORT_ID, [1, 2]), TypeError);
  await assert.rejects(device.sendReport(0x4b, report), { name: 'NotAllowedError' });
  await assert.rejects(device.sendReport(HID_REPORT_ID, new Uint8Array(32)), {
    name: 'NotAllowedError',
  });
  assert.equal(device.attempts, 0);

  const original = [...report];
  await device.sendReport(HID_REPORT_ID, report);
  report[1] = 0xee;
  await device.sendReport(HID_REPORT_ID, new Uint8Array([1, 2, 3, 4]).subarray(1, 3));
  await device.sendReport(HID_REPORT_ID, new Uint8Array([9, 8]).buffer);
  assert.deepEqual(bytesOf(device), [original, [2, 3], [9, 8]]);
  const copy = device.sent;
  copy.length = 0;
  assert.equal(device.sent.length, 3);
  await device.close();
  assert.equal(device.opened, false);
});

test('fake device: delayMs holds sendReport on the clock', async () => {
  const clock = createFakeClock();
  const device = new FakeHIDDevice({ clock, delayMs: 8 });
  await device.open();
  let done = false;
  const pending = device.sendReport(HID_REPORT_ID, new Uint8Array(31)).then(() => {
    done = true;
  });
  await clock.advance(7);
  assert.equal(done, false);
  await clock.advance(1);
  await pending;
  assert.equal(done, true);
  assert.equal(device.sent[0].at, 0);
});

test('fake device: delayMs slows a full write accordingly', async () => {
  const { clock, device, hid } = setup({ delayMs: 2 });
  const result = await writeCurve(device, NEUTRAL_BANDS, 0, { gate: approve, clock, hid });
  assert.equal(result.status, 'ok');
  assert.equal(result.finishedAt - result.startedAt, 9 * (2 + 16) + 150 + 2);
});

test('fake device: unplugging is idempotent and blocks open', async () => {
  const { device, hid } = setup();
  const events = [];
  hid.addEventListener('disconnect', (event) => events.push(event.device));
  await device.open();
  hid.disconnect(device);
  hid.disconnect(device);
  assert.deepEqual(events, [device]);
  assert.equal(device.opened, false);
  assert.equal(device.connected, false);
  await assert.rejects(device.open(), { name: 'NotFoundError' });
  assert.deepEqual(await hid.getDevices(), []);
  assert.equal(await requestCable(hid), null);
  // A device that belongs to no FakeHID can still be unplugged.
  new FakeHIDDevice().disconnect();
});

test('fake HID: connect events, filter validation and empty filters', async () => {
  const hid = new FakeHID();
  const connected = [];
  hid.addEventListener('connect', (event) => connected.push(event.device));
  const device = new FakeHIDDevice();
  const other = new FakeHIDDevice({ vendorId: 1, productId: 2 });
  hid.addDevice(device);
  hid.addDevice(other);
  assert.deepEqual(connected, [device, other]);
  await assert.rejects(hid.requestDevice(), TypeError);
  await assert.rejects(hid.requestDevice(null), TypeError);
  await assert.rejects(hid.requestDevice({}), TypeError);
  assert.deepEqual(await hid.requestDevice({ filters: [] }), [device]);
  assert.deepEqual(await hid.requestDevice({ filters: [{ productId: 2 }] }), [other]);
  assert.deepEqual(await hid.requestDevice({ filters: [{ vendorId: 1 }] }), [other]);
  assert.deepEqual(await hid.getDevices(), [device, other]);
  const asyncChooser = new FakeHID({ devices: [device], choose: async (matching) => matching });
  assert.deepEqual(await asyncChooser.requestDevice({ filters: [] }), [device]);
});
