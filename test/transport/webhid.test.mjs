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
  CommitCollisionError,
  ConcurrentWriteError,
  DeviceDisconnectedError,
  DeviceUnusableError,
  GateRejectedError,
  PRODUCT_NAME,
  REPORT_GAP_MS,
  SETTLE_MS,
  WRITE_SPACING_MS,
  applyCurve,
  requestCable,
  systemClock,
  writeCurve,
  writeMany,
} from '../../src/transport/webhid.mjs';
import * as transportIndex from '../../src/transport/index.mjs';
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
    assert.equal(result.reportsAttempted, 10, id); // the commit included
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
    // The failed call counts as attempted; at 9 that is the commit itself.
    assert.equal(result.reportsAttempted, at + 1, `at ${at}`);
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

// --- Modo YOLO (gate profile 'yolo') -------------------------------------------

// design/analysis/limites-v2.md:40: passes every hardware check, fails only c:section-peak.
const YOLO_ONLY = Object.freeze([
  Object.freeze({ kind: 'PK', freqHz: 1000, gainDb: 12, qFactor: 4 }),
  ...NEUTRAL_BANDS.slice(1),
]);
const YOLO_PRE = -12.6;

test('YOLO: without the profile a YOLO-only curve is refused and nothing is sent', async () => {
  const { clock, device, hid } = setup();
  let getterCalls = 0;
  const getter = Object.defineProperty({ clock, hid }, 'profile', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'yolo';
    },
  });
  for (const options of [
    { clock, hid },
    { clock, hid, profile: 'standard' },
    { clock, hid, profile: 'YOLO' },
    { clock, hid, profile: true },
    { clock, hid, profile: Object('yolo') },
    getter,
    Object.assign(Object.create({ profile: 'yolo' }), { clock, hid }),
  ]) {
    await assert.rejects(writeCurve(device, YOLO_ONLY, YOLO_PRE, options), GateRejectedError);
  }
  assert.equal(getterCalls, 0);
  assert.equal(device.attempts, 0);
  assert.equal(device.sent.length, 0);
});

test('YOLO: with the profile the exact gated bytes are sent', async () => {
  const { clock, device, hid } = setup();
  const result = await writeCurve(device, YOLO_ONLY, YOLO_PRE, { clock, hid, profile: 'yolo' });
  assert.equal(result.status, 'ok');
  assert.equal(result.committed, true);
  const payload = encodePayload(YOLO_ONLY, YOLO_PRE);
  const verdict = gateForWrite(YOLO_ONLY, YOLO_PRE, { profile: 'yolo' });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.waived, ['c:section-peak']);
  assert.deepEqual([...verdict.metrics.payload], payload);
  assert.deepEqual(bytesOf(device), [...reportsFromPayload(payload).map((r) => [...r]), COMMIT]);
  assert.deepEqual(
    bytesOf(device).slice(0, 9),
    encodeReports(YOLO_ONLY, YOLO_PRE).map((r) => [...r]),
  );
  assert.equal(result.crc, payload[218] | (payload[219] << 8));
});

test('YOLO: class 1 still blocks with the profile', async () => {
  const { clock, device, hid } = setup();
  // Feedback words and pole radius beyond the presets (a:-a1, a:-a2, b:pole-radius).
  const poles = [{ kind: 'PK', freqHz: 20, gainDb: -12, qFactor: 20 }, ...NEUTRAL_BANDS.slice(1)];
  await assert.rejects(
    writeCurve(device, poles, -1, { clock, hid, profile: 'yolo' }),
    GateRejectedError,
  );
  // The YOLO-only curve with a preamp too high: d and e still block.
  await assert.rejects(
    writeCurve(device, YOLO_ONLY, PRE, { clock, hid, profile: 'yolo' }),
    GateRejectedError,
  );
  // A positive preamp is still a codec refusal.
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, 0.5, { clock, hid, profile: 'yolo' }),
    GateRejectedError,
  );
  assert.equal(device.attempts, 0);
  assert.equal(device.sent.length, 0);
});

