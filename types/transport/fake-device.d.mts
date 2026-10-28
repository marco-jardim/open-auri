/**
 * @typedef {{reportId: number, bytes: Uint8Array, at: number}} SentReport
 *
 * @typedef {object} FakeClock
 * @property {() => number} now Current virtual time in ms.
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} sleep Resolves once virtual
 *   time reaches now + ms; rejects with `signal.reason` on abort.
 * @property {(ms: number) => Promise<void>} advance Moves virtual time forward, waking due
 *   sleepers in order and letting each one's continuation run before the next.
 * @property {() => number} pending Number of sleepers waiting.
 *
 * @typedef {object} FakeDeviceOptions
 * @property {FakeClock} [clock] Timestamps and delays; defaults to an auto-advancing fake clock.
 * @property {number} [vendorId]
 * @property {number} [productId]
 * @property {string} [productName]
 * @property {number} [disconnectAtReport] 0-based sendReport attempt at which the cable is
 *   unplugged (that report is not delivered).
 * @property {number} [throwAtReport] 0-based sendReport attempt that fails (not delivered).
 * @property {unknown} [throwError] What that attempt rejects with (default: NotAllowedError).
 * @property {number} [hangAtReport] 0-based sendReport attempt that never settles (not
 *   delivered), like a cable that stops responding.
 * @property {unknown} [openError] If set, open() rejects with it.
 * @property {number} [delayMs] Virtual time each delivered report takes to complete.
 * @property {FakeFirmware} [firmware] Chip state fed with every delivered report; defaults to
 *   a new factory FakeFirmware. Share one across devices to model replugs of the same cable.
 *   Anything but a FakeFirmware (null included) makes the constructor throw a TypeError.
 *
 * @typedef {{vendorId?: number, productId?: number}} FakeFilter
 *
 * @typedef {object} FakeFirmwareOptions
 * @property {ArrayLike<number> | null} [committed] Payload already in flash (220 bytes, CRC not
 *   checked); `null` (default) is the factory/unknown curve. It is also the initial `live`.
 * @property {7 | 8} [applyOn] Index of the data report that makes the buffered curve take
 *   effect (default 8, as measured in B12b; 7 models the alternative hypothesis).
 *
 * @typedef {'unknown-report' | 'commit-without-live'} FakeIgnoredReason
 * @typedef {{bytes: Uint8Array, reason: FakeIgnoredReason}} FakeIgnoredReport
 */
/**
 * Virtual clock. In manual mode time moves only through `await advance(ms)`.
 * With `autoAdvance`, whenever sleepers are pending and the event loop is idle
 * (a `setTimeout(0)` tick), time jumps to the earliest wake-up: tests run fast
 * and timestamps stay exact and deterministic.
 * @param {number} [start]
 * @param {{autoAdvance?: boolean}} [options]
 * @returns {FakeClock}
 */
export function createFakeClock(start?: number, { autoAdvance }?: {
    autoAdvance?: boolean;
}): FakeClock;
export const FAKE_PRODUCT_NAME: "USB DSP Audio";
/**
 * The cable's chip, independent of any USB connection, so it survives replugs
 * (share one instance between the FakeHIDDevice objects of the same cable).
 *
 * - Data report (byte 0 = index 0..8, bytes 1..30 = payload slice): stored in
 *   its slot; missing bytes read as 0. The slots start zeroed and are kept
 *   after an apply (a RAM buffer), so they only change when overwritten.
 * - Report `applyOn` (default 8): the 9 slots are concatenated and the first
 *   220 bytes taken as the payload (report 8 carries none of it). A good
 *   CRC-16 makes it `live`; a bad one is ignored and counted, `live` unchanged.
 * - Commit (`01 65 00 01 FF`, exactly 5 bytes or zero-padded to the full 31):
 *   `committed = live`. With no live curve (`live === null`) it is ignored and
 *   recorded. A report with that prefix but another length or a non-zero tail
 *   is data report 1 (the transport refuses to send such a curve anyway).
 * - Anything else (index > 8, empty report): ignored and recorded.
 *
 * The firmware never sends input reports.
 */
