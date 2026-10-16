// WebHID transport for the 0xCB DSP cable.
//
// Spec: ../../docs/protocol-0xcb.md ("Sequência de gravação").
//
// The cable (VID 0x3302, PID 0x8902, "USB DSP Audio") is write-only and every
// commit is persisted to the chip's flash, which cannot be read back. Hence:
// - writeCurve() requires a safety gate (gateForWrite, injected by the caller)
//   and re-runs it itself, immediately before encoding; nothing is sent unless
//   the gate approves;
// - writes are never retried;
// - after any interruption (disconnect, abort, I/O failure) the commit is never
//   sent, so the chip keeps its previous preset in flash.
//
// The WebHID surface used here is typed locally (no DOM HID types), so the same
// code drives navigator.hid in the browser and FakeHID (./fake-device.mjs) in
// Node, in tests and in the browser's simulated mode.

import {
  USB_VID,
  USB_PID,
  HID_REPORT_ID,
  PAYLOAD_SIZE,
  encodeReports,
  commitReport,
  encodePayload,
  crc16Ccitt,
} from '../dsp/eq0xcb.mjs';

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
 * @typedef {(bands: readonly Band[], preampDb: number, options: {experimental: boolean}) => GateVerdict} Gate
 *
 * @typedef {object} WriteOptions
 * @property {Gate} gate Required: `gateForWrite` from src/safety/gate.mjs in production.
 * @property {boolean} [experimental] Passed to the gate; only `true` enables it.
 * @property {AbortSignal} [signal]
 * @property {Clock} [clock] Defaults to {@link systemClock}.
 * @property {CableHID} [hid] Source of 'disconnect' events; defaults to `navigator.hid`.
 *
 * @typedef {object} WriteResult
 * @property {'ok' | 'interrupted'} status
 * @property {number} crc Payload CRC-16 (payload bytes 218..219, little-endian).
 * @property {number} startedAt `clock.now()` when the I/O started.
 * @property {number} finishedAt `clock.now()` when the write ended.
 * @property {number} reportsSent Data reports (0..9) the device accepted; the commit is not counted.
 * @property {boolean} committed Whether the commit report was accepted.
 * @property {unknown} [error] Why the write was interrupted (only when status is 'interrupted').
 *
 * @typedef {(WriteResult & {device: CableDevice})
 *   | {device: CableDevice, status: 'failed', error: unknown}
 *   | {device: CableDevice, status: 'skipped'}} ManyResult
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
 * @returns {asserts gate is Gate}
 */
function requireGate(gate) {
  if (typeof gate !== 'function') {
    throw new TypeError('a safety gate is required (inject gateForWrite); nothing was sent');
  }
}

/**
 * Runs the gate and throws unless it approves.
 * @param {Gate} gate
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {boolean} experimental
 */
function enforceGate(gate, bands, preampDb, experimental) {
  const verdict = gate(bands, preampDb, { experimental });
  if (verdict === null || typeof verdict !== 'object') {
    throw new TypeError('the safety gate must return {ok, reasons}');
  }
  if (verdict.ok !== true) {
    throw new GateRejectedError(Array.isArray(verdict.reasons) ? verdict.reasons : []);
  }
}

/**
 * Asks the user to pick the cable. Must run inside a user gesture (the browser
 * enforces it). Resolves to the chosen device, or null if none was chosen.
 * @param {CableHID} [hid] Defaults to `navigator.hid`.
 * @returns {Promise<CableDevice | null>}
 */
export async function requestCable(hid = navigatorHid()) {
  if (hid === undefined) throw new Error('WebHID is not available in this environment');
  const devices = await hid.requestDevice({
    filters: [{ vendorId: USB_VID, productId: USB_PID }],
  });
  return devices[0] ?? null;
}

/**
 * Writes a curve to the cable's flash: 9 data reports 16 ms apart, 150 ms of
 * settle, then the commit.
 *
 * Throws, before any I/O, when the gate is missing (TypeError) or rejects
 * (GateRejectedError), when the bands cannot be encoded, when `signal` is
 * already aborted, or when the device is busy (ConcurrentWriteError).
 * An interruption once I/O has started (disconnect, device closed, abort,
 * sendReport/open failure) is returned as `status: 'interrupted'` with the
 * cause in `error`, and the commit is not sent. TypeErrors (programming
 * errors) are rethrown.
 * @param {CableDevice} device
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {WriteOptions} options
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
  requireGate(gate);
  signal?.throwIfAborted();
  if (inFlight.has(device)) throw new ConcurrentWriteError();

  // Gate and encoding run synchronously, back to back: the bytes sent are
  // exactly those of the curve the gate approved.
  enforceGate(gate, bands, preampDb, experimental === true);
  const payload = encodePayload(bands, preampDb);
  const crc = payload[PAYLOAD_SIZE - 2] | (payload[PAYLOAD_SIZE - 1] << 8);
  if (crc !== crc16Ccitt(payload.slice(0, PAYLOAD_SIZE - 2))) {
    throw new Error('payload CRC mismatch; nothing was sent');
  }
  const reports = encodeReports(bands, preampDb);

  inFlight.set(device, true);
  try {
    return await sendSequence(device, reports, crc, { signal, clock, hid });
  } finally {
    inFlight.delete(device);
  }
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

  // One signal for every stop condition, so pending sleeps end at once.
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
    if (!device.opened) await device.open();
    for (const report of reports) {
      ensureLive();
      await device.sendReport(HID_REPORT_ID, report);
      reportsSent += 1;
      await clock.sleep(REPORT_GAP_MS, stop.signal);
    }
    await clock.sleep(SETTLE_MS, stop.signal);
    ensureLive();
    await device.sendReport(HID_REPORT_ID, commitReport());
    committed = true;
    return result('ok');
  } catch (error) {
    if (error instanceof TypeError) throw error;
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
 * reported as 'skipped'. A write that throws before any I/O (busy device,
 * abort) is reported as 'failed' with its error. The gate is checked up front,
 * so a rejected curve throws before any device is touched.
 * @param {readonly CableDevice[]} devices
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {WriteOptions} options
 * @returns {Promise<ManyResult[]>}
 */
export async function writeMany(devices, bands, preampDb, options) {
  const opts = /** @type {Partial<WriteOptions>} */ (options ?? {});
  const { gate, experimental = false, signal, clock = systemClock } = opts;
  requireGate(gate);
  signal?.throwIfAborted();
  enforceGate(gate, bands, preampDb, experimental === true);

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
      const result = await writeCurve(device, bands, preampDb, { ...opts, gate, clock });
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
