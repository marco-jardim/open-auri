// WebHID transport for the 0xCB DSP cable.
//
// Spec: ../../docs/protocol-0xcb.md ("Sequência de gravação").
//
// The cable (VID 0x3302, PID 0x8902, "USB DSP Audio") is write-only and every
// commit is persisted to the chip's flash, which cannot be read back. Hence:
// - writeCurve() always runs the real safety gate (gateForWrite from
//   src/safety/gate.mjs) itself, immediately before sending; a caller-supplied
//   `gate` is only an additional check (both must approve). Nothing is sent
//   unless the gate approves;
// - the gate reads the caller's bands exactly once (one snapshot) and returns
//   the payload bytes it evaluated; those bytes, split into reports, are what
//   is sent. Nothing is ever re-encoded from the caller's objects;
// - writes are never retried;
// - after any interruption (disconnect, abort, I/O failure) the commit is never
//   sent, so the chip keeps its previous preset in flash;
// - a device whose open()/sendReport() had to be abandoned while still pending
//   (hung, then aborted or unplugged) is refused (DeviceUnusableError) until
//   the page obtains it again through requestCable().
//
// The WebHID surface used here is typed locally (no DOM HID types), so the same
// code drives navigator.hid in the browser and FakeHID (./fake-device.mjs) in
// Node, in tests and in the browser's simulated mode.

import {
  USB_VID,
  USB_PID,
  HID_REPORT_ID,
  PAYLOAD_SIZE,
  commitReport,
  encodePayload,
  reportsFromPayload,
} from '../dsp/eq0xcb.mjs';
import { gateForWrite } from '../safety/gate.mjs';

/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} Band
 *
 * @typedef {object} CableDevice Subset of WebHID's HIDDevice used by this module.
 * @property {boolean} opened
 * @property {number} vendorId
 * @property {number} productId
 * @property {string} [productName]
 * @property {() => Promise<void>} open
 * @property {(reportId: number, data: Uint8Array) => Promise<void>} sendReport
 *
 * @typedef {{vendorId?: number, productId?: number}} CableFilter
 *
 * @typedef {object} CableHID Subset of WebHID's `navigator.hid` used by this module.
 * @property {(options: {filters: CableFilter[]}) => Promise<CableDevice[]>} requestDevice
 * @property {(type: 'disconnect', listener: (event: Event) => void) => void} addEventListener
 * @property {(type: 'disconnect', listener: (event: Event) => void) => void} removeEventListener
 *
 * @typedef {object} Clock
 * @property {() => number} now Milliseconds, monotonic.
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} sleep Rejects with
 *   `signal.reason` when the signal aborts.
 *
 * @typedef {{ok: boolean, reasons?: readonly unknown[]}} GateVerdict
 * @typedef {(
 *   bands: readonly Band[],
 *   preampDb: number,
 *   options: {experimental: boolean},
 * ) => GateVerdict} Gate
 *
 * @typedef {object} WriteOptions
 * @property {Gate} [gate] Optional additional check, called with the gate's frozen
 *   snapshot of the bands after `gateForWrite` approved them; it can only refuse.
 * @property {boolean} [experimental] Passed to the gates; only `true` enables it.
 * @property {AbortSignal} [signal]
 * @property {Clock} [clock] Defaults to {@link systemClock}.
 * @property {CableHID} [hid] Source of 'disconnect' events; defaults to `navigator.hid`.
 *
 * @typedef {object} WriteResult
 * @property {'ok' | 'interrupted'} status
 * @property {number} crc Payload CRC-16 (payload bytes 218..219, little-endian).
 * @property {number} startedAt `clock.now()` when the I/O started.
 * @property {number} finishedAt `clock.now()` when the write ended.
 * @property {number} reportsSent Data reports (0..9) the device accepted; the commit is not
 *   counted.
 * @property {boolean} committed Whether the commit report was confirmed as accepted.
 * @property {unknown} [error] Why the write was interrupted (only when status is 'interrupted').
 *
 * @typedef {(WriteResult & {device: CableDevice})
 *   | {device: CableDevice, status: 'failed', error: unknown}
 *   | {device: CableDevice, status: 'skipped'}} ManyResult
 *
 * @typedef {{snapshot: readonly Readonly<Band>[], payload: Uint8Array, crc: number}} Approved
 */

