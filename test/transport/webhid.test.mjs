import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  USB_VID,
  USB_PID,
  HID_REPORT_ID,
  NEUTRAL_BANDS,
  commitReport,
  encodePayload,
  encodeReports,
  reportsFromPayload,
} from '../../src/dsp/eq0xcb.mjs';
import { gateForWrite } from '../../src/safety/gate.mjs';
import {
  ConcurrentWriteError,
  DeviceDisconnectedError,
  DeviceUnusableError,
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
// Neutro preamp: the highest the real gate accepts (THRESHOLDS.preampMaxDb).
const PRE = -0.5;

// An approving extra gate: the real gateForWrite still runs first and decides.
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
  await writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
  assert.equal(device.opened, true);
  let opens = 0;
  const open = device.open.bind(device);
  device.open = () => {
    opens += 1;
    return open();
  };
  const again = await writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
  assert.equal(again.status, 'ok');
  assert.equal(opens, 0);
});

// --- Gate --------------------------------------------------------------------

// Contract change (M1): the real gateForWrite always runs inside the transport;
// `gate` is optional and only an additional check.
test('no injected gate: the real gate alone decides; a non-function gate throws', async () => {
  const { clock, device, hid } = setup();
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, PRE, { gate: { ok: true }, clock, hid }),
    TypeError,
  );
  assert.equal(device.attempts, 0);
  assert.equal(device.opened, false);
  // Neutro at 0 dB fails g:preamp in the real gate: refused without any injected gate.
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, 0, { clock, hid }), (error) => {
    assert.ok(error instanceof GateRejectedError);
    assert.deepEqual(error.reasons, gateForWrite(NEUTRAL_BANDS, 0).reasons);
    return true;
  });
  assert.equal(device.attempts, 0);
  const result = await writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
  assert.equal(result.status, 'ok');
  const expected = encodeReports(NEUTRAL_BANDS, PRE).map((report) => [...report]);
  assert.deepEqual(bytesOf(device), [...expected, COMMIT]);
});

test('M1: an approving stub cannot make a failing curve send anything', async () => {
  for (const [id, p] of Object.entries(fixture.presets)) {
    const reversed = [...p.eqBands].reverse();
    const verdict = gateForWrite(reversed, p.preampDb);
    assert.equal(verdict.ok, false, id);
    const { clock, device, hid } = setup();
    const { gate, calls } = countingGate();
    await assert.rejects(
      writeCurve(device, reversed, p.preampDb, { gate, clock, hid }),
      (error) => error instanceof GateRejectedError && error.reasons.length > 0,
    );
    await assert.rejects(
      writeMany([device], reversed, p.preampDb, { gate, clock, hid }),
      GateRejectedError,
    );
    assert.equal(calls.length, 0, id); // the real gate refused first
    assert.equal(device.attempts, 0, id);
    assert.equal(device.opened, false, id);
  }
});

test('M1: a rejecting stub still blocks a curve the real gate passes', async () => {
  const { preampDb, eqBands } = fixture.presets.harman;
  assert.ok(gateForWrite(eqBands, preampDb).ok);
  const { clock, device, hid } = setup();
  const { gate, calls } = countingGate({ ok: false, reasons: ['house rule'] });
  await assert.rejects(writeCurve(device, eqBands, preampDb, { gate, clock, hid }), {
    name: 'GateRejectedError',
    reasons: ['house rule'],
  });
  await assert.rejects(writeMany([device], eqBands, preampDb, { gate, clock, hid }), {
    name: 'GateRejectedError',
  });
  assert.equal(calls.length, 2);
  assert.equal(device.attempts, 0);
});

test('rejecting gate: GateRejectedError with reasons, nothing sent', async () => {
  const { clock, device, hid } = setup();
  const reasons = ['clipping', { code: 'Q_TOO_HIGH', band: 2 }];
  const { gate, calls } = countingGate({ ok: false, reasons });
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, PRE, { gate, clock, hid }), (error) => {
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
    writeCurve(device, NEUTRAL_BANDS, PRE, { gate: () => ({ ok: 'yes' }), clock, hid }),
    (error) => error instanceof GateRejectedError && /no reason given/.test(error.message),
  );
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, PRE, { gate: () => null, clock, hid }),
    TypeError,
  );
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, PRE, { gate: () => true, clock, hid }),
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
  // Contract change (C1): the extra gate receives the real gate's frozen
  // snapshot of the bands, not the caller's array.
  assert.notEqual(calls[1].bands, bands);
  assert.deepEqual(calls[1].bands, bands);
  assert.ok(Object.isFrozen(calls[1].bands) && calls[1].bands.every(Object.isFrozen));
  assert.equal(calls[1].preampDb, -2.8);
  assert.deepEqual(calls[1].options, { experimental: false });
  await writeCurve(device, bands, -2.8, { gate, clock, hid, experimental: true });
  assert.deepEqual(calls[2].options, { experimental: true });
  await writeCurve(device, bands, -2.8, { gate, clock, hid, experimental: 'yes' });
  assert.deepEqual(calls[3].options, { experimental: false });
});