export class FakeFirmware {
    /** @param {FakeFirmwareOptions} [options] */
    constructor({ committed, applyOn }?: FakeFirmwareOptions);
    /** Data sequences whose CRC was good (each one replaced `live`). */
    appliedCount: number;
    /** Commits that copied `live` to `committed`. */
    commitCount: number;
    /** Data sequences rejected for a bad CRC. */
    rejectedCrcCount: number;
    applyOn: 8 | 7;
    /** Curve the cable is playing (RAM); `null` = factory/unknown. @returns {Uint8Array | null} */
    get live(): Uint8Array | null;
    /** Curve stored in flash; `null` = factory/unknown. @returns {Uint8Array | null} */
    get committed(): Uint8Array | null;
    /** Copy of the reports the firmware ignored, in order. @returns {FakeIgnoredReport[]} */
    get ignored(): FakeIgnoredReport[];
    /**
     * Handles one delivered 0xCB report (the bytes after the report ID).
     * @param {Uint8Array} bytes
     */
    receive(bytes: Uint8Array): void;
    /** Power cycle (unplug + replug): RAM is lost, `live = committed`, slots zeroed. */
    powerCycle(): void;
    #private;
}
/** A simulated cable: records every report it accepts, with its virtual timestamp. */
export class FakeHIDDevice extends EventTarget {
    /** @param {FakeDeviceOptions} [options] */
    constructor({ clock, vendorId, productId, productName, disconnectAtReport, throwAtReport, throwError, hangAtReport, openError, delayMs, firmware, }?: FakeDeviceOptions);
    clock: FakeClock;
    /** The cable's chip; receives every delivered report. */
    firmware: FakeFirmware;
    vendorId: number;
    productId: number;
    productName: string;
    collections: readonly Readonly<{
        usagePage: 0;
        usage: 0;
        inputReports: readonly never[];
        featureReports: readonly never[];
        outputReports: readonly Readonly<{
            reportId: 203;
            items: readonly Readonly<{
                reportSize: 8;
                reportCount: 31;
            }>[];
        }>[];
    }>[];
    /** Fault injection; may be changed between writes. */
    faults: {
        disconnectAtReport: number | undefined;
        throwAtReport: number | undefined;
        throwError: unknown;
        hangAtReport: number | undefined;
        openError: unknown;
        delayMs: number;
    };
    get opened(): boolean;
    get connected(): boolean;
    /** sendReport calls made while open, delivered or not. */
    get attempts(): number;
    /** Copy of the delivered reports, in order. @returns {SentReport[]} */
    get sent(): SentReport[];
    open(): Promise<void>;
    close(): Promise<void>;
    /**
     * @param {number} reportId
     * @param {ArrayBuffer | ArrayBufferView} data
     */
    sendReport(reportId: number, data: ArrayBuffer | ArrayBufferView): Promise<void>;
    /** Simulates unplugging the cable. Idempotent. */
    disconnect(): void;
    #private;
}
/** Event carrying the device, like WebHID's HIDConnectionEvent. */
export class FakeHIDConnectionEvent extends Event {
    /**
     * @param {'connect' | 'disconnect'} type
     * @param {{device: FakeHIDDevice}} init
     */
    constructor(type: "connect" | "disconnect", { device }: {
        device: FakeHIDDevice;
    });
    device: FakeHIDDevice;
}
/**
 * A simulated `navigator.hid`. `choose` stands in for the browser's picker: it
 * receives the connected devices matching the filters and returns the ones the
 * "user" picked (default: the first). Only vendorId/productId filters are
 * modelled. 'disconnect' fires for every attached device that is unplugged.
 */
