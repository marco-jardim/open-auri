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

test('writeMany rethrows TypeErrors and unexpected clock errors', async () => {
  const bug = new TypeError('bug');
  const first = manyDevices(2, { 1: { throwAtReport: 0, throwError: bug } });
  await assert.rejects(
    writeMany(first.devices, NEUTRAL_BANDS, PRE, {
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
    writeMany(devices, NEUTRAL_BANDS, PRE, { gate: approve, clock: brokenClock, hid }),
    clockError,
  );
  assert.equal(devices[1].attempts, 0);
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