// Contract change (M1): codec refusals now come from the real gate, as f:codec.
test('bands the codec refuses throw GateRejectedError (f:codec) before any I/O', async () => {
  const { clock, device, hid } = setup();
  const sparse = [...NEUTRAL_BANDS];
  delete sparse[3];
  for (const [bands, preampDb] of [
    [NEUTRAL_BANDS, 3],
    [sparse, PRE],
    ['nope', PRE],
    [[null, ...NEUTRAL_BANDS.slice(1)], PRE],
  ]) {
    await assert.rejects(
      writeCurve(device, bands, preampDb, { gate: approve, clock, hid }),
      (error) =>
        error instanceof GateRejectedError && error.reasons.some((r) => r.code === 'f:codec'),
    );
  }
  assert.equal(device.attempts, 0);
});

// --- C1: one read per field, bytes sent = bytes gated ----------------------------

const offTail = () => Array.from({ length: 9 }, () => ({ kind: 'OFF' }));
const sentPayload = (device) =>
  device.sent
    .slice(0, 9)
    .flatMap(({ bytes }) => [...bytes.slice(1)])
    .slice(0, 220);

test('C1: a getter gain is read once and the gated bytes are the bytes sent', async () => {
  let reads = 0;
  const band = {
    kind: 'PK',
    freqHz: 18000,
    qFactor: 1,
    get gainDb() {
      return reads++ === 0 ? -1 : 3;
    },
  };
  const { clock, device, hid } = setup();
  const result = await writeCurve(device, [band, ...offTail()], -4, { clock, hid });
  assert.equal(reads, 1);
  assert.equal(result.status, 'ok');
  const seen = [{ kind: 'PK', freqHz: 18000, gainDb: -1, qFactor: 1 }, ...offTail()];
  assert.deepEqual(sentPayload(device), encodePayload(seen, -4));
  // Boost first: D7 refuses and nothing is sent.
  let boostReads = 0;
  const boost = { kind: 'PK', freqHz: 18000, qFactor: 1 };
  Object.defineProperty(boost, 'gainDb', { get: () => (boostReads++ === 0 ? 3 : -1) });
  const other = setup();
  await assert.rejects(
    writeCurve(other.device, [boost, ...offTail()], -4, { clock: other.clock, hid: other.hid }),
    (error) =>
      error instanceof GateRejectedError && error.reasons[0].code === 'd7:pk-boost-above-16k',
  );
  assert.equal(boostReads, 1);
  assert.equal(other.device.attempts, 0);
});

test('C1: a getter kind cannot turn an approved PK into HS bytes', async () => {
  let reads = 0;
  const band = {
    get kind() {
      return reads++ === 0 ? 'PK' : 'HS';
    },
    freqHz: 8000,
    gainDb: -6,
    qFactor: 0.7,
  };
  const { clock, device, hid } = setup();
  const result = await writeCurve(device, [band, ...offTail()], -1, { clock, hid });
  assert.equal(result.status, 'ok');
  assert.equal(reads, 1);
  const pk = { kind: 'PK', freqHz: 8000, gainDb: -6, qFactor: 0.7 };
  assert.deepEqual(sentPayload(device), encodePayload([pk, ...offTail()], -1));
  const asHs = encodePayload([{ ...pk, kind: 'HS' }, ...offTail()], -1);
  assert.notDeepEqual(sentPayload(device), asHs);
});

test('C1: a stack-sniffing getter cannot send +12 dB', async () => {
  let reads = 0;
  const band = {
    kind: 'PK',
    freqHz: 1000,
    qFactor: 1,
    get gainDb() {
      reads++;
      const stack = String(new Error().stack);
      return /encodeReports|reportsFromPayload|sendSequence|encodePayload/.test(stack) ? 12 : -3;
    },
  };
  const { clock, device, hid } = setup();
  const extra = countingGate();
  const result = await writeCurve(device, [band, ...offTail()], -4, {
    gate: extra.gate,
    clock,
    hid,
  });
  assert.equal(result.status, 'ok');
  assert.equal(reads, 1);
  const cut = [{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 }, ...offTail()];
  assert.deepEqual(sentPayload(device), encodePayload(cut, -4));
  assert.deepEqual(
    device.sent.slice(0, 9).map(({ bytes }) => bytes),
    reportsFromPayload(encodePayload(cut, -4)),
  );
  assert.equal(extra.calls[0].bands[0].gainDb, -3);
});

test('C1: a Proxy band with random values per read: one read per field', async () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let run = 0; run < 5; run++) {
    const log = [];
    const band = new Proxy(
      {},
      {
        get(_, key) {
          const value = {
            kind: 'PK',
            freqHz: 200 + 5000 * random(),
            gainDb: -6 * random(),
            qFactor: 0.5 + random(),
          }[key];
          log.push([key, value]);
          return value;
        },
      },
    );
    const { clock, device, hid } = setup();
    const options = { gate: approve, clock, hid };
    const result = await writeCurve(device, [band, ...offTail()], -3, options);
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      log.map(([key]) => key),
      ['kind', 'freqHz', 'gainDb', 'qFactor'],
    );
    const plain = Object.fromEntries(log);
    const payload = encodePayload([plain, ...offTail()], -3);
    assert.deepEqual(sentPayload(device), payload);
    assert.equal(result.crc, payload[218] | (payload[219] << 8));
  }
});