test('YOLO: the extra gate sees the profile and can still refuse; writeMany refuses YOLO', async () => {
  const { clock, device, hid } = setup();
  const { gate, calls } = countingGate();
  await writeCurve(device, YOLO_ONLY, YOLO_PRE, { gate, clock, hid, profile: 'yolo' });
  assert.deepEqual(calls[0].options, { experimental: false, profile: 'yolo' });
  const refusing = countingGate({ ok: false, reasons: ['house rule'] });
  const second = setup();
  await assert.rejects(
    writeCurve(second.device, YOLO_ONLY, YOLO_PRE, {
      gate: refusing.gate,
      clock: second.clock,
      hid: second.hid,
      profile: 'yolo',
    }),
    GateRejectedError,
  );
  assert.equal(second.device.attempts, 0);
  // No multi-cable queue in YOLO, whatever the curve.
  const many = setup();
  for (const [bands, preampDb] of [
    [YOLO_ONLY, YOLO_PRE],
    [NEUTRAL_BANDS, PRE],
  ]) {
    await assert.rejects(
      writeMany([many.device], bands, preampDb, {
        clock: many.clock,
        hid: many.hid,
        profile: 'yolo',
      }),
      TypeError,
    );
  }
  assert.equal(many.device.attempts, 0);
});

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

// --- applyCurve: live, no flash (9 data reports, no commit) ----------------------

const LIVE_MS = 9 * REPORT_GAP_MS + SETTLE_MS; // 294 ms, the commit's own start time

test('applyCurve: exactly the 9 fixture reports, ids 0..8, never the commit', async () => {
  assert.equal(transportIndex.applyCurve, applyCurve);
  assert.equal(transportIndex.writeCurve, writeCurve);
  for (const id of presetIds) {
    const { preampDb, eqBands, reports, payload } = fixture.presets[id];
    const { clock, device, hid } = setup();
    const result = await applyCurve(device, eqBands, preampDb, { gate: approve, clock, hid });
    assert.deepEqual(
      result,
      {
        status: 'ok',
        crc: payload[218] | (payload[219] << 8),
        startedAt: 0,
        finishedAt: LIVE_MS,
        reportsSent: 9,
        reportsAttempted: 9,
        committed: false,
      },
      id,
    );
    assert.deepEqual(bytesOf(device), reports, id);
    assert.deepEqual(
      device.sent.map(({ bytes }) => bytes[0]),
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      id,
    );
    assert.ok(
      device.sent.every(({ reportId }) => reportId === HID_REPORT_ID),
      id,
    );
    assert.equal(commits(device), 0, id);
    assert.equal(device.attempts, 9, id);
    // Same 16 ms cadence as writeCurve.
    assert.deepEqual(
      device.sent.map(({ at }) => at),
      Array.from({ length: 9 }, (_, index) => index * REPORT_GAP_MS),
      id,
    );
  }
});

test('applyCurve: pauses after report 8 ignore the stop signal; writeCurve still commits', async () => {
  const { clock, device, hid } = setup();
  const log = [];
  const loggingClock = {
    now: () => clock.now(),
    sleep: (ms, signal) => {
      log.push([ms, signal !== undefined]);
      return clock.sleep(ms, signal);
    },
  };
  const live = await applyCurve(device, CUT, -4, { clock: loggingClock, hid });
  assert.equal(live.status, 'ok');
  assert.deepEqual(log, [
    ...Array.from({ length: 8 }, () => [REPORT_GAP_MS, true]),
    [REPORT_GAP_MS, false],
    [SETTLE_MS, false],
  ]);
  // writeCurve on the same device is unchanged: 9 reports, settle, commit.
  const saved = await writeCurve(device, CUT, -4, { clock, hid });
  assert.equal(saved.status, 'ok');
  assert.equal(saved.committed, true);
  const cut = reportsFromPayload(encodePayload(CUT, -4)).map((report) => [...report]);
  assert.deepEqual(bytesOf(device), [...cut, ...cut, COMMIT]);
  assert.equal(commits(device), 1);
});

