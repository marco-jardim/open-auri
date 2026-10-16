// Simulated WebHID for the 0xCB DSP cable.
//
// Production code: it powers the simulated mode in browsers without WebHID, and
// the transport tests. It only uses EventTarget, Event, DOMException and
// setTimeout, so it runs unchanged in Node 22+, browsers and Workers.
//
// Hardware facts modelled: VID 0x3302, PID 0x8902, product "USB DSP Audio", a
// single output report 0xCB of 31 bytes, write-only. The HID usage page and
// usage of the real cable are not modelled (reported as 0).

import { USB_VID, USB_PID, HID_REPORT_ID, REPORT_SIZE } from '../dsp/eq0xcb.mjs';

export const FAKE_PRODUCT_NAME = 'USB DSP Audio';

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
export function createFakeClock(start = 0, { autoAdvance = false } = {}) {
  let time = start;
  let order = 0;
  let tickQueued = false;
  /** @type {{at: number, order: number, wake: () => void}[]} sorted by (at, order) */
  let timers = [];

  const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** @param {number} ms */
  const checkDuration = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`invalid duration ${ms}`);
  };

  const queueTick = () => {
    if (!autoAdvance || tickQueued || timers.length === 0) return;
    tickQueued = true;
    setTimeout(() => {
      tickQueued = false;
      const first = timers.shift();
      if (first !== undefined) {
        time = Math.max(time, first.at);
        first.wake();
      }
      queueTick();
    }, 0);
  };

  /**
   * @param {number} ms
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      checkDuration(ms);
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (ms === 0) {
        resolve();
        return;
      }
      const onAbort = () => {
        timers = timers.filter((timer) => timer !== entry);
        reject(signal?.reason);
      };
      const entry = {
        at: time + ms,
        order: order++,
        wake: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const index = timers.findIndex((timer) => timer.at > entry.at);
      timers.splice(index === -1 ? timers.length : index, 0, entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      queueTick();
    });

  /** @param {number} ms */
  const advance = async (ms) => {
    checkDuration(ms);
    const target = time + ms;
    await macrotask();
    for (let first = timers[0]; first !== undefined && first.at <= target; first = timers[0]) {
      timers.shift();
      time = first.at;
      first.wake();
      await macrotask();
    }
    time = target;
  };

  return { now: () => time, sleep, advance, pending: () => timers.length };
}

/** Disconnect listeners per device (lets FakeHID observe unplugs). */
/** @type {WeakMap<FakeHIDDevice, Set<(device: FakeHIDDevice) => void>>} */
const disconnectHooks = new WeakMap();

/** @param {unknown} data */
function copyBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  throw new TypeError('data must be an ArrayBuffer or an ArrayBufferView');
}

const writeFailure = () => new DOMException('Failed to write the report.', 'NotAllowedError');

/** A simulated cable: records every report it accepts, with its virtual timestamp. */
export class FakeHIDDevice extends EventTarget {
  #opened = false;
  #connected = true;
  #attempts = 0;
  /** @type {SentReport[]} */
  #sent = [];

  /** @param {FakeDeviceOptions} [options] */
  constructor({
    clock = createFakeClock(0, { autoAdvance: true }),
    vendorId = USB_VID,
    productId = USB_PID,
    productName = FAKE_PRODUCT_NAME,
    disconnectAtReport,
    throwAtReport,
    throwError,
    openError,
    delayMs = 0,
  } = {}) {
    super();
    this.clock = clock;
    this.vendorId = vendorId;
    this.productId = productId;
    this.productName = productName;
    this.collections = Object.freeze([
      Object.freeze({
        usagePage: 0,
        usage: 0,
        inputReports: Object.freeze([]),
        featureReports: Object.freeze([]),
        outputReports: Object.freeze([
          Object.freeze({
            reportId: HID_REPORT_ID,
            items: Object.freeze([Object.freeze({ reportSize: 8, reportCount: REPORT_SIZE })]),
          }),
        ]),
      }),
    ]);
    /** Fault injection; may be changed between writes. */
    this.faults = { disconnectAtReport, throwAtReport, throwError, openError, delayMs };
    disconnectHooks.set(this, new Set());
  }

  get opened() {
    return this.#opened;
  }

  get connected() {
    return this.#connected;
  }

  /** sendReport calls made while open, delivered or not. */
  get attempts() {
    return this.#attempts;
  }

  /** Copy of the delivered reports, in order. @returns {SentReport[]} */
  get sent() {
    return this.#sent.slice();
  }