test('C1: writeMany reads the caller bands once for all devices', async () => {
  let reads = 0;
  const band = {
    kind: 'PK',
    freqHz: 1000,
    qFactor: 1,
    get gainDb() {
      reads += 1;
      return reads === 1 ? -2 : 9;
    },
  };
  const { clock, devices, hid } = manyDevices(2);
  const results = await writeMany(devices, [band, ...offTail()], -3, { clock, hid });
  assert.equal(reads, 1);
  assert.deepEqual(
    results.map(({ status }) => status),
    ['ok', 'ok'],
  );
  const plain = [{ kind: 'PK', freqHz: 1000, gainDb: -2, qFactor: 1 }, ...offTail()];
  for (const device of devices) assert.deepEqual(sentPayload(device), encodePayload(plain, -3));
});

// --- Interruptions -----------------------------------------------------------

test('disconnect at each report 0..9 interrupts without committing', async () => {
  for (let at = 0; at <= 9; at++) {
    const { clock, device, hid } = setup({ disconnectAtReport: at });
    const events = [];
    hid.addEventListener('disconnect', (event) => events.push(event.device));
    const result = await writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
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
  const pending = writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
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
  const pending = writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
  hid.dispatchEvent(new FakeHIDConnectionEvent('disconnect', { device: other }));
  hid.dispatchEvent(new Event('disconnect'));
  const result = await pending;
  assert.equal(result.status, 'ok');
  assert.equal(device.sent.length, 10);
});

test('a device closed mid-sequence is treated as disconnected', async () => {
  const { clock, device, hid } = setup({}, { autoAdvance: false });
  const pending = writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
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
    const result = await writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
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
  const result = await writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.error, openError);
  assert.equal(result.reportsSent, 0);
  assert.equal(device.attempts, 0);
});

test('a TypeError before any report is accepted is rethrown and releases the device', async () => {
  const bug = new TypeError('bad argument');
  const { clock, device, hid } = setup({ throwAtReport: 0, throwError: bug });
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid }), bug);
  assert.equal(device.sent.length, 0);
  device.faults.throwAtReport = undefined;
  const result = await writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
  assert.equal(result.status, 'ok');
});

// Contract change (minor 3): after partial I/O nothing is thrown, so reportsSent survives.
test('a TypeError after an accepted report is returned as interrupted, not thrown', async () => {
  for (const at of [1, 5, 9]) {
    const bug = new TypeError('bad argument');
    const { clock, device, hid } = setup({ throwAtReport: at, throwError: bug });
    const result = await writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
    assert.equal(result.status, 'interrupted', `at ${at}`);
    assert.equal(result.error, bug);
    assert.equal(result.reportsSent, at);
    assert.equal(result.committed, false);
    assert.ok(!bytesOf(device).some(isCommit));
    device.faults.throwAtReport = undefined;
    assert.equal((await writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid })).status, 'ok');
  }
});

// --- Hung I/O (minor 2) ----------------------------------------------------------

test('abort interrupts a hung sendReport; the device is refused until re-requested', async () => {
  const { clock, device, hid } = setup({ hangAtReport: 3 }, { autoAdvance: false });
  const controller = new AbortController();
  const pending = writeCurve(device, NEUTRAL_BANDS, PRE, {
    clock,
    hid,
    signal: controller.signal,
  });
  await clock.advance(100);
  assert.equal(device.attempts, 4);
  assert.equal(device.sent.length, 3);
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.equal(result.error.name, 'AbortError');
  assert.equal(result.reportsSent, 3);
  assert.equal(result.committed, false);
  assert.equal(clock.pending(), 0);
  // The mutex is released, but the device fails fast with a clear error.
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }), DeviceUnusableError);
  const many = await writeMany([device], NEUTRAL_BANDS, PRE, { clock, hid });
  assert.equal(many[0].status, 'failed');
  assert.ok(many[0].error instanceof DeviceUnusableError);
  assert.equal(device.attempts, 4);
  // Choosing the device again through requestCable makes it usable.
  device.faults.hangAtReport = undefined;
  assert.equal(await requestCable(hid), device);
  const again = writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
  await clock.advance(400);
  assert.equal((await again).status, 'ok');
});

test('a disconnect interrupts a hung sendReport (data or commit) without committing', async () => {
  for (const hangAtReport of [0, 9]) {
    const { clock, device, hid } = setup({ hangAtReport }, { autoAdvance: false });
    const pending = writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
    await clock.advance(400);
    assert.equal(device.attempts, hangAtReport + 1);
    hid.disconnect(device);
    const result = await pending;
    assert.equal(result.status, 'interrupted');
    assert.ok(result.error instanceof DeviceDisconnectedError);
    assert.equal(result.reportsSent, hangAtReport);
    assert.equal(result.committed, false);
    assert.ok(!bytesOf(device).some(isCommit));
    await assert.rejects(
      writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }),
      DeviceUnusableError,
    );
  }
});

