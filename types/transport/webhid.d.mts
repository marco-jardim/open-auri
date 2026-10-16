export type Band = import('../dsp/eq0xcb.mjs').Band;
export type CableDevice = {
    opened: boolean;
    vendorId: number;
    productId: number;
    productName?: string;
    open: () => Promise<void>;
    sendReport: (reportId: number, data: Uint8Array) => Promise<void>;
};
export type CableFilter = {
    vendorId?: number;
    productId?: number;
};
export type CableHID = {
    requestDevice: (options: {
        filters: CableFilter[];
    }) => Promise<CableDevice[]>;
    addEventListener: (type: 'disconnect', listener: (event: Event) => void) => void;
    removeEventListener: (type: 'disconnect', listener: (event: Event) => void) => void;
};
export type Clock = {
    /**
     * Milliseconds, monotonic.
     */
    now: () => number;
    /**
     * Rejects with
     * `signal.reason` when the signal aborts.
     */
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};
export type GateVerdict = {
    ok: boolean;
    reasons?: readonly unknown[];
};
export type Gate = (bands: readonly Band[], preampDb: number, options: {
    experimental: boolean;
}) => GateVerdict;
export type WriteOptions = {
    /**
     * Optional additional check, called with the gate's frozen
     * snapshot of the bands after `gateForWrite` approved them; it can only refuse.
     */
    gate?: Gate;
    /**
     * Passed to the gates; only `true` enables it.
     */
    experimental?: boolean;
    signal?: AbortSignal;
    /**
     * Defaults to {@link systemClock}.
     */
    clock?: Clock;
    /**
     * Source of 'disconnect' events; defaults to `navigator.hid`.
     */
    hid?: CableHID;
};
export type WriteResult = {
    status: 'ok' | 'interrupted';
    /**
     * Payload CRC-16 (payload bytes 218..219, little-endian).
     */
    crc: number;
    /**
     * `clock.now()` when the I/O started.
     */
    startedAt: number;
    /**
     * `clock.now()` when the write ended.
     */
    finishedAt: number;
    /**
     * Data reports (0..9) the device accepted; the commit is not
     * counted.
     */
    reportsSent: number;
    /**
     * Whether the commit report was confirmed as accepted.
     */
    committed: boolean;
    /**
     * Why the write was interrupted (only when status is 'interrupted').
     */
    error?: unknown;
};
export type ManyResult = (WriteResult & {
    device: CableDevice;
}) | {
    device: CableDevice;
    status: 'failed';
    error: unknown;
} | {
    device: CableDevice;
    status: 'skipped';
};
export type Approved = {
    snapshot: readonly Readonly<Band>[];
    payload: Uint8Array;
    crc: number;
};
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
export declare const PRODUCT_NAME = "USB DSP Audio";
/** Pause after each of the 9 data reports. */
export declare const REPORT_GAP_MS = 16;
/** Settle time after the last data report's pause, before the commit. */
export declare const SETTLE_MS = 150;
/** Flash policy: at least this long between the end of one write and the start of the next. */
export declare const WRITE_SPACING_MS = 2000;
/** The safety gate refused the curve; nothing was sent. */
export declare class GateRejectedError extends Error {
    /** @type {readonly unknown[]} */
    reasons: readonly unknown[];
    /** @param {readonly unknown[]} reasons */
    constructor(reasons: readonly unknown[]);
}
/** Another write to the same device is in progress; nothing was sent. */
export declare class ConcurrentWriteError extends Error {
    constructor();
}
/** The device disconnected or was closed during the write sequence. */
export declare class DeviceDisconnectedError extends Error {
    constructor(message?: string);
}
/**
 * A previous write had to abandon a pending open()/sendReport() on this device
 * (it hung, then the write was aborted or the device disconnected). The pending
 * operation may still complete at any time, so the device is refused, before
 * any I/O, until the page obtains it again with {@link requestCable}.
 */
export declare class DeviceUnusableError extends Error {
    constructor();
}
/**
 * Real-time clock: `performance.now()` and `setTimeout`, available in browsers,
 * Workers and Node.
 * @type {Clock}
 */
export declare const systemClock: Clock;
/**
 * Asks the user to pick the cable. Must run inside a user gesture (the browser
 * enforces it). Resolves to the chosen device, or null if none was chosen. A
 * device returned here is usable again even if a previous write left it
 * refused (see {@link DeviceUnusableError}).
 * @param {CableHID} [hid] Defaults to `navigator.hid`.
 * @returns {Promise<CableDevice | null>}
 */
export declare function requestCable(hid?: CableHID): Promise<CableDevice | null>;
/**
 * Writes a curve to the cable's flash: 9 data reports 16 ms apart, 150 ms of
 * settle, then the commit.
 *
 * `gateForWrite` always runs on a one-read snapshot of `bands`; the reports sent
 * are built from the exact payload it approved. `options.gate`, if given, must
 * also approve (it receives the frozen snapshot).
 *
 * The device's lock is taken before the gates (or any other caller code) run
 * and is released only by this call, so a nested write to the same device
 * started from a band getter, a Proxy trap or the extra gate is refused.
 *
 * Throws, before any I/O, when a gate rejects (GateRejectedError), when
 * `options.gate` is not a function or returns a non-object (TypeError), when
 * `signal` is aborted before or during gating, when the device is busy
 * (ConcurrentWriteError) or refused after an abandoned operation
 * (DeviceUnusableError).
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
export declare function writeCurve(device: CableDevice, bands: readonly Band[], preampDb: number, options?: WriteOptions): Promise<WriteResult>;
/**
 * Writes the same curve to several cables, one at a time, waiting at least
 * {@link WRITE_SPACING_MS} between the end of one write and the start of the
 * next. Stops at the first write that is not 'ok'; the remaining devices are
 * reported as 'skipped'.
 *
 * `devices` must be an array (a Set or other iterable is refused with a
 * TypeError before anything is read or sent); it is copied once, by index.
 * The gates are checked up front, so a rejected curve throws before any device
 * is touched; every device then receives the gate's snapshot (re-gated by
 * writeCurve, under that device's lock), so the caller's bands are read only
 * once.
 *
 * Only that up-front phase throws (invalid arguments, gate rejection, signal
 * already aborted). Once the first device write has started, writeMany never
 * throws, so results of devices already committed are never lost: anything a
 * device write or the spacing sleep throws (busy or unusable device, abort,
 * TypeError, a broken clock) is that device's `{status: 'failed', error}`, and
 * the remaining devices are 'skipped'.
 * @param {readonly CableDevice[]} devices
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {WriteOptions} [options]
 * @returns {Promise<ManyResult[]>}
 */
export declare function writeMany(devices: readonly CableDevice[], bands: readonly Band[], preampDb: number, options?: WriteOptions): Promise<ManyResult[]>;