  async open() {
    if (!this.#connected) throw new DOMException('The device is disconnected.', 'NotFoundError');
    if (this.faults.openError !== undefined) throw this.faults.openError;
    this.#opened = true;
  }

  async close() {
    this.#opened = false;
  }

  /**
   * @param {number} reportId
   * @param {ArrayBuffer | ArrayBufferView} data
   */
  async sendReport(reportId, data) {
    if (!Number.isInteger(reportId) || reportId < 0 || reportId > 0xff) {
      throw new TypeError(`invalid report ID ${reportId}`);
    }
    const bytes = copyBytes(data);
    if (!this.#opened) {
      throw new DOMException('The device must be opened first.', 'InvalidStateError');
    }
    if (reportId !== HID_REPORT_ID || bytes.length > REPORT_SIZE) throw writeFailure();
    const attempt = this.#attempts++;
    if (attempt === this.faults.disconnectAtReport) {
      this.disconnect();
      throw new DOMException('Failed to write the report.', 'NetworkError');
    }
    if (attempt === this.faults.throwAtReport) throw this.faults.throwError ?? writeFailure();
    this.#sent.push({ reportId, bytes, at: this.clock.now() });
    if (this.faults.delayMs > 0) await this.clock.sleep(this.faults.delayMs);
  }

  /** Simulates unplugging the cable. Idempotent. */
  disconnect() {
    if (!this.#connected) return;
    this.#connected = false;
    this.#opened = false;
    for (const hook of disconnectHooks.get(this) ?? []) hook(this);
  }
}

/** Event carrying the device, like WebHID's HIDConnectionEvent. */
export class FakeHIDConnectionEvent extends Event {
  /**
   * @param {'connect' | 'disconnect'} type
   * @param {{device: FakeHIDDevice}} init
   */
  constructor(type, { device }) {
    super(type);
    this.device = device;
  }
}

/** @param {FakeFilter} filter @param {FakeHIDDevice} device */
const matches = (filter, device) =>
  (filter.vendorId === undefined || filter.vendorId === device.vendorId) &&
  (filter.productId === undefined || filter.productId === device.productId);

/**
 * A simulated `navigator.hid`. `choose` stands in for the browser's picker: it
 * receives the connected devices matching the filters and returns the ones the
 * "user" picked (default: the first). Only vendorId/productId filters are
 * modelled. 'disconnect' fires for every attached device that is unplugged.
 */
export class FakeHID extends EventTarget {
  /** @type {FakeHIDDevice[]} */
  #devices = [];
  /** @type {Set<FakeHIDDevice>} */
  #granted = new Set();
  /** Options passed to each requestDevice call. @type {{filters: FakeFilter[]}[]} */
  requests = [];

  /** @param {FakeHIDDevice} device */
  #onDisconnect = (device) => {
    this.#devices = this.#devices.filter((candidate) => candidate !== device);
    this.dispatchEvent(new FakeHIDConnectionEvent('disconnect', { device }));
  };

  /**
   * @param {{
   *   devices?: FakeHIDDevice[],
   *   choose?: (matching: FakeHIDDevice[]) => FakeHIDDevice[] | Promise<FakeHIDDevice[]>,
   * }} [options]
   */
  constructor({ devices = [], choose = (matching) => matching.slice(0, 1) } = {}) {
    super();
    this.choose = choose;
    for (const device of devices) this.#attach(device);
  }

  /** @param {FakeHIDDevice} device */
  #attach(device) {
    this.#devices.push(device);
    disconnectHooks.get(device)?.add(this.#onDisconnect);
  }

  /** Plugs in a device and fires 'connect'. @param {FakeHIDDevice} device */
  addDevice(device) {
    this.#attach(device);
    this.dispatchEvent(new FakeHIDConnectionEvent('connect', { device }));
  }

  /**
   * @param {{filters: FakeFilter[]}} options
   * @returns {Promise<FakeHIDDevice[]>}
   */
  async requestDevice(options) {
    if (options === null || typeof options !== 'object' || !Array.isArray(options.filters)) {
      throw new TypeError("requestDevice: 'filters' is required");
    }
    this.requests.push(options);
    const { filters } = options;
    const matching = this.#devices.filter(
      (device) => filters.length === 0 || filters.some((filter) => matches(filter, device)),
    );
    const chosen = await this.choose(matching);
    for (const device of chosen) this.#granted.add(device);
    return chosen;
  }

  /** Connected devices previously granted through requestDevice. */
  async getDevices() {
    return this.#devices.filter((device) => this.#granted.has(device));
  }

  /** Unplugs `device` (fires 'disconnect'). @param {FakeHIDDevice} device */
  disconnect(device) {
    device.disconnect();
  }
}