test('abort interrupts a hung open()', async () => {
  const { clock, device, hid } = setup({}, { autoAdvance: false });
  device.open = () => new Promise(() => undefined);
  const controller = new AbortController();
  const pending = writeCurve(device, NEUTRAL_BANDS, PRE, {
    clock,
    hid,
    signal: controller.signal,
  });
  await clock.advance(10);
  controller.abort(new Error('user cancelled'));
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.match(result.error.message, /user cancelled/);
  assert.equal(result.reportsSent, 0);
  assert.equal(device.attempts, 0);
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }), DeviceUnusableError);
});

test('an operation that settles right after the stop is not abandoned', async () => {
  // sendReport resolves in the same macrotask as the abort: its outcome wins and
  // the device stays usable.
  const { clock, device, hid } = setup({}, { autoAdvance: false });
  const controller = new AbortController();
  const send = device.sendReport.bind(device);
  device.sendReport = async (reportId, data) => {
    if (device.attempts === 2) controller.abort();
    return send(reportId, data);
  };
  const pending = writeCurve(device, NEUTRAL_BANDS, PRE, {
    clock,
    hid,
    signal: controller.signal,
  });
  await clock.advance(100);
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.equal(result.reportsSent, 3);
  assert.equal(device.sent.length, 3);
  device.sendReport = send;
  const again = writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
  await clock.advance(400);
  assert.equal((await again).status, 'ok');
});

test('a sendReport that throws synchronously is an interruption', async () => {
  const { clock, device, hid } = setup();
  const failure = new DOMException('sync', 'NotAllowedError');
  device.sendReport = () => {
    throw failure;
  };
  const result = await writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.error, failure);
  assert.equal(result.reportsSent, 0);
});

test('abort before start: throws and sends nothing', async () => {
  const { clock, device, hid } = setup();
  const controller = new AbortController();
  controller.abort();
  const { gate, calls } = countingGate();
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, PRE, { gate, clock, hid, signal: controller.signal }),
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
    const pending = writeCurve(device, NEUTRAL_BANDS, PRE, {
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
  const first = writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
  const { gate, calls } = countingGate();
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, PRE, { gate, clock, hid }),
    ConcurrentWriteError,
  );
  assert.equal(calls.length, 0);
  const result = await first;
  assert.equal(result.status, 'ok');
  assert.equal(device.sent.length, 10);
  const next = await writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
  assert.equal(next.status, 'ok');
});

test('writes to different devices may run concurrently', async () => {
  const clock = createFakeClock(0, { autoAdvance: true });
  const a = new FakeHIDDevice({ clock });
  const b = new FakeHIDDevice({ clock });
  const hid = new FakeHID({ devices: [a, b] });
  const results = await Promise.all(
    [a, b].map((device) => writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid })),
  );
  assert.deepEqual(
    results.map(({ status }) => status),
    ['ok', 'ok'],
  );
  assert.deepEqual(bytesOf(a), bytesOf(b));
});

// --- B1: the lock is taken before the bands or the gates are read ----------------

/** Settles to {value} or {error} without ever being an unhandled rejection. */
const outcome = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
const commits = (device) => bytesOf(device).filter(isCommit).length;
const CUT = [{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 }, ...offTail()];

/**
 * Runs an outer write whose gating calls `reenter()` (a nested writeCurve on the
 * same device) and checks: the nested writes are refused, the outer write sends
 * exactly one stream and one commit, holds the lock until it ends, and releases
 * it exactly once (a later write succeeds).
 */
async function assertReentryRefused(label, build) {
  const { clock, device, hid } = setup();
  const inner = [];
  const reenter = () => {
    inner.push(outcome(writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid })));
  };
  const { bands, gate } = build(reenter);
  const outer = writeCurve(device, bands, -4, { gate, clock, hid });
  // The nested call's failure did not release the outer lock.
  const during = await outcome(writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }));
  assert.ok(during.error instanceof ConcurrentWriteError, label);
  assert.ok(inner.length >= 1, label);
  for (const nested of inner) {
    assert.ok((await nested).error instanceof ConcurrentWriteError, label);
  }
  const result = await outer;
  assert.equal(result.status, 'ok', label);
  assert.equal(result.reportsSent, 9, label);
  assert.equal(device.sent.length, 10, label);
  assert.equal(commits(device), 1, label);
  assert.deepEqual(sentPayload(device), encodePayload(CUT, -4), label);
  const after = await writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
  assert.equal(after.status, 'ok', label);
  assert.equal(device.sent.length, 20, label);
  assert.equal(commits(device), 2, label);
}

test('B1: a nested write from a band getter is refused; one stream is sent', async () => {
  await assertReentryRefused('getter', (reenter) => ({
    bands: [
      {
        kind: 'PK',
        freqHz: 1000,
        qFactor: 1,
        get gainDb() {
          reenter();
          return -3;
        },
      },
      ...offTail(),
    ],
  }));
});