test('applyCurve: the gates run first; a refusal sends nothing', async () => {
  const { clock, device, hid } = setup();
  await assert.rejects(
    applyCurve(device, NEUTRAL_BANDS, PRE, { gate: { ok: true }, clock, hid }),
    TypeError,
  );
  // Real gate: Neutro at 0 dB fails g:preamp, whatever the extra gate says.
  const extra = countingGate();
  await assert.rejects(
    applyCurve(device, NEUTRAL_BANDS, 0, { gate: extra.gate, clock, hid }),
    (error) => {
      assert.ok(error instanceof GateRejectedError);
      assert.deepEqual(error.reasons, gateForWrite(NEUTRAL_BANDS, 0).reasons);
      return true;
    },
  );
  assert.equal(extra.calls.length, 0);
  // Extra gate refusing a curve the real gate passes.
  const refusing = countingGate({ ok: false, reasons: ['house rule'] });
  await assert.rejects(applyCurve(device, CUT, -4, { gate: refusing.gate, clock, hid }), {
    name: 'GateRejectedError',
    reasons: ['house rule'],
  });
  assert.equal(refusing.calls.length, 1);
  assert.ok(Object.isFrozen(refusing.calls[0].bands));
  // YOLO: same profile rules as writeCurve.
  await assert.rejects(applyCurve(device, YOLO_ONLY, YOLO_PRE, { clock, hid }), GateRejectedError);
  assert.equal(device.attempts, 0);
  assert.equal(device.opened, false);
  assert.equal(device.sent.length, 0);
  const yolo = await applyCurve(device, YOLO_ONLY, YOLO_PRE, { clock, hid, profile: 'yolo' });
  assert.equal(yolo.status, 'ok');
  assert.equal(yolo.committed, false);
  assert.deepEqual(
    bytesOf(device),
    reportsFromPayload(gateForWrite(YOLO_ONLY, YOLO_PRE, { profile: 'yolo' }).metrics.payload).map(
      (report) => [...report],
    ),
  );
});

test('applyCurve: a getter is read once and the gated bytes are the bytes sent', async () => {
  let reads = 0;
  const band = {
    kind: 'PK',
    freqHz: 1000,
    qFactor: 1,
    get gainDb() {
      reads += 1;
      return reads === 1 ? -3 : 12;
    },
  };
  const { clock, device, hid } = setup();
  const result = await applyCurve(device, [band, ...offTail()], -4, { clock, hid });
  assert.equal(result.status, 'ok');
  assert.equal(reads, 1);
  assert.deepEqual(sentPayload(device), encodePayload(CUT, -4));
});