export class FakeHID extends EventTarget {
    /**
     * @param {{
     *   devices?: FakeHIDDevice[],
     *   choose?: (matching: FakeHIDDevice[]) => FakeHIDDevice[] | Promise<FakeHIDDevice[]>,
     * }} [options]
     */
    constructor({ devices, choose }?: {
        devices?: FakeHIDDevice[];
        choose?: (matching: FakeHIDDevice[]) => FakeHIDDevice[] | Promise<FakeHIDDevice[]>;
    });
    /** Options passed to each requestDevice call. @type {{filters: FakeFilter[]}[]} */
    requests: {
        filters: FakeFilter[];
    }[];
    choose: (matching: FakeHIDDevice[]) => FakeHIDDevice[] | Promise<FakeHIDDevice[]>;
    /** Plugs in a device and fires 'connect'. @param {FakeHIDDevice} device */
    addDevice(device: FakeHIDDevice): void;
    /**
     * @param {{filters: FakeFilter[]}} options
     * @returns {Promise<FakeHIDDevice[]>}
     */
    requestDevice(options: {
        filters: FakeFilter[];
    }): Promise<FakeHIDDevice[]>;
    /** Connected devices previously granted through requestDevice. */
    getDevices(): Promise<FakeHIDDevice[]>;
    /** Unplugs `device` (fires 'disconnect'). @param {FakeHIDDevice} device */
    disconnect(device: FakeHIDDevice): void;
    /**
     * Unplugs `device` exactly like {@link FakeHID.disconnect} (no-op if already
     * unplugged), power-cycles its firmware (`live = committed`), then plugs in a
     * new FakeHIDDevice sharing that firmware, clock and identity, and fires
     * 'connect' for it. The new device starts closed, with no reports, attempts
     * or faults (unless given in `options`), and inherits the old device's
     * requestDevice grant.
     * @param {FakeHIDDevice} device
     * @param {Omit<FakeDeviceOptions, 'firmware'>} [options] Overrides for the new device.
     * @returns {FakeHIDDevice} The new device.
     */
    replug(device: FakeHIDDevice, options?: Omit<FakeDeviceOptions, "firmware">): FakeHIDDevice;
    #private;
}
export type SentReport = {
    reportId: number;
    bytes: Uint8Array;
    at: number;
};
export type FakeClock = {
    /**
     * Current virtual time in ms.
     */
    now: () => number;
    /**
     * Resolves once virtual
     * time reaches now + ms; rejects with `signal.reason` on abort.
     */
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    /**
     * Moves virtual time forward, waking due
     * sleepers in order and letting each one's continuation run before the next.
     */
    advance: (ms: number) => Promise<void>;
    /**
     * Number of sleepers waiting.
     */
    pending: () => number;
};
export type FakeDeviceOptions = {
    /**
     * Timestamps and delays; defaults to an auto-advancing fake clock.
     */
    clock?: FakeClock | undefined;
    vendorId?: number | undefined;
    productId?: number | undefined;
    productName?: string | undefined;
    /**
     * 0-based sendReport attempt at which the cable is
     * unplugged (that report is not delivered).
     */
    disconnectAtReport?: number | undefined;
    /**
     * 0-based sendReport attempt that fails (not delivered).
     */
    throwAtReport?: number | undefined;
    /**
     * What that attempt rejects with (default: NotAllowedError).
     */
    throwError?: unknown;
    /**
     * 0-based sendReport attempt that never settles (not
     * delivered), like a cable that stops responding.
     */
    hangAtReport?: number | undefined;
    /**
     * If set, open() rejects with it.
     */
    openError?: unknown;
    /**
     * Virtual time each delivered report takes to complete.
     */
    delayMs?: number | undefined;
    /**
     * Chip state fed with every delivered report; defaults to
     * a new factory FakeFirmware. Share one across devices to model replugs of the same cable.
     * Anything but a FakeFirmware (null included) makes the constructor throw a TypeError.
     */
    firmware?: FakeFirmware | undefined;
};
export type FakeFilter = {
    vendorId?: number;
    productId?: number;
};
export type FakeFirmwareOptions = {
    /**
     * Payload already in flash (220 bytes, CRC not
     * checked); `null` (default) is the factory/unknown curve. It is also the initial `live`.
     */
    committed?: ArrayLike<number> | null | undefined;
    /**
     * Index of the data report that makes the buffered curve take
     * effect (default 8, as measured in B12b; 7 models the alternative hypothesis).
     */
    applyOn?: 8 | 7 | undefined;
};
export type FakeIgnoredReason = "unknown-report" | "commit-without-live";
export type FakeIgnoredReport = {
    bytes: Uint8Array;
    reason: FakeIgnoredReason;
};