test('B1: a nested write from a Proxy trap is refused; one stream is sent', async () => {
  await assertReentryRefused('proxy', (reenter) => ({
    bands: [
      new Proxy(
        { ...CUT[0] },
        {
          get(target, key) {
            if (key === 'qFactor') reenter();
            return Reflect.get(target, key);
          },
        },
      ),
      ...offTail(),
    ],
  }));
});

test('B1: a nested write from the extra gate (or its verdict) is refused', async () => {
  await assertReentryRefused('extra gate', (reenter) => ({
    bands: CUT,
    gate: () => {
      reenter();
      return { ok: true, reasons: [] };
    },
  }));
  await assertReentryRefused('verdict getter', (reenter) => ({
    bands: CUT,
    gate: () => ({
      get ok() {
        reenter();
        return true;
      },
    }),
  }));
});

test('B1/N2: a coercion hook is never called, so it cannot re-enter', async () => {
  const { clock, device, hid } = setup();
  let calls = 0;
  const inner = [];
  const hook = {
    [Symbol.toPrimitive]() {
      calls++;
      inner.push(outcome(writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid })));
      return -3;
    },
  };
  const bands = [{ ...CUT[0], gainDb: hook }, ...offTail()];
  await assert.rejects(
    writeCurve(device, bands, -4, { clock, hid }),
    (error) =>
      error instanceof GateRejectedError &&
      error.reasons.at(-1).code === 'f:codec' &&
      /gainDb must be a number, got an object/.test(error.reasons.at(-1).value),
  );
  await assert.rejects(writeCurve(device, CUT, hook, { clock, hid }), GateRejectedError);
  assert.equal(calls, 0);
  assert.equal(inner.length, 0);
  assert.equal(device.attempts, 0);
  // The lock was released: the next write goes through.
  assert.equal((await writeCurve(device, CUT, -4, { clock, hid })).status, 'ok');
  assert.equal(commits(device), 1);
});

test('B1: inside writeMany, a nested write to the device being written is refused', async () => {
  const { clock, devices, hid } = manyDevices(2);
  const inner = [];
  let call = 0;
  const gate = () => {
    call += 1;
    // Call 1 is writeMany's up-front check; calls 2 and 3 run under devices[0] and [1]'s locks.
    if (call > 1) {
      inner.push(outcome(writeCurve(devices[call - 2], NEUTRAL_BANDS, PRE, { clock, hid })));
    }
    return { ok: true, reasons: [] };
  };
  const results = await writeMany(devices, CUT, -4, { gate, clock, hid });
  assert.deepEqual(
    results.map(({ status }) => status),
    ['ok', 'ok'],
  );
  assert.equal(inner.length, 2);
  for (const nested of inner) assert.ok((await nested).error instanceof ConcurrentWriteError);
  for (const device of devices) {
    assert.equal(device.sent.length, 10);
    assert.equal(commits(device), 1);
  }
});

// --- B2: aborts during gating and right before the commit -------------------------

test('B2: an abort raised inside the extra gate sends nothing', async () => {
  const { clock, device, hid } = setup();
  const controller = new AbortController();
  const gate = () => {
    controller.abort();
    return { ok: true, reasons: [] };
  };
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, PRE, { gate, clock, hid, signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(device.attempts, 0);
  assert.equal(device.opened, false);

  const many = manyDevices(2);
  const manyController = new AbortController();
  await assert.rejects(
    writeMany(many.devices, NEUTRAL_BANDS, PRE, {
      gate: () => {
        manyController.abort();
        return { ok: true, reasons: [] };
      },
      clock: many.clock,
      hid: many.hid,
      signal: manyController.signal,
    }),
    { name: 'AbortError' },
  );
  assert.ok(many.devices.every((d) => d.attempts === 0 && !d.opened));
  // The lock was released.
  assert.equal((await writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid })).status, 'ok');
});

test('B2: an abort raised as the I/O starts opens and sends nothing', async () => {
  for (const preopened of [false, true]) {
    const { clock, device, hid } = setup();
    if (preopened) await device.open();
    const controller = new AbortController();
    // The injected clock is caller code too; it aborts on the first now() call.
    const abortingClock = {
      now: () => {
        controller.abort();
        return clock.now();
      },
      sleep: clock.sleep,
    };
    const result = await writeCurve(device, NEUTRAL_BANDS, PRE, {
      clock: abortingClock,
      hid,
      signal: controller.signal,
    });
    assert.equal(result.status, 'interrupted');
    assert.equal(result.error.name, 'AbortError');
    assert.equal(result.reportsSent, 0);
    assert.equal(result.committed, false);
    assert.equal(device.opened, preopened);
    assert.equal(device.attempts, 0);
  }
});

test('B2: an abort between the last report and the commit prevents the commit', async () => {
  const { clock, device, hid } = setup();
  const controller = new AbortController();
  const realOpened = Object.getOwnPropertyDescriptor(FakeHIDDevice.prototype, 'opened').get;
  // `opened` is read right before the commit; abort at that very moment.
  Object.defineProperty(device, 'opened', {
    get() {
      if (device.sent.length === 9) controller.abort();
      return realOpened.call(device);
    },
  });
  const result = await writeCurve(device, NEUTRAL_BANDS, PRE, {
    clock,
    hid,
    signal: controller.signal,
  });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.error.name, 'AbortError');
  assert.equal(result.reportsSent, 9);
  assert.equal(result.committed, false);
  assert.equal(device.sent.length, 9);
  assert.equal(commits(device), 0);
});