export const PRODUCT_NAME = 'USB DSP Audio';

/** Pause after each of the 9 data reports. */
export const REPORT_GAP_MS = 16;

/** Settle time after the last data report's pause, before the commit. */
export const SETTLE_MS = 150;

/** Flash policy: at least this long between the end of one write and the start of the next. */
export const WRITE_SPACING_MS = 2000;

/** The safety gate refused the curve; nothing was sent. */
export class GateRejectedError extends Error {
  /** @param {readonly unknown[]} reasons */
  constructor(reasons) {
    const summary = reasons.map(describeReason).join('; ') || 'no reason given';
    super(`safety gate rejected the curve: ${summary}`);
    this.name = 'GateRejectedError';
    /** @type {readonly unknown[]} */
    this.reasons = Object.freeze([...reasons]);
  }
}

/** Another write to the same device is in progress; nothing was sent. */
export class ConcurrentWriteError extends Error {
  constructor() {
    super('a write to this device is already in progress');
    this.name = 'ConcurrentWriteError';
  }
}

/** The device disconnected or was closed during the write sequence. */
export class DeviceDisconnectedError extends Error {
  constructor(message = 'device disconnected during the write') {
    super(message);
    this.name = 'DeviceDisconnectedError';
  }
}

/**
 * A previous write had to abandon a pending open()/sendReport() on this device
 * (it hung, then the write was aborted or the device disconnected). The pending
 * operation may still complete at any time, so the device is refused, before
 * any I/O, until the page obtains it again with {@link requestCable}.
 */
export class DeviceUnusableError extends Error {
  constructor() {
    super(
      'this device stopped responding during a previous write; reconnect it and choose it again',
    );
    this.name = 'DeviceUnusableError';
  }
}

/**
 * Real-time clock: `performance.now()` and `setTimeout`, available in browsers,
 * Workers and Node.
 * @type {Clock}
 */