test('applyCurve: abort before start or during gating sends nothing', async () => {
  const { clock, device, hid } = setup();
  const aborted = new AbortController();
  aborted.abort();
  const { gate, calls } = countingGate();
  await assert.rejects(
    applyCurve(device, NEUTRAL_BANDS, PRE, { gate, clock, hid, signal: aborted.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls.length, 0);
  const controller = new AbortController();
  await assert.rejects(
    applyCurve(device, NEUTRAL_BANDS, PRE, {
      gate: () => {
        controller.abort();
        return { ok: true, reasons: [] };
      },
      clock,
      hid,
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(device.attempts, 0);
  assert.equal(device.opened, false);
  // The lock was released.
  assert.equal((await applyCurve(device, NEUTRAL_BANDS, PRE, { clock, hid })).status, 'ok');
});

test('applyCurve shares the writeCurve lock: a concurrent call either way is refused', async () => {
  for (const [first, second] of [
    [applyCurve, applyCurve],
    [applyCurve, writeCurve],
    [writeCurve, applyCurve],
  ]) {
    const label = `${first.name} then ${second.name}`;
    const { clock, device, hid } = setup();
    const running = first(device, NEUTRAL_BANDS, PRE, { clock, hid });
    const { gate, calls } = countingGate();
    await assert.rejects(
      second(device, NEUTRAL_BANDS, PRE, { gate, clock, hid }),
      ConcurrentWriteError,
      label,
    );
    assert.equal(calls.length, 0, label);
    const result = await running;
    assert.equal(result.status, 'ok', label);
    assert.equal(device.sent.length, first === writeCurve ? 10 : 9, label);
    // Released once the first call ended: the second one now goes through.
    assert.equal((await second(device, NEUTRAL_BANDS, PRE, { clock, hid })).status, 'ok', label);
  }
  // Other devices are independent.
  const clock = createFakeClock(0, { autoAdvance: true });
  const a = new FakeHIDDevice({ clock });
  const b = new FakeHIDDevice({ clock });
  const hid = new FakeHID({ devices: [a, b] });
  const both = await Promise.all([
    applyCurve(a, NEUTRAL_BANDS, PRE, { clock, hid }),
    writeCurve(b, NEUTRAL_BANDS, PRE, { clock, hid }),
  ]);
  assert.deepEqual(
    both.map(({ status }) => status),
    ['ok', 'ok'],
  );
});

test('applyCurve: a nested call from a band getter is refused; one stream is sent', async () => {
  const { clock, device, hid } = setup();
  const inner = [];
  const band = {
    ...CUT[0],
    get gainDb() {
      inner.push(outcome(applyCurve(device, NEUTRAL_BANDS, PRE, { clock, hid })));
      inner.push(outcome(writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid })));
      return -3;
    },
  };
  const result = await applyCurve(device, [band, ...offTail()], -4, { clock, hid });
  assert.equal(result.status, 'ok');
  assert.equal(inner.length, 2);
  for (const nested of inner) assert.ok((await nested).error instanceof ConcurrentWriteError);
  assert.equal(device.sent.length, 9);
  assert.equal(commits(device), 0);
  assert.deepEqual(sentPayload(device), encodePayload(CUT, -4));
});

test('applyCurve: the settle runs in full under the lock, even after an abort or a disconnect', async () => {
  // An abort in the settle is ignored ('ok'); a disconnect keeps the settle but
  // makes the apply 'interrupted': the unplug lost the RAM (back to committed).
  for (const stop of ['none', 'abort', 'disconnect']) {
    const { clock, device, hid } = setup({}, { autoAdvance: false });
    const controller = new AbortController();
    let settled = false;
    const pending = applyCurve(device, NEUTRAL_BANDS, PRE, {
      clock,
      hid,
      signal: controller.signal,
    });
    const done = outcome(pending).then((value) => {
      settled = true;
      return value;
    });
    await clock.advance(8 * REPORT_GAP_MS + 1); // report 8 went out at 128 ms
    assert.equal(device.sent.length, 9, stop);
    if (stop === 'abort') controller.abort();
    if (stop === 'disconnect') hid.disconnect(device);
    await clock.advance(LIVE_MS - 1 - (8 * REPORT_GAP_MS + 1)); // 1 ms short of the settle
    assert.equal(settled, false, stop);
    await assert.rejects(
      applyCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }),
      ConcurrentWriteError,
      stop,
    );
    await assert.rejects(
      writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }),
      ConcurrentWriteError,
      stop,
    );
    await clock.advance(1);
    const { value: result } = await done;
    const { error, ...rest } = result;
    assert.deepEqual(
      { ...rest, crc: undefined },
      {
        status: stop === 'disconnect' ? 'interrupted' : 'ok',
        crc: undefined,
        startedAt: 0,
        finishedAt: LIVE_MS,
        reportsSent: 9,
        reportsAttempted: 9,
        committed: false,
      },
      stop,
    );
    if (stop === 'disconnect') {
      assert.ok(error instanceof DeviceDisconnectedError, stop);
      assert.match(error.message, /reverted to the committed curve/, stop);
    } else {
      assert.equal('error' in result, false, stop);
    }
    assert.equal(clock.pending(), 0, stop);
    assert.equal(device.attempts, 9, stop);
    assert.equal(commits(device), 0, stop);
    if (stop !== 'disconnect') {
      // Lock released only now.
      const next = applyCurve(device, CUT, -4, { clock, hid });
      await clock.advance(LIVE_MS);
      assert.equal((await next).status, 'ok', stop);
    }
  }
});