// --- B3: an abandoned operation that settles later frees the device -------------

test('B3: a device abandoned mid-send is usable again once that send completes', async () => {
  const { clock, device, hid } = setup({ delayMs: 5 }, { autoAdvance: false });
  const controller = new AbortController();
  const pending = writeCurve(device, NEUTRAL_BANDS, PRE, {
    clock,
    hid,
    signal: controller.signal,
  });
  await clock.advance(1);
  assert.equal(device.attempts, 1); // report 0 is still pending (5 ms)
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.equal(result.error.name, 'AbortError');
  assert.equal(result.reportsSent, 0);
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }), DeviceUnusableError);
  await clock.advance(5); // the abandoned sendReport resolves
  const again = writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
  await clock.advance(400);
  assert.equal((await again).status, 'ok');
});

test('B3: a device abandoned mid-open is usable again once that open rejects', async () => {
  const { clock, device, hid } = setup({}, { autoAdvance: false });
  let fail;
  device.open = () =>
    new Promise((_, reject) => {
      fail = reject;
    });
  const controller = new AbortController();
  const pending = writeCurve(device, NEUTRAL_BANDS, PRE, {
    clock,
    hid,
    signal: controller.signal,
  });
  await clock.advance(1);
  controller.abort();
  assert.equal((await pending).status, 'interrupted');
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }), DeviceUnusableError);
  fail(new Error('late failure'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  delete device.open; // back to the prototype's open()
  const again = writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
  await clock.advance(400);
  assert.equal((await again).status, 'ok');
});

test('B3: an abandoned operation settling after requestCable changes nothing', async () => {
  const { clock, device, hid } = setup({ delayMs: 5 }, { autoAdvance: false });
  const controller = new AbortController();
  const pending = writeCurve(device, NEUTRAL_BANDS, PRE, {
    clock,
    hid,
    signal: controller.signal,
  });
  await clock.advance(1);
  controller.abort();
  assert.equal((await pending).status, 'interrupted');
  assert.equal(await requestCable(hid), device); // clears the refusal first
  await clock.advance(5); // then the abandoned sendReport settles
  const again = writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
  await clock.advance(400);
  assert.equal((await again).status, 'ok');
});

// --- QA F1 minors: #9, #11, #12 ----------------------------------------------------

test('#9: a clock that throws after the commit keeps the write ok and committed', async () => {
  for (const persistent of [false, true]) {
    const label = persistent ? 'persistent' : 'one-shot';
    const { clock, device, hid } = setup();
    let throws = 0;
    const fragileClock = {
      now: () => {
        if (commits(device) > 0 && (persistent || throws === 0)) {
          throws += 1;
          throw new Error('clock broke');
        }
        return clock.now();
      },
      sleep: clock.sleep,
    };
    const result = await writeCurve(device, NEUTRAL_BANDS, PRE, { clock: fragileClock, hid });
    assert.equal(throws, 1, label);
    assert.equal(result.status, 'ok', label);
    assert.equal(result.committed, true, label);
    assert.equal(result.reportsSent, 9, label);
    assert.equal(result.error, undefined, label);
    assert.equal(result.finishedAt, result.startedAt, label); // the fallback
    assert.equal(device.sent.length, 10, label);
    assert.equal(commits(device), 1, label);
  }
});

test('#11: if hid.addEventListener throws, the abort listener is removed', async () => {
  const { clock, device } = setup();
  const failure = new Error('hid broke');
  const hid = {
    addEventListener() {
      throw failure;
    },
    removeEventListener: () => undefined,
  };
  const controller = new AbortController();
  const { signal } = controller;
  const added = [];
  const removed = [];
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    added.push({ type, listener });
    add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    removed.push({ type, listener });
    remove(type, listener, options);
  };
  await assert.rejects(writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid, signal }), failure);
  assert.equal(added.length, 1);
  assert.equal(added[0].type, 'abort');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].type, 'abort');
  assert.equal(removed[0].listener, added[0].listener);
  assert.equal(device.attempts, 0);
  assert.equal(device.opened, false);
  // The lock was released: the next write goes through.
  const fine = new FakeHID({ devices: [device] });
  assert.equal((await writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid: fine })).status, 'ok');
});