export const systemClock = Object.freeze({
  now: () => performance.now(),
  sleep: (/** @type {number} */ ms, /** @type {AbortSignal | undefined} */ signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(undefined);
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
});

/** Devices with a write in flight (per-device mutex). @type {WeakMap<object, true>} */
const inFlight = new WeakMap();

/**
 * Devices with an abandoned, possibly still pending, open()/sendReport().
 * Cleared only by requestCable() returning the device again.
 * @type {WeakSet<object>}
 */
const poisoned = new WeakSet();

/** @param {unknown} reason */
function describeReason(reason) {
  return typeof reason === 'string' ? reason : JSON.stringify(reason);
}

/** @returns {CableHID | undefined} */
function navigatorHid() {
  const nav = /** @type {{hid?: CableHID} | undefined} */ (
    /** @type {unknown} */ (globalThis.navigator)
  );
  return nav?.hid;
}

/**
 * @param {unknown} gate
 * @returns {asserts gate is Gate | undefined}
 */
function checkExtraGate(gate) {
  if (gate !== undefined && typeof gate !== 'function') {
    throw new TypeError('options.gate must be a function when given; nothing was sent');
  }
}

/**
 * Runs the real gate (always) and then `extraGate` (if any) on the gate's
 * snapshot; throws GateRejectedError unless both approve. Returns the snapshot
 * and the exact payload the gate evaluated, re-derived once from the frozen
 * snapshot as a consistency check.
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {boolean} experimental
 * @param {Gate | undefined} extraGate
 * @returns {Approved}
 */
function approve(bands, preampDb, experimental, extraGate) {
  const verdict = gateForWrite(bands, preampDb, { experimental });
  if (!verdict.ok) throw new GateRejectedError(verdict.reasons);
  const { bands: snapshot, payload, payloadCrc } = verdict.metrics;
  if (snapshot === undefined || payload === undefined || payloadCrc === undefined) {
    throw new Error('the safety gate returned no payload; nothing was sent');
  }
  if (extraGate !== undefined) {
    const extra = extraGate(snapshot, preampDb, { experimental });
    if (extra === null || typeof extra !== 'object') {
      throw new TypeError('the safety gate must return {ok, reasons}');
    }
    if (extra.ok !== true) {
      throw new GateRejectedError(Array.isArray(extra.reasons) ? extra.reasons : []);
    }
  }
  // The snapshot is frozen plain data: encoding it again must give the same bytes.
  const again = encodePayload(snapshot, preampDb);
  const crc = payload[PAYLOAD_SIZE - 2] | (payload[PAYLOAD_SIZE - 1] << 8);
  if (
    payload.length !== PAYLOAD_SIZE ||
    again.length !== PAYLOAD_SIZE ||
    again.some((byte, index) => byte !== payload[index]) ||
    crc !== Number(payloadCrc)
  ) {
    throw new Error('payload does not match the gated curve; nothing was sent');
  }
  return { snapshot, payload, crc };
}

/**
 * Asks the user to pick the cable. Must run inside a user gesture (the browser
 * enforces it). Resolves to the chosen device, or null if none was chosen. A
 * device returned here is usable again even if a previous write left it
 * refused (see {@link DeviceUnusableError}).
 * @param {CableHID} [hid] Defaults to `navigator.hid`.
 * @returns {Promise<CableDevice | null>}
 */
export async function requestCable(hid = navigatorHid()) {
  if (hid === undefined) throw new Error('WebHID is not available in this environment');
  const devices = await hid.requestDevice({
    filters: [{ vendorId: USB_VID, productId: USB_PID }],
  });
  const device = devices[0] ?? null;
  if (device !== null) poisoned.delete(device);
  return device;
}

/**
 * Writes a curve to the cable's flash: 9 data reports 16 ms apart, 150 ms of
 * settle, then the commit.
 *
 * `gateForWrite` always runs on a one-read snapshot of `bands`; the reports sent
 * are built from the exact payload it approved. `options.gate`, if given, must
 * also approve (it receives the frozen snapshot).
 *
 * Throws, before any I/O, when a gate rejects (GateRejectedError), when
 * `options.gate` is not a function or returns a non-object (TypeError), when
 * `signal` is already aborted, when the device is busy (ConcurrentWriteError)
 * or refused after an abandoned operation (DeviceUnusableError).
 * An interruption once I/O has started (disconnect, device closed, abort,
 * sendReport/open failure or hang) is returned as `status: 'interrupted'` with
 * the cause in `error`, and the commit is not sent. A pending open()/sendReport()
 * is abandoned as soon as the write is aborted or the device disconnects (the
 * device is then refused, see DeviceUnusableError). A TypeError (programming
 * error) is rethrown only while no data report has been accepted; after that
 * it is returned as an interruption, so `reportsSent` is never lost.
 * @param {CableDevice} device
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {WriteOptions} [options]
 * @returns {Promise<WriteResult>}
 */
export async function writeCurve(device, bands, preampDb, options) {
  const {
    gate,
    experimental = false,
    signal,
    clock = systemClock,
    hid = navigatorHid(),
  } = /** @type {Partial<WriteOptions>} */ (options ?? {});
  checkExtraGate(gate);
  signal?.throwIfAborted();
  if (inFlight.has(device)) throw new ConcurrentWriteError();
  if (poisoned.has(device)) throw new DeviceUnusableError();

  // Gate, snapshot and payload come from one synchronous step: the reports are
  // split from the very bytes the gate evaluated.
  const { payload, crc } = approve(bands, preampDb, experimental === true, gate);
  const reports = reportsFromPayload(payload);

  inFlight.set(device, true);
  try {
    return await sendSequence(device, reports, crc, { signal, clock, hid });
  } finally {
    inFlight.delete(device);
  }
}

/**
 * Settles like `operation()`, unless `stop` aborts first: then the operation
 * gets one macrotask to settle, after which it is abandoned (the device is
 * marked unusable) and the promise rejects with the stop reason.
 * @param {CableDevice} device
 * @param {() => Promise<void>} operation
 * @param {AbortSignal} stop Not aborted on entry.
 * @returns {Promise<void>}
 */
function guardIo(device, operation, stop) {
  return new Promise((resolve, reject) => {
    let decided = false;
    const onStop = () => {
      setTimeout(() => {
        if (decided) return;
        decided = true;
        poisoned.add(device);
        reject(stop.reason);
      }, 0);
    };
    /** Claims the outcome; false when the operation was already abandoned. */
    const claim = () => {
      stop.removeEventListener('abort', onStop);
      if (decided) return false;
      decided = true;
      return true;
    };
    stop.addEventListener('abort', onStop, { once: true });
    /** @type {Promise<void>} */
    let pending;
    try {
      pending = Promise.resolve(operation());
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      () => {
        if (claim()) resolve();
      },
      (error) => {
        if (claim()) reject(error);
      },
    );
  });
}

/**
 * @param {CableDevice} device
 * @param {Uint8Array[]} reports
 * @param {number} crc
 * @param {{signal: AbortSignal | undefined, clock: Clock, hid: CableHID | undefined}} context
 * @returns {Promise<WriteResult>}
 */
async function sendSequence(device, reports, crc, { signal, clock, hid }) {
  const startedAt = clock.now();
  let reportsSent = 0;
  let committed = false;

  // One signal for every stop condition, so pending sleeps and I/O end at once.
  const stop = new AbortController();
  const onAbort = () => stop.abort(signal?.reason);
  /** @param {Event} event */
  const onDisconnect = (event) => {
    if (/** @type {{device?: unknown}} */ (event).device === device) {
      stop.abort(new DeviceDisconnectedError());
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  hid?.addEventListener('disconnect', onDisconnect);

  const ensureLive = () => {
    stop.signal.throwIfAborted();
    if (!device.opened) throw new DeviceDisconnectedError('device closed during the write');
  };
  /** @param {() => Promise<void>} operation */
  const io = (operation) => guardIo(device, operation, stop.signal);
  /** @param {'ok' | 'interrupted'} status */
  const result = (status) => ({
    status,
    crc,
    startedAt,
    finishedAt: clock.now(),
    reportsSent,
    committed,
  });

  try {
    if (!device.opened) await io(() => device.open());
    for (const report of reports) {
      ensureLive();
      await io(() => device.sendReport(HID_REPORT_ID, report));
      reportsSent += 1;
      await clock.sleep(REPORT_GAP_MS, stop.signal);
    }
    await clock.sleep(SETTLE_MS, stop.signal);
    ensureLive();
    await io(() => device.sendReport(HID_REPORT_ID, commitReport()));
    committed = true;
    return result('ok');
  } catch (error) {
    // Programming errors surface only while the device holds none of this curve;
    // once a report was accepted the caller must learn how far the write got.
    if (error instanceof TypeError && reportsSent === 0) throw error;
    return { ...result('interrupted'), error };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    hid?.removeEventListener('disconnect', onDisconnect);
  }
}

/**
 * Writes the same curve to several cables, one at a time, waiting at least
 * {@link WRITE_SPACING_MS} between the end of one write and the start of the
 * next. Stops at the first write that is not 'ok'; the remaining devices are
 * reported as 'skipped'. A write that throws before any I/O (busy or unusable
 * device, abort) is reported as 'failed' with its error. The gates are checked
 * up front, so a rejected curve throws before any device is touched; every
 * device then receives the gate's snapshot (re-gated by writeCurve), so the
 * caller's bands are read only once.
 * @param {readonly CableDevice[]} devices
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {WriteOptions} [options]
 * @returns {Promise<ManyResult[]>}
 */
export async function writeMany(devices, bands, preampDb, options) {
  const opts = /** @type {Partial<WriteOptions>} */ (options ?? {});
  const { gate, experimental = false, signal, clock = systemClock } = opts;
  checkExtraGate(gate);
  signal?.throwIfAborted();
  const { snapshot } = approve(bands, preampDb, experimental === true, gate);

  /** @type {ManyResult[]} */
  const results = [];
  for (const [index, device] of devices.entries()) {
    if (index > 0) {
      try {
        await clock.sleep(WRITE_SPACING_MS, signal);
      } catch (error) {
        // An abort falls through: writeCurve then throws it and it is reported as 'failed'.
        if (!signal?.aborted) throw error;
      }
    }
    /** @type {ManyResult} */
    let outcome;
    try {
      const result = await writeCurve(device, snapshot, preampDb, { ...opts, clock });
      outcome = { device, ...result };
    } catch (error) {
      if (error instanceof TypeError) throw error;
      outcome = { device, status: 'failed', error };
    }
    results.push(outcome);
    if (outcome.status !== 'ok') {
      for (const rest of devices.slice(index + 1)) {
        results.push({ device: rest, status: 'skipped' });
      }
      break;
    }
  }
  return results;
}
