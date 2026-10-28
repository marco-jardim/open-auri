/**
 * Asks the user to pick the cable. Must run inside a user gesture (the browser
 * enforces it). Resolves to the chosen device, or null if none was chosen. A
 * device returned here is usable again even if a previous write left it
 * refused (see {@link DeviceUnusableError}).
 * @param {CableHID} [hid] Defaults to `navigator.hid`.
 * @returns {Promise<CableDevice | null>}
 */
export function requestCable(hid?: CableHID): Promise<CableDevice | null>;
/**
 * Writes a curve to the cable's flash: 9 data reports 16 ms apart, 150 ms of
 * settle, then the commit.
 *
 * `gateForWrite` always runs on a one-read snapshot of `bands`; the reports sent
 * are built from the exact payload it approved. `options.gate`, if given, must
 * also approve (it receives the frozen snapshot).
 *
 * The device's lock is taken before the bands are read and the gates run; only
 * the reads of `options` (getters included, and `navigator.hid` when `hid` is
 * not given), the type check of `gate` and `signal.throwIfAborted()` come
 * first. The lock is released only by this call, so a nested write to the same
 * device started from a band getter, a Proxy trap or the extra gate is refused.
 *
 * Throws, before any I/O, when a gate rejects (GateRejectedError), when the
 * curve's data report 1 would look like the commit (CommitCollisionError), when
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
export function writeCurve(device: CableDevice, bands: readonly Band[], preampDb: number, options?: WriteOptions): Promise<WriteResult>;
/**
 * Applies a curve live, without touching the flash: the same 9 data reports
 * 16 ms apart as {@link writeCurve}, then 150 ms of settle, and no commit. The
 * cable plays the curve from RAM once report 8 arrives; a replug restores the
 * last committed curve (docs/protocol-0xcb.md, "Dados = RAM, commit = flash").
 *
 * Gate, snapshot, options, lock, abort, abandon (DeviceUnusableError) and error
 * rules are exactly those of {@link writeCurve}; nothing is ever retried. The
 * result has `committed: false`. Once all 9 reports were accepted, the last
 * pause and the settle run in full while the lock is held, so another write or
 * apply on this device is refused until they end:
 * - an abort during them is ignored (nothing is left to stop; the curve already
 *   plays) and the status is 'ok';
 * - a disconnect during them does not shorten them either, but the status is
 *   then 'interrupted' with a DeviceDisconnectedError and `reportsSent: 9`: the
 *   unplug lost the RAM, so the cable is back on its committed curve;
 * - a clock that throws or rejects in them is replaced by a real timer for the
 *   rest of the wait (`settleError` records it; the status is unchanged). A
 *   clock whose sleep never settles holds the lock forever, as it would in any
 *   other pause.
 * Before report 8 was accepted, an interruption is returned as `status:
 * 'interrupted'`; if report 8 was never attempted (`reportsAttempted` < 9),
 * the cable keeps its previous curve (B12b).
 * @param {CableDevice} device
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {WriteOptions} [options]
 * @returns {Promise<WriteResult>}
 */
export function applyCurve(device: CableDevice, bands: readonly Band[], preampDb: number, options?: WriteOptions): Promise<WriteResult>;
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
 * Only that up-front phase throws (invalid arguments, gate rejection, a curve
 * whose data report 1 looks like the commit, signal already aborted). Once the
 * first device write has started, writeMany never throws, so results of
 * devices already committed are never lost: anything a
 * device write or the spacing sleep throws (busy or unusable device, abort,
 * TypeError, a broken clock) is that device's `{status: 'failed', error}`, and
 * the remaining devices are 'skipped'.
 * @param {readonly CableDevice[]} devices
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {WriteOptions} [options]
 * @returns {Promise<ManyResult[]>}
 */