test('#9: a listener removal that throws after the commit never replaces the ok', async () => {
  for (const broken of ['signal', 'hid']) {
    const { clock, device, hid: fake } = setup();
    const failure = new Error(`${broken} removal broke`);
    const added = [];
    const removed = [];
    const hid = {
      addEventListener(type, listener, options) {
        added.push({ from: 'hid', type, listener });
        fake.addEventListener(type, listener, options);
      },
      removeEventListener(type, listener, options) {
        removed.push({ from: 'hid', type, listener });
        fake.removeEventListener(type, listener, options);
        if (broken === 'hid') throw failure;
      },
    };
    const { signal } = new AbortController();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, listener, options) => {
      added.push({ from: 'signal', type, listener });
      add(type, listener, options);
    };
    signal.removeEventListener = (type, listener, options) => {
      removed.push({ from: 'signal', type, listener });
      remove(type, listener, options);
      if (broken === 'signal') throw failure;
    };
    const result = await writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid, signal });
    assert.equal(result.status, 'ok', broken);
    assert.equal(result.committed, true, broken);
    assert.equal(result.reportsSent, 9, broken);
    assert.equal(result.error, undefined, broken);
    assert.equal(commits(device), 1, broken);
    // Both removals were attempted, each with the listener that was added,
    // whichever of them threw.
    assert.deepEqual(
      removed.map(({ from, type }) => [from, type]),
      [
        ['signal', 'abort'],
        ['hid', 'disconnect'],
      ],
      broken,
    );
    for (const { from, listener } of removed) {
      const original = added.find((entry) => entry.from === from);
      assert.equal(listener, original.listener, `${broken}: ${from}`);
    }
    // The lock was released: the next write goes through.
    assert.equal((await writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid: fake })).status, 'ok');
  }
});

test('#12: the extra gate verdict reasons are read once', async () => {
  const { clock, device, hid } = setup();
  const runs = [
    (gate) => writeCurve(device, NEUTRAL_BANDS, PRE, { gate, clock, hid }),
    (gate) => writeMany([device], NEUTRAL_BANDS, PRE, { gate, clock, hid }),
  ];
  for (const run of runs) {
    let reads = 0;
    const gate = () => ({
      ok: false,
      // A second read sees a non-array, which used to end in a TypeError.
      get reasons() {
        reads += 1;
        return reads === 1 ? ['house rule'] : 'changed';
      },
    });
    await assert.rejects(run(gate), (error) => {
      assert.ok(error instanceof GateRejectedError);
      assert.deepEqual(error.reasons, ['house rule']);
      return true;
    });
    assert.equal(reads, 1);
  }
  assert.equal(device.attempts, 0);
  assert.equal(device.opened, false);
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
  const results = await writeMany(devices, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
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
  const busy = writeCurve(devices[0], NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
  const results = await writeMany(devices, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
  assert.equal(results[0].status, 'failed');
  assert.ok(results[0].error instanceof ConcurrentWriteError);
  assert.equal(results[1].status, 'skipped');
  assert.equal(devices[1].attempts, 0);
  assert.equal((await busy).status, 'ok');
});

// Contract change (M1): no injected gate is needed; the real gate always runs.
test('writeMany refuses when either gate rejects and touches no device', async () => {
  const { clock, devices, hid } = manyDevices(2);
  await assert.rejects(
    writeMany(devices, NEUTRAL_BANDS, PRE, { gate: 'yes', clock, hid }),
    TypeError,
  );
  await assert.rejects(writeMany(devices, NEUTRAL_BANDS, 0, { clock, hid }), GateRejectedError);
  await assert.rejects(writeMany(devices, NEUTRAL_BANDS, 0), GateRejectedError);
  const { gate, calls } = countingGate({ ok: false, reasons: ['nope'] });
  await assert.rejects(
    writeMany(devices, NEUTRAL_BANDS, PRE, { gate, clock, hid }),
    GateRejectedError,
  );
  assert.equal(calls.length, 1);
  assert.ok(devices.every((device) => device.attempts === 0 && !device.opened));
});

test('writeMany re-runs the gate for every device', async () => {
  const { clock, devices, hid } = manyDevices(2);
  const { gate, calls } = countingGate();
  await writeMany(devices, NEUTRAL_BANDS, PRE, { gate, clock, hid, experimental: true });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ options }) => options.experimental === true));
});