test('applyCurve: a clock failing after report 8 falls back to a real timer, lock held', async () => {
  const failure = new Error('clock broke');
  // [failing sleep, real wait expected]: the failed sleep in full plus any not started.
  for (const [failAt, realMs] of [
    [REPORT_GAP_MS, REPORT_GAP_MS + SETTLE_MS],
    [SETTLE_MS, SETTLE_MS],
  ]) {
    for (const how of ['reject', 'throw']) {
      const label = `${how} at ${failAt}`;
      const { clock, device, hid } = setup();
      const fragileClock = {
        now: () => clock.now(),
        // The last pause and the settle run without a signal.
        sleep: (ms, signal) => {
          if (signal || ms !== failAt) return clock.sleep(ms, signal);
          if (how === 'throw') throw failure;
          return Promise.reject(failure);
        },
      };
      const before = performance.now();
      const pending = applyCurve(device, NEUTRAL_BANDS, PRE, { clock: fragileClock, hid });
      // Wait (real time) until the 9 reports are out and the fallback timer runs.
      while (device.sent.length < 9) await new Promise((resolve) => setTimeout(resolve, 0));
      await assert.rejects(
        applyCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }),
        ConcurrentWriteError,
        label,
      );
      const result = await pending;
      const elapsed = performance.now() - before;
      // Timers may fire up to ~1 ms early on some platforms.
      assert.ok(elapsed >= realMs - 2, `${label}: lock held ${elapsed} ms, expected ${realMs}`);
      assert.equal(result.status, 'ok', label);
      assert.equal(result.settleError, failure, label);
      assert.equal(result.reportsSent, 9, label);
      assert.equal(result.reportsAttempted, 9, label);
      assert.equal(result.committed, false, label);
      assert.equal('error' in result, false, label);
      assert.equal(device.sent.length, 9, label);
      assert.equal((await applyCurve(device, NEUTRAL_BANDS, PRE, { clock, hid })).status, 'ok');
    }
  }
  // A working clock leaves no settleError.
  const { clock, device, hid } = setup();
  const fine = await applyCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
  assert.equal('settleError' in fine, false);
});

test('applyCurve: a clock sleep that never settles after report 8 holds the lock', async () => {
  const { clock, device, hid } = setup();
  const stuckClock = {
    now: () => clock.now(),
    sleep: (ms, signal) => (signal ? clock.sleep(ms, signal) : new Promise(() => undefined)),
  };
  let settled = false;
  applyCurve(device, NEUTRAL_BANDS, PRE, { clock: stuckClock, hid }).then(
    () => (settled = true),
    () => (settled = true),
  );
  while (device.sent.length < 9) await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + REPORT_GAP_MS + 20));
  assert.equal(settled, false);
  await assert.rejects(
    applyCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }),
    ConcurrentWriteError,
  );
  await assert.rejects(
    writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }),
    ConcurrentWriteError,
  );
  assert.equal(device.sent.length, 9);
});

test('applyCurve: a disconnect at reports 0..8 interrupts, never retries, no commit', async () => {
  for (let at = 0; at <= 8; at++) {
    const { clock, device, hid } = setup({ disconnectAtReport: at });
    const result = await applyCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
    assert.equal(result.status, 'interrupted', `at ${at}`);
    assert.equal(result.committed, false, `at ${at}`);
    assert.equal(result.reportsSent, at, `at ${at}`);
    assert.equal(result.reportsAttempted, at + 1, `at ${at}`);
    assert.equal(device.attempts, at + 1, `at ${at}`); // the failed report is not retried
    assert.equal(device.sent.length, at, `at ${at}`);
    assert.equal(commits(device), 0, `at ${at}`);
    assert.equal(result.error.name, 'NetworkError', `at ${at}`);
  }
});

