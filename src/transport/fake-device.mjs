// Simulated WebHID for the 0xCB DSP cable.
//
// Production code: it powers the simulated mode in browsers without WebHID, and
// the transport tests. It only uses EventTarget, Event, DOMException and
// setTimeout, so it runs unchanged in Node 22+, browsers and Workers.
//
// Hardware facts modelled: VID 0x3302, PID 0x8902, product "USB DSP Audio", a
// single output report 0xCB of 31 bytes, write-only. The HID usage page and
// usage of the real cable are not modelled (reported as 0).
//
// FakeFirmware models what the chip does with the delivered reports (B7, B12b):
// the 9 data reports change the sound at once (RAM, `live`), but only when
// report 8 arrives; a bad CRC is silently ignored; the commit copies `live` to
// flash (`committed`); unplug + replug restores the committed curve.

import {
  USB_VID,
  USB_PID,
  HID_REPORT_ID,
  REPORT_SIZE,
  REPORT_COUNT,
  PAYLOAD_SIZE,
  COMMIT_COMMAND,
  crc16Ccitt,
} from '../dsp/eq0xcb.mjs';

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
 * @property {number} [hangAtReport] 0-based sendReport attempt that never settles (not
 *   delivered), like a cable that stops responding.
 * @property {unknown} [openError] If set, open() rejects with it.
 * @property {number} [delayMs] Virtual time each delivered report takes to complete.
 * @property {FakeFirmware} [firmware] Chip state fed with every delivered report; defaults to
 *   a new factory FakeFirmware. Share one across devices to model replugs of the same cable.
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

const REPORT_DATA_SIZE = REPORT_SIZE - 1;

/** @param {Uint8Array | null} payload */
const copyPayload = (payload) => (payload === null ? null : payload.slice());

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
 * - Commit (`01 65 00 01 FF` prefix, padded or not): `committed = live`. With
 *   no live curve (`live === null`) it is ignored and recorded.
 * - Anything else (index > 8, empty report): ignored and recorded.
 *
 * The firmware never sends input reports.
 */
export class FakeFirmware {
  /** @type {Uint8Array[]} */
  #slots = [];
  /** @type {Uint8Array | null} */
  #live;
  /** @type {Uint8Array | null} */
  #committed;
  /** @type {FakeIgnoredReport[]} */
  #ignored = [];
  /** Data sequences whose CRC was good (each one replaced `live`). */
  appliedCount = 0;
  /** Commits that copied `live` to `committed`. */
  commitCount = 0;
  /** Data sequences rejected for a bad CRC. */
  rejectedCrcCount = 0;

  /** @param {FakeFirmwareOptions} [options] */
  constructor({ committed = null, applyOn = 8 } = {}) {
    if (applyOn !== 7 && applyOn !== 8) throw new RangeError('applyOn must be 7 or 8');
    if (committed !== null && committed.length !== PAYLOAD_SIZE) {
      throw new RangeError(`committed must be ${PAYLOAD_SIZE} bytes`);
    }
    this.applyOn = applyOn;
    this.#committed = committed === null ? null : Uint8Array.from(committed);
    this.#live = copyPayload(this.#committed);
    this.#resetSlots();
  }

  /** Curve the cable is playing (RAM); `null` = factory/unknown. @returns {Uint8Array | null} */
  get live() {
    return copyPayload(this.#live);
  }

  /** Curve stored in flash; `null` = factory/unknown. @returns {Uint8Array | null} */
  get committed() {
    return copyPayload(this.#committed);
  }

  /** Copy of the reports the firmware ignored, in order. @returns {FakeIgnoredReport[]} */
  get ignored() {
    return this.#ignored.map(({ bytes, reason }) => ({ bytes: bytes.slice(), reason }));
  }

  #resetSlots() {
    this.#slots = Array.from({ length: REPORT_COUNT }, () => new Uint8Array(REPORT_DATA_SIZE));
  }

  /**
   * Handles one delivered 0xCB report (the bytes after the report ID).
   * @param {Uint8Array} bytes
   */
  receive(bytes) {
    const isCommit =
      bytes.length >= COMMIT_COMMAND.length &&
      COMMIT_COMMAND.every((byte, index) => bytes[index] === byte);
    if (isCommit) {
      if (this.#live === null) {
        this.#ignored.push({ bytes: bytes.slice(), reason: 'commit-without-live' });
        return;
      }
      this.#committed = this.#live.slice();
      this.commitCount++;
      return;
    }
    const index = bytes[0];
    if (bytes.length === 0 || index >= REPORT_COUNT) {
      this.#ignored.push({ bytes: bytes.slice(), reason: 'unknown-report' });
      return;
    }
    const slot = new Uint8Array(REPORT_DATA_SIZE);
    slot.set(bytes.subarray(1, REPORT_SIZE));
    this.#slots[index] = slot;
    if (index === this.applyOn) this.#apply();
  }

  #apply() {
    const buffer = new Uint8Array(REPORT_COUNT * REPORT_DATA_SIZE);
    this.#slots.forEach((slot, index) => buffer.set(slot, index * REPORT_DATA_SIZE));
    const payload = buffer.slice(0, PAYLOAD_SIZE);
    const crc = payload[PAYLOAD_SIZE - 2] | (payload[PAYLOAD_SIZE - 1] << 8);
    if (crc !== crc16Ccitt(payload.subarray(0, PAYLOAD_SIZE - 2))) {
      this.rejectedCrcCount++;
      return;
    }
    this.#live = payload;
    this.appliedCount++;
  }

  /** Power cycle (unplug + replug): RAM is lost, `live = committed`, slots zeroed. */
  powerCycle() {
    this.#live = copyPayload(this.#committed);
    this.#resetSlots();
  }
}

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
    hangAtReport,
    openError,
    delayMs = 0,
    firmware = new FakeFirmware(),
  } = {}) {
    super();
    this.clock = clock;
    /** The cable's chip; receives every delivered report. */
    this.firmware = firmware;
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
    this.faults = {
      disconnectAtReport,
      throwAtReport,
      throwError,
      hangAtReport,
      openError,
      delayMs,
    };
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
    if (attempt === this.faults.hangAtReport) {
      return /** @type {Promise<void>} */ (new Promise(() => undefined));
    }
    this.#sent.push({ reportId, bytes, at: this.clock.now() });
    this.firmware.receive(bytes.slice());
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
  replug(device, options = {}) {
    device.disconnect();
    device.firmware.powerCycle();
    const fresh = new FakeHIDDevice({
      clock: device.clock,
      vendorId: device.vendorId,
      productId: device.productId,
      productName: device.productName,
      ...options,
      firmware: device.firmware,
    });
    if (this.#granted.has(device)) this.#granted.add(fresh);
    this.addDevice(fresh);
    return fresh;
  }
}
