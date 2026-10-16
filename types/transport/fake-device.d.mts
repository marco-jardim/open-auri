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
 *
 * @typedef {{vendorId?: number, productId?: number}} FakeFilter
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
/** A simulated cable: records every report it accepts, with its virtual timestamp. */
export class FakeHIDDevice extends EventTarget {
    /** @param {FakeDeviceOptions} [options] */
    constructor({ clock, vendorId, productId, productName, disconnectAtReport, throwAtReport, throwError, hangAtReport, openError, delayMs, }?: FakeDeviceOptions);
    clock: FakeClock;
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
};
export type FakeFilter = {
    vendorId?: number;
    productId?: number;
};