test('writeMany: abort before start throws, abort between writes fails the next', async () => {
  const before = manyDevices(2);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    writeMany(before.devices, NEUTRAL_BANDS, PRE, {
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
  const pending = writeMany(devices, NEUTRAL_BANDS, PRE, {
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

// Contract change (B4): once a device write has started, writeMany never throws,
// so the results of devices already committed are never discarded. TypeErrors
// and clock errors are the failing device's 'failed' result; the rest are skipped.
test('B4: writeMany keeps committed results when a later device or the clock throws', async () => {
  const bug = new TypeError('bug');
  const first = manyDevices(3, { 1: { throwAtReport: 0, throwError: bug } });
  const results = await writeMany(first.devices, NEUTRAL_BANDS, PRE, {
    gate: approve,
    clock: first.clock,
    hid: first.hid,
  });
  assert.deepEqual(
    results.map(({ status }) => status),
    ['ok', 'failed', 'skipped'],
  );
  assert.equal(results[0].committed, true);
  assert.equal(results[1].error, bug);
  assert.equal(first.devices[0].sent.length, 10);
  assert.equal(first.devices[2].attempts, 0);

  const clockError = new Error('clock broke');
  const { devices, hid } = manyDevices(3);
  const brokenClock = {
    now: () => 0,
    sleep: (ms) => (ms === WRITE_SPACING_MS ? Promise.reject(clockError) : Promise.resolve()),
  };
  const broken = await writeMany(devices, NEUTRAL_BANDS, PRE, {
    gate: approve,
    clock: brokenClock,
    hid,
  });
  assert.deepEqual(
    broken.map(({ status }) => status),
    ['ok', 'failed', 'skipped'],
  );
  assert.equal(broken[0].committed, true);
  assert.equal(broken[1].error, clockError);
  assert.equal(devices[1].attempts, 0);
  assert.equal(devices[2].attempts, 0);

  // A TypeError from the very first device is a result too, not a throw.
  const lone = manyDevices(2, { 0: { throwAtReport: 0, throwError: bug } });
  const loneResults = await writeMany(lone.devices, NEUTRAL_BANDS, PRE, {
    clock: lone.clock,
    hid: lone.hid,
  });
  assert.deepEqual(
    loneResults.map(({ status }) => status),
    ['failed', 'skipped'],
  );
  assert.equal(loneResults[0].error, bug);
});

// N4: writeMany takes an array only. A Set's entries() yields [device, device],
// which used to skip the 2 s spacing; non-arrays are now refused before any I/O.
test('N4: writeMany refuses a Set (or any non-array) before reading or sending', async () => {
  const { clock, devices, hid } = manyDevices(2);
  const { gate, calls } = countingGate();
  for (const notArray of [new Set(devices), devices[0], { length: 2, 0: devices[0] }, null]) {
    await assert.rejects(
      writeMany(notArray, NEUTRAL_BANDS, PRE, { gate, clock, hid }),
      (error) => error instanceof TypeError && /devices must be an array/.test(error.message),
    );
  }
  assert.equal(calls.length, 0);
  assert.ok(devices.every((device) => device.attempts === 0 && !device.opened));
  // The array is copied once: later mutations by the caller do not change the batch.
  const list = [...devices];
  const pending = writeMany(list, NEUTRAL_BANDS, PRE, { clock, hid });
  list.length = 1;
  const results = await pending;
  assert.deepEqual(
    results.map(({ device }) => device),
    devices,
  );
  assert.ok(results[1].startedAt - results[0].finishedAt >= WRITE_SPACING_MS);
});

// #17: the cable service logs each queued cable on writeMany's spacing sleep
// (ms === WRITE_SPACING_MS); that relies on the spacing sleep coming only
// after an 'ok' result, never after a non-ok one.
test('#17: writeMany sleeps WRITE_SPACING_MS only after an ok result', async () => {
  const bug = new TypeError('bug');
  // An ok write sleeps 10 times (9 report gaps, then the settle); an
  // interrupted one sleeps once per report accepted.
  const cases = [
    { faults: {}, statuses: ['ok', 'ok', 'ok', 'ok'], sleeps: 4 * 10 + 3 },
    {
      faults: { 1: { throwAtReport: 2 } },
      statuses: ['ok', 'interrupted', 'skipped', 'skipped'],
      sleeps: 10 + 1 + 2,
    },
    {
      faults: { 0: { disconnectAtReport: 4 } },
      statuses: ['interrupted', 'skipped', 'skipped', 'skipped'],
      sleeps: 4,
    },
    {
      faults: { 2: { throwAtReport: 0, throwError: bug } },
      statuses: ['ok', 'ok', 'failed', 'skipped'],
      sleeps: 2 * 10 + 2,
    },
  ];
  for (const { faults, statuses, sleeps } of cases) {
    const label = statuses.join(',');
    const { clock, devices, hid } = manyDevices(4, faults);
    const log = [];
    const countingClock = {
      now: () => clock.now(),
      sleep: (ms, signal) => {
        const last = devices.findLastIndex((device) => device.attempts > 0);
        log.push({ ms, last, committed: last >= 0 && commits(devices[last]) === 1 });
        return clock.sleep(ms, signal);
      },
    };
    const results = await writeMany(devices, NEUTRAL_BANDS, PRE, { clock: countingClock, hid });
    assert.deepEqual(
      results.map(({ status }) => status),
      statuses,
      label,
    );
    assert.equal(log.length, sleeps, label);
    const known = [REPORT_GAP_MS, SETTLE_MS, WRITE_SPACING_MS];
    assert.ok(
      log.every(({ ms }) => known.includes(ms)),
      label,
    );
    // Exactly one spacing sleep after each 'ok' that has a successor, each one
    // right after that device committed; none after a non-ok result.
    const spacing = log.filter(({ ms }) => ms === WRITE_SPACING_MS);
    const oks = statuses.slice(0, -1).filter((status) => status === 'ok').length;
    assert.equal(spacing.length, oks, label);
    assert.deepEqual(
      spacing.map(({ last }) => last),
      Array.from({ length: oks }, (_, index) => index),
      label,
    );
    assert.ok(
      spacing.every(({ committed }) => committed),
      label,
    );
  }
});

test('writeMany with no devices returns an empty list', async () => {
  assert.deepEqual(await writeMany([], NEUTRAL_BANDS, PRE, { gate: approve }), []);
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
  const report = encodeReports(NEUTRAL_BANDS, PRE)[0];
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
  const result = await writeCurve(device, NEUTRAL_BANDS, PRE, { gate: approve, clock, hid });
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