export function writeMany(devices: readonly CableDevice[], bands: readonly Band[], preampDb: number, options?: WriteOptions): Promise<ManyResult[]>;
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
 *   options: {experimental: boolean, profile?: 'yolo'},
 * ) => GateVerdict} Gate
 *
 * @typedef {object} WriteOptions
 * @property {Gate} [gate] Optional additional check, called with the gate's frozen
 *   snapshot of the bands after `gateForWrite` approved them; it can only refuse.
 * @property {boolean} [experimental] Passed to the gates; only `true` enables it.
 * @property {'yolo'} [profile] Gate profile for `gateForWrite` (Modo YOLO: class-2
 *   reasons waived, class 1 and `d:prefix-peak-full` still block). Read like
 *   `gateProfile` does: only an own data property equal to `'yolo'` selects it, a
 *   getter is never called. `writeMany` refuses it (one cable at a time).
 * @property {AbortSignal} [signal]
 * @property {Clock} [clock] Defaults to {@link systemClock}.
 * @property {CableHID} [hid] Source of 'disconnect' events; defaults to `navigator.hid`.
 *
 * @typedef {object} WriteResult
 * @property {'ok' | 'interrupted'} status
 * @property {number} crc Payload CRC-16 (payload bytes 218..219, little-endian).
 * @property {number} startedAt `clock.now()` when the I/O started.
 * @property {number} finishedAt `clock.now()` when the write ended (`startedAt` if that
 *   call threw).
 * @property {number} reportsSent Data reports (0..9) the device accepted; the commit is not
 *   counted.
 * @property {number} [reportsAttempted] sendReport calls started (0..10), whether they were
 *   accepted, failed or hung; unlike `reportsSent` the commit is counted, so a writeCurve that
 *   attempted it reports 10. With `reportsSent` it tells "report 8 never attempted"
 *   (`reportsAttempted` < 9: the cable keeps its previous curve, B12b) from "report 8 attempted
 *   but not confirmed" (`reportsAttempted` >= 9 and `reportsSent` < 9: the live curve is
 *   unknown until a replug). Always set by writeCurve and applyCurve; optional in the type only
 *   so results built by hand (UI fixtures, other bridges) stay valid.
 * @property {boolean} committed Whether the commit report was confirmed as accepted (always
 *   false for applyCurve, which never sends it).
 * @property {unknown} [error] Why the write was interrupted (only when status is 'interrupted').
 * @property {unknown} [settleError] applyCurve only, present only when the injected clock
 *   failed (threw or rejected) in the pauses after report 8. The rest of that wait then ran on
 *   a real timer (setTimeout), so the lock was never released early; the status is unchanged.
 *
 * @typedef {(WriteResult & {device: CableDevice})
 *   | {device: CableDevice, status: 'failed', error: unknown}
 *   | {device: CableDevice, status: 'skipped'}} ManyResult
 *
 * @typedef {{snapshot: readonly Readonly<Band>[], payload: Uint8Array, crc: number}} Approved
 */
export const PRODUCT_NAME: "USB DSP Audio";
/** Pause after each of the 9 data reports. */
export const REPORT_GAP_MS: 16;
/**
 * Settle time after the last data report's pause, before the commit (writeCurve)
 * or before the lock is released (applyCurve).
 */
export const SETTLE_MS: 150;
/** Flash policy: at least this long between the end of one write and the start of the next. */
export const WRITE_SPACING_MS: 2000;
/** The safety gate refused the curve; nothing was sent. */
export class GateRejectedError extends Error {
    /** @param {readonly unknown[]} reasons */
    constructor(reasons: readonly unknown[]);
    /** @type {readonly unknown[]} */
    reasons: readonly unknown[];
}
/** Another write to the same device is in progress; nothing was sent. */
export class ConcurrentWriteError extends Error {
    constructor();
}
/**
 * The curve's data report 1 starts with the commit command (`01 65 00 01 FF`:
 * report index 1, then payload bytes 30..33 = `65 00 01 FF`), so the firmware
 * could take it for a commit and write flash. Thrown by writeCurve, applyCurve
 * and writeMany before any I/O, like GateRejectedError; nothing was sent.
 */
export class CommitCollisionError extends Error {
    constructor();
}
/** The device disconnected or was closed during the write sequence. */
export class DeviceDisconnectedError extends Error {
    constructor(message?: string);
}
/**
 * A previous write had to abandon a pending open()/sendReport() on this device
 * (it hung, then the write was aborted or the device disconnected). The pending
 * operation may still complete at any time, so the device is refused, before
 * any I/O, until that operation settles (either way) or until the page obtains
 * it again with {@link requestCable}, whichever comes first.
 */