test('applyCurve: abort, send failures and TypeErrors mid-sequence, like writeCurve', async () => {
  // Abort during the gaps: interrupted at once, the lock is not held for a settle.
  for (const [advanceMs, expectedSent] of [
    [40, 3],
    [8 * REPORT_GAP_MS - 1, 8],
  ]) {
    const { clock, device, hid } = setup({}, { autoAdvance: false });
    const controller = new AbortController();
    const pending = applyCurve(device, NEUTRAL_BANDS, PRE, {
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
    // Report 8 was never attempted: the cable keeps its previous curve (B12b).
    assert.equal(result.reportsAttempted, expectedSent);
    assert.ok(result.reportsAttempted < 9);
    assert.equal(device.attempts, expectedSent);
    assert.equal(clock.pending(), 0);
    const next = applyCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
    await clock.advance(LIVE_MS);
    assert.equal((await next).status, 'ok');
  }
  // sendReport failing: interrupted, the error kept, no retry.
  const failing = setup({ throwAtReport: 3 });
  const failed = await applyCurve(failing.device, NEUTRAL_BANDS, PRE, failing);
  assert.equal(failed.status, 'interrupted');
  assert.equal(failed.reportsSent, 3);
  assert.equal(failed.reportsAttempted, 4);
  assert.equal(failing.device.attempts, 4);
  assert.ok(failed.error instanceof DOMException);
  // Report 8 attempted and failed: reportsSent 8 but reportsAttempted 9, so the
  // caller knows the live curve is unknown (not "previous curve kept").
  const lastFails = setup({ throwAtReport: 8 });
  const lastFailed = await applyCurve(lastFails.device, NEUTRAL_BANDS, PRE, lastFails);
  assert.equal(lastFailed.status, 'interrupted');
  assert.equal(lastFailed.reportsSent, 8);
  assert.equal(lastFailed.reportsAttempted, 9);
  assert.ok(lastFailed.error instanceof DOMException);
  // A TypeError: thrown before any report was accepted, returned after.
  const bug = new TypeError('bad argument');
  const early = setup({ throwAtReport: 0, throwError: bug });
  await assert.rejects(applyCurve(early.device, NEUTRAL_BANDS, PRE, early), bug);
  assert.equal(early.device.attempts, 1);
  const late = setup({ throwAtReport: 8, throwError: bug });
  const lateResult = await applyCurve(late.device, NEUTRAL_BANDS, PRE, late);
  assert.equal(lateResult.status, 'interrupted');
  assert.equal(lateResult.error, bug);
  assert.equal(lateResult.reportsSent, 8);
  assert.equal(late.device.attempts, 9);
});

test('applyCurve: a hung send is abandoned; the device is refused until re-requested', async () => {
  for (const hangAtReport of [3, 8]) {
    const { clock, device, hid } = setup({ hangAtReport }, { autoAdvance: false });
    const controller = new AbortController();
    const pending = applyCurve(device, NEUTRAL_BANDS, PRE, {
      clock,
      hid,
      signal: controller.signal,
    });
    await clock.advance(LIVE_MS);
    assert.equal(device.attempts, hangAtReport + 1);
    controller.abort();
    const result = await pending;
    assert.equal(result.status, 'interrupted');
    assert.equal(result.error.name, 'AbortError');
    assert.equal(result.reportsSent, hangAtReport);
    assert.equal(result.reportsAttempted, hangAtReport + 1); // the hung one was started
    assert.equal(result.committed, false);
    assert.equal(clock.pending(), 0);
    for (const call of [applyCurve, writeCurve]) {
      await assert.rejects(call(device, NEUTRAL_BANDS, PRE, { clock, hid }), DeviceUnusableError);
    }
    assert.equal(device.attempts, hangAtReport + 1); // never retried
    device.faults.hangAtReport = undefined;
    assert.equal(await requestCable(hid), device);
    const again = applyCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
    await clock.advance(LIVE_MS);
    assert.equal((await again).status, 'ok');
  }
  // A device abandoned by writeCurve is refused by applyCurve too (the loop above
  // covers the other way round).
  const { clock, device, hid } = setup({ hangAtReport: 0 }, { autoAdvance: false });
  const pending = writeCurve(device, NEUTRAL_BANDS, PRE, { clock, hid });
  await clock.advance(1);
  hid.disconnect(device);
  assert.ok((await pending).error instanceof DeviceDisconnectedError);
  await assert.rejects(applyCurve(device, NEUTRAL_BANDS, PRE, { clock, hid }), DeviceUnusableError);
});

// --- Commit-shaped data report 1 ---------------------------------------------

/**
 * A gate-approved curve whose data report 1 starts like the commit: report 1
 * bytes 1..4 are payload bytes 30..33, band 0's b1 word (int32 LE). A PK cut
 * just under 24 kHz (allowed: it never amplifies) puts b1 near 0; bisect the
 * frequency until that word is exactly 65 00 01 FF.
 */
function collidingBands() {
  const target = new DataView(Uint8Array.from(COMMIT.slice(1, 5)).buffer).getInt32(0, true);
  const bandsAt = (freqHz) => [{ kind: 'PK', freqHz, gainDb: -3, qFactor: 1 }, ...offTail()];
  const word = (freqHz) => {
    const bytes = Uint8Array.from(encodePayload(bandsAt(freqHz), PRE).slice(30, 34));
    return new DataView(bytes.buffer).getInt32(0, true);
  };
  let low = 20000;
  let high = 24000;
  assert.ok(word(low) < target && target < word(high));
  for (let step = 0; step < 200; step++) {
    const mid = (low + high) / 2;
    const value = word(mid);
    if (value === target) return bandsAt(mid);
    if (value < target) low = mid;
    else high = mid;
  }
  throw new Error('no colliding frequency found');
}

test('a curve whose data report 1 looks like the commit is refused before any I/O', async () => {
  const bands = collidingBands();
  assert.equal(gateForWrite(bands, PRE).ok, true, 'the gate itself approves it');
  const report1 = [...reportsFromPayload(encodePayload(bands, PRE))[1]];
  assert.deepEqual(report1.slice(0, 5), COMMIT.slice(0, 5));
  assert.ok(
    report1.slice(5).some((byte) => byte !== 0),
    'a non-zero tail: still data',
  );
  for (const call of [writeCurve, applyCurve]) {
    const { clock, device, hid } = setup();
    const { gate, calls } = countingGate();
    await assert.rejects(call(device, bands, PRE, { gate, clock, hid }), (error) => {
      assert.ok(error instanceof CommitCollisionError, call.name);
      assert.equal(error.name, 'CommitCollisionError');
      assert.match(error.message, /nothing was sent/);
      return true;
    });
    assert.equal(calls.length, 1, call.name); // refused after the gates, before the I/O
    assert.equal(device.opened, false, call.name);
    assert.equal(device.attempts, 0, call.name);
    assert.equal(device.firmware.commitCount, 0, call.name);
    // The lock was released: a normal curve goes through.
    assert.equal((await call(device, CUT, -4, { clock, hid })).status, 'ok', call.name);
  }
  // writeMany refuses it up front: no device is touched.
  const { clock, devices } = manyDevices(2);
  await assert.rejects(writeMany(devices, bands, PRE, { clock }), CommitCollisionError);
  for (const device of devices) assert.equal(device.attempts, 0);
  assert.equal(transportIndex.CommitCollisionError, CommitCollisionError);
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