export class DeviceUnusableError extends Error {
    constructor();
}
/**
 * Real-time clock: `performance.now()` and `setTimeout`, available in browsers,
 * Workers and Node.
 * @type {Clock}
 */
export const systemClock: Clock;
export type Band = import("../dsp/eq0xcb.mjs").Band;
/**
 * Subset of WebHID's HIDDevice used by this module.
 */
export type CableDevice = {
    opened: boolean;
    vendorId: number;
    productId: number;
    productName?: string | undefined;
    open: () => Promise<void>;
    sendReport: (reportId: number, data: Uint8Array) => Promise<void>;
};
export type CableFilter = {
    vendorId?: number;
    productId?: number;
};
/**
 * Subset of WebHID's `navigator.hid` used by this module.
 */
export type CableHID = {
    requestDevice: (options: {
        filters: CableFilter[];
    }) => Promise<CableDevice[]>;
    addEventListener: (type: "disconnect", listener: (event: Event) => void) => void;
    removeEventListener: (type: "disconnect", listener: (event: Event) => void) => void;
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
    profile?: "yolo";
}) => GateVerdict;
export type WriteOptions = {
    /**
     * Optional additional check, called with the gate's frozen
     * snapshot of the bands after `gateForWrite` approved them; it can only refuse.
     */
    gate?: Gate | undefined;
    /**
     * Passed to the gates; only `true` enables it.
     */
    experimental?: boolean | undefined;
    /**
     * Gate profile for `gateForWrite` (Modo YOLO: class-2
     * reasons waived, class 1 and `d:prefix-peak-full` still block). Read like
     * `gateProfile` does: only an own data property equal to `'yolo'` selects it, a
     * getter is never called. `writeMany` refuses it (one cable at a time).
     */
    profile?: "yolo" | undefined;
    signal?: AbortSignal | undefined;
    /**
     * Defaults to {@link systemClock}.
     */
    clock?: Clock | undefined;
    /**
     * Source of 'disconnect' events; defaults to `navigator.hid`.
     */
    hid?: CableHID | undefined;
};
export type WriteResult = {
    status: "ok" | "interrupted";
    /**
     * Payload CRC-16 (payload bytes 218..219, little-endian).
     */
    crc: number;
    /**
     * `clock.now()` when the I/O started.
     */
    startedAt: number;
    /**
     * `clock.now()` when the write ended (`startedAt` if that
     * call threw).
     */
    finishedAt: number;
    /**
     * Data reports (0..9) the device accepted; the commit is not
     * counted.
     */
    reportsSent: number;
    /**
     * sendReport calls started (0..10), whether they were
     * accepted, failed or hung; unlike `reportsSent` the commit is counted, so a writeCurve that
     * attempted it reports 10. With `reportsSent` it tells "report 8 never attempted"
     * (`reportsAttempted` < 9: the cable keeps its previous curve, B12b) from "report 8 attempted
     * but not confirmed" (`reportsAttempted` >= 9 and `reportsSent` < 9: the live curve is
     * unknown until a replug). Always set by writeCurve and applyCurve; optional in the type only
     * so results built by hand (UI fixtures, other bridges) stay valid.
     */
    reportsAttempted?: number | undefined;
    /**
     * Whether the commit report was confirmed as accepted (always
     * false for applyCurve, which never sends it).
     */
    committed: boolean;
    /**
     * Why the write was interrupted (only when status is 'interrupted').
     */
    error?: unknown;
    /**
     * applyCurve only, present only when the injected clock
     * failed (threw or rejected) in the pauses after report 8. The rest of that wait then ran on
     * a real timer (setTimeout), so the lock was never released early; the status is unchanged.
     */
    settleError?: unknown;
};
export type ManyResult = (WriteResult & {
    device: CableDevice;
}) | {
    device: CableDevice;
    status: "failed";
    error: unknown;
} | {
    device: CableDevice;
    status: "skipped";
};
export type Approved = {
    snapshot: readonly Readonly<Band>[];
    payload: Uint8Array;
    crc: number;
};
