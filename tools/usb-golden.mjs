#!/usr/bin/env node
/**
 * Offline F5 capture validator. No USB I/O is performed.
 *
 * Input is the array emitted by `tshark -r capture.pcapng -T json` (not -T ek).
 * Fields are searched recursively under _source.layers because tshark versions
 * nest setup/descriptors differently; scalar fields and singleton arrays work.
 * Numeric USB fields must be decimal or 0x-prefixed integers. Payload hex may
 * have colons/spaces or no separators. USBPcap transfer types are 1 (interrupt)
 * and 2 (control), not the endpoint descriptor's bmAttributes values.
 * Alternatively --input-format interrupt-out-raw accepts a reviewed extraction
 * [{frame, t, hex}]: frame number, relative seconds, last 32 on-wire bytes.
 * This mode asserts the source was filtered to HID interrupt OUT submissions;
 * it cannot infer device/endpoint ownership from the reduced data itself.
 *
 * Golden hex contains the entire on-wire buffer, including CB and zero padding.
 * Only validation strips CB and padding to the codec's 31 data bytes. Android's
 * Diagnostics.kt exports {wireLog: [{atMs, hex}]} (or use that array alone): hex
 * is lowercase, separator-free, and includes the report ID and all padding.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  commitReport,
  encodeReports,
  HID_REPORT_ID,
  REPORT_COUNT,
  REPORT_SIZE,
  USB_PID,
  USB_VID,
} from '../src/dsp/eq0xcb.mjs';
import { NEUTRO } from '../src/catalog/presets.mjs';

/**
 * @typedef {'interrupt' | 'control'} Transfer
 * @typedef {{curve: string, reports: string[], commit: string}} GoldenWrite
 * @typedef {{capturedOn: string, os: string, browser: string, transfer: Transfer,
 *   paddedLength: number, writes: GoldenWrite[]}} Golden
 * @typedef {{address?: string, interface?: number, capturedOn: string, os: string,
 *   browser: string, inputFormat?: string}} CaptureOptions
 * @typedef {Map<string, unknown[]>} Fields
 * @typedef {{requestType?: number, request?: number, value?: number, index?: number}} Setup
 * @typedef {{bytes: Uint8Array, transfer: Transfer, stream: string, packet: number}} Report
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value @returns {number | undefined} */
function integer(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== 'string' || !/^(?:0x[\da-f]+|\d+)$/i.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

/** @param {unknown} value @returns {Uint8Array} */
function hexBytes(value) {
  if (typeof value !== 'string' || !/^(?:[\da-f]{2}[:\s]*)+$/i.test(value)) {
    throw new Error('Expected byte hex');
  }
  return Uint8Array.from(Buffer.from(value.replace(/[:\s]/g, ''), 'hex'));
}

/** @param {Uint8Array | number[]} bytes */
function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

/** @param {unknown} layers @returns {Fields} */
function fieldsOf(layers) {
  /** @type {Fields} */
  const fields = new Map();
  /** @param {unknown} node */
  function visit(node) {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    for (const [key, value] of Object.entries(object(node))) {
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        if (entry !== null && typeof entry === 'object') visit(entry);
        else fields.set(key, [...(fields.get(key) ?? []), entry]);
      }
    }
  }
  visit(layers);
  return fields;
}

/** @param {Fields} fields @param {...string} names */
function numberField(fields, ...names) {
  for (const name of names) {
    const value = integer(fields.get(name)?.[0]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** @param {Fields} fields @param {string[]} names */
function firstField(fields, names) {
  for (const name of names) if (fields.has(name)) return fields.get(name)?.[0];
  return undefined;
}

/** @param {Fields} fields @returns {Setup} */
function setupOf(fields) {
  return {
    requestType: numberField(fields, 'usb.setup.bmRequestType', 'usb.bmRequestType'),
    request: numberField(fields, 'usb.setup.bRequest', 'usb.bRequest'),
    value: numberField(fields, 'usb.setup.wValue', 'usb.wValue'),
    index: numberField(fields, 'usb.setup.wIndex', 'usb.wIndex'),
  };
}

/** @param {Fields} fields */
function payloadOf(fields) {
  const value = firstField(fields, ['usbhid.data', 'usb.capdata', 'usb.data_fragment']);
  return value === undefined ? undefined : hexBytes(value);
}

/** @param {Fields} fields */
function addressOf(fields) {
  const bus = numberField(fields, 'usb.bus_id');
  const device = numberField(fields, 'usb.device_address');
  return bus !== undefined && device !== undefined ? `${bus}.${device}` : undefined;
}

/** @param {Fields} fields */
function isCompletion(fields) {
  return (
    numberField(fields, 'usb.irp_info.direction') === 1 ||
    numberField(fields, 'usb.urb_type') === 0x43 ||
    fields.get('usb.urb_type')?.[0] === 'C'
  );
}

/** @param {string} value */
function parseAddress(value) {
  if (!/^\d+\.\d+$/.test(value)) throw new Error('Address must be <bus.dev>, e.g. 1.7');
  const [bus, device] = value.split('.').map(Number);
  if (bus > 65535 || device > 127) throw new Error('USB address out of range');
  return `${bus}.${device}`;
}

/**
 * Learn interface/endpoint ownership from decoded configuration descriptors
 * (bInterfaceNumber, bInterfaceClass, bEndpointAddress), or raw descriptor bytes.
 * Decoded repeated fields retain descriptor order within their arrays. Explicit
 * usb.interface_number / usb.interface_class are also supported on data packets.
 * Without configuration descriptors an interrupt packet needs usbhid.data (HID
 * dissection) or explicit HID class/interface evidence. --interface can supply
 * the HID interface number, but cannot invent endpoint ownership for capdata.
 * Exact SET_REPORT's wIndex identifies the HID interface if descriptors are absent.
 * @param {Fields} fields
 * @param {Uint8Array | undefined} raw
 * @param {Map<number, Set<number>>} interfaces
 */
function learnInterfaces(fields, raw, interfaces) {
  const numbers = fields.get('usb.bInterfaceNumber') ?? [];
  const classes = fields.get('usb.bInterfaceClass') ?? [];
  for (let i = 0; i < numbers.length; i++) {
    const id = integer(numbers[i]);
    if (id !== undefined && integer(classes[i]) === 3 && !interfaces.has(id)) {
      interfaces.set(id, new Set());
    }
  }
  // Endpoint fields in one descriptor subtree have an unambiguous owner. For
  // repeated interfaces use raw configuration bytes rather than guessing a zip.
  if (numbers.length === 1) {
    const endpoints = interfaces.get(integer(numbers[0]) ?? -1);
    for (const entry of fields.get('usb.bEndpointAddress') ?? []) {
      const endpoint = integer(entry);
      if (endpoint !== undefined) endpoints?.add(endpoint);
    }
  } else {
    const counts = (fields.get('usb.bNumEndpoints') ?? []).map(integer);
    const endpoints = (fields.get('usb.bEndpointAddress') ?? []).map(integer);
    if (
      counts.length === numbers.length &&
      counts.every((count) => count !== undefined) &&
      counts.reduce((sum, count) => (sum ?? 0) + (count ?? 0), 0) === endpoints.length
    ) {
      let offset = 0;
      numbers.forEach((number, index) => {
        const owned = interfaces.get(integer(number) ?? -1);
        for (const endpoint of endpoints.slice(offset, offset + (counts[index] ?? 0))) {
          if (endpoint !== undefined) owned?.add(endpoint);
        }
        offset += counts[index] ?? 0;
      });
    }
  }
  if (!raw) return;
  let current = -1;
  for (let offset = 0; offset + 1 < raw.length;) {
    const length = raw[offset];
    if (length < 2 || offset + length > raw.length) break;
    const type = raw[offset + 1];
    if (type === 4 && length >= 9) {
      current = raw[offset + 5] === 3 ? raw[offset + 2] : -1;
      if (current >= 0 && !interfaces.has(current)) interfaces.set(current, new Set());
    } else if (type === 5 && length >= 7) {
      interfaces.get(current)?.add(raw[offset + 2]);
    }
    offset += length;
  }
}

/**
 * Request/completion pairs share usb.irp_id (USBPcap) or usb.urb_id. Setup-only
 * packets are correlated with later usb.data_fragment stages by that ID. Empty
 * completions are ignored; duplicate payload copies in a URB are consumed once.
 * Completion ends that URB's lifetime: Windows may reuse IRP pointer IDs later.
 * Fragment fields must contain a complete report data stage, not truncated bytes.
 * Bus/address are mandatory; missing relevant fields are skipped with counts.
 * @param {unknown} capture
 * @param {CaptureOptions} options
 * @param {(message: string) => void} warn
 * @returns {Report[]}
 */
function extractReports(capture, options, warn) {
  if (!Array.isArray(capture)) throw new Error('Capture must be a tshark JSON array');
  const requestedAddress =
    options.address === undefined ? undefined : parseAddress(options.address);
  /** @type {Map<string, Setup>} */
  const setups = new Map();
  /** @type {Map<string, Map<number, Set<number>>>} */
  const hid = new Map();
  const devices = new Set();
  const packets = capture.map((packet, index) => {
    const fields = fieldsOf(object(object(packet)._source).layers);
    const address = addressOf(fields);
    const id = firstField(fields, ['usb.irp_id', 'usb.urb_id']);
    const key = address && id !== undefined ? `${address}/${id}` : undefined;
    let setup = setupOf(fields);
    if (key) {
      setup = {
        ...setups.get(key),
        ...Object.fromEntries(Object.entries(setup).filter(([, value]) => value !== undefined)),
      };
      if (isCompletion(fields)) setups.delete(key);
      else setups.set(key, setup);
    }
    let payload;
    try {
      payload = payloadOf(fields);
    } catch {
      /* Warn only for selected OUT packets below. */
    }
    if (address) {
      const interfaces = hid.get(address) ?? new Map();
      hid.set(address, interfaces);
      const descriptor = setup.request === 6 && (setup.requestType ?? 0) & 0x80;
      if (descriptor || fields.has('usb.bDescriptorType')) {
        let vid = numberField(fields, 'usb.idVendor');
        let pid = numberField(fields, 'usb.idProduct');
        if (payload?.[1] === 1 && payload.length >= 12) {
          vid = payload[8] | (payload[9] << 8);
          pid = payload[10] | (payload[11] << 8);
        }
        if (vid === USB_VID && pid === USB_PID) devices.add(address);
        learnInterfaces(fields, payload, interfaces);
      }
    }
    return { fields, address, setup, key, packet: index + 1 };
  });
  if (!requestedAddress && devices.size !== 1) {
    throw new Error(`Found ${devices.size} matching 3302:8902 devices; use --address <bus.dev>`);
  }
  const selected = requestedAddress ?? [...devices][0];
  const interfaces = hid.get(selected) ?? new Map();
  /** @type {Report[]} */
  const reports = [];
  const seen = new Map();
  for (const { fields, address, setup, key, packet } of packets) {
    if (isCompletion(fields)) {
      if (key) seen.delete(key);
      continue;
    }
    if (!fields.has('usb.transfer_type')) {
      if (address === selected) warn('missing transfer type; packet skipped');
      continue;
    }
    if (address === undefined) {
      warn('missing bus/device address; packet skipped');
      continue;
    }
    if (address !== selected) continue;
    const type = numberField(fields, 'usb.transfer_type');
    if (type !== 1 && type !== 2) continue;
    const endpoint = numberField(fields, 'usb.endpoint_address');
    if (endpoint === undefined) {
      warn('missing endpoint; packet skipped');
      continue;
    }
    if (endpoint & 0x80) continue;
    const direction = numberField(
      fields,
      'usb.endpoint_address.direction',
      'usb.endpoint_address.direction_tree',
    );
    if (direction === 1) continue;
    const explicitInterface = numberField(
      fields,
      'usb.interface_number',
      'usbhid.interface_number',
    );
    const explicitClass = numberField(fields, 'usb.interface_class');
    if (explicitClass !== undefined && explicitClass !== 3) continue;
    /** @type {Transfer} */
    const transfer = type === 1 ? 'interrupt' : 'control';
    let interfaceId = explicitInterface;
    if (transfer === 'control') {
      if (
        (setup.requestType !== undefined && setup.requestType !== 0x21) ||
        (setup.request !== undefined && setup.request !== 9) ||
        (setup.value !== undefined && setup.value !== 0x02cb)
      )
        continue;
      if (
        setup.requestType === undefined ||
        setup.request === undefined ||
        setup.value === undefined
      ) {
        if (firstField(fields, ['usbhid.data', 'usb.capdata', 'usb.data_fragment']) !== undefined) {
          warn('missing control setup fields; packet skipped');
        }
        continue;
      }
      interfaceId = setup.index;
      if (interfaceId === undefined) {
        warn('missing SET_REPORT wIndex; packet skipped');
        continue;
      }
    }
    if (
      options.interface !== undefined &&
      interfaceId !== undefined &&
      interfaceId !== options.interface
    )
      continue;
    if (interfaceId !== undefined && interfaces.size > 0 && !interfaces.has(interfaceId)) continue;
    if (transfer === 'interrupt') {
      const owners = [...interfaces].filter(([, endpoints]) => endpoints.has(endpoint));
      if (owners.length > 0) {
        if (options.interface !== undefined && !owners.some(([id]) => id === options.interface))
          continue;
        if (interfaceId !== undefined && !owners.some(([id]) => id === interfaceId)) continue;
        interfaceId ??= owners[0][0];
      } else if (
        interfaces.size > 0 &&
        [...interfaces.values()].some((endpoints) => endpoints.size > 0)
      ) {
        continue;
      } else if (
        !fields.has('usbhid.data') &&
        !(
          interfaceId !== undefined &&
          (explicitClass === 3 || interfaces.has(interfaceId) || interfaceId === options.interface)
        )
      ) {
        warn('missing HID interface/endpoint evidence; packet skipped');
        continue;
      }
    }
    const rawPayload = firstField(fields, ['usbhid.data', 'usb.capdata', 'usb.data_fragment']);
    if (rawPayload === undefined) {
      // Setup and status packets carry no report, unlike an interrupt submission.
      const completion = firstField(fields, ['usb.urb_type']);
      if (
        transfer === 'interrupt' &&
        completion !== 'C' &&
        completion !== '0x43' &&
        numberField(fields, 'usb.irp_info.direction') !== 1
      )
        warn('missing payload; packet skipped');
      continue;
    }
    let bytes;
    try {
      bytes = hexBytes(rawPayload);
    } catch {
      warn('malformed payload hex; packet skipped');
      continue;
    }
    // Some HID dissectors expose the report ID separately from usbhid.data.
    if (
      fields.has('usbhid.data') &&
      bytes[0] !== HID_REPORT_ID &&
      numberField(fields, 'usbhid.report_id') === HID_REPORT_ID
    ) {
      bytes = Uint8Array.of(HID_REPORT_ID, ...bytes);
    }
    if (bytes[0] !== HID_REPORT_ID) continue;
    const signature = hex(bytes);
    if (key && seen.get(key) === signature) continue;
    if (key) seen.set(key, signature);
    reports.push({
      bytes,
      transfer,
      stream: `${selected}/${transfer}/${interfaceId ?? endpoint}`,
      packet,
    });
  }
  return reports;
}

/**
 * Strict reduced Windows/Chromium capture, not an auto-detected tshark shape.
 * Preserve capture order and bytes; never synthesize reports from the codec.
 * @param {unknown} capture
 * @returns {Report[]}
 */
function extractInterruptOutRaw(capture) {
  if (!Array.isArray(capture)) throw new Error('Raw capture must be a JSON array');
  let previousFrame = 0;
  let previousTime = -1;
  return capture.map((entry) => {
    const { frame, t, hex: value } = object(entry);
    const packet = integer(frame);
    const bytes = hexBytes(value);
    if (
      packet === undefined ||
      packet <= previousFrame ||
      typeof t !== 'number' ||
      !Number.isFinite(t) ||
      t < 0 ||
      t < previousTime ||
      bytes.length !== REPORT_SIZE + 1 ||
      bytes[0] !== HID_REPORT_ID
    ) {
      throw new Error(
        'Invalid interrupt-out-raw entry: ordered frame/t and CB + 31 bytes required',
      );
    }
    previousFrame = packet;
    previousTime = t;
    return { bytes, transfer: 'interrupt', stream: 'interrupt-out-raw', packet };
  });
}

/** @returns {Map<string, string[]>} */
function referenceCurves() {
  const fixture = JSON.parse(
    readFileSync(new URL('../test/fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
  );
  /** @type {Map<string, string[]>} */
  const curves = new Map();
  for (const [curve, preset] of Object.entries(
    /** @type {Record<string, {reports: number[][]}>} */ (fixture.presets),
  )) {
    curves.set(curve, preset.reports.map(hex));
  }
  curves.set(NEUTRO.id, encodeReports(NEUTRO.bands, NEUTRO.preampDb).map(hex));
  return curves;
}

/**
 * Validate complete writes. Normalization takes exactly bytes 1..31, never
 * trims meaningful trailing zeroes. All bytes after that must be zero. Short
 * reference commits (CB + five command bytes) are zero-extended for validation
 * only; their actual wire length is retained, so a mixed-length golden fails.
 * @param {unknown} capture
 * @param {CaptureOptions} options
 * @returns {{golden: Golden, warnings: {message: string, count: number}[]}}
 */
export function captureGolden(capture, options) {
  const counts = new Map();
  /** @param {string} message */
  const warn = (message) => counts.set(message, (counts.get(message) ?? 0) + 1);
  if (options.inputFormat && !['tshark', 'interrupt-out-raw'].includes(options.inputFormat))
    throw new Error('Invalid input format');
  const reports =
    options.inputFormat === 'interrupt-out-raw'
      ? extractInterruptOutRaw(capture)
      : extractReports(capture, options, warn);
  const curves = referenceCurves();
  const order = [...curves.keys()];
  const commit = hex(commitReport());
  /** @type {Map<string, Report[]>} */
  const pending = new Map();
  /** @type {GoldenWrite[]} */
  const writes = [];
  /** @type {Transfer | undefined} */
  let transfer;
  let paddedLength = 0;
  let previousCurve = -1;
  for (const report of reports) {
    const { bytes, stream } = report;
    const group = pending.get(stream) ?? [];
    const data = new Uint8Array(REPORT_SIZE);
    data.set(bytes.subarray(1, REPORT_SIZE + 1));
    const isCommit = hex(data) === commit;
    if (
      (!isCommit && bytes.length < REPORT_SIZE + 1) ||
      bytes.subarray(REPORT_SIZE + 1).some((byte) => byte !== 0)
    ) {
      warn('invalid report length or nonzero padding; packet skipped');
      if (group.length) warn('incomplete write discarded');
      pending.delete(stream);
      continue;
    }
    if (isCommit) {
      pending.delete(stream);
      if (group.length !== REPORT_COUNT) {
        warn('incomplete write discarded');
        continue;
      }
      const normalized = group.map(({ bytes: buffer }) => hex(buffer.subarray(1, REPORT_SIZE + 1)));
      const match = [...curves].find(([, expected]) =>
        expected.every((value, index) => value === normalized[index]),
      );
      if (!match)
        throw new Error(
          `Write ending at packet ${report.packet} does not match any reference curve or Neutro`,
        );
      if (
        [...group, report].some((entry) => entry.bytes.length !== bytes.length) ||
        (paddedLength && paddedLength !== bytes.length) ||
        (transfer && transfer !== report.transfer)
      ) {
        throw new Error(
          'Mixed transfer routes or padded lengths cannot be represented by one golden',
        );
      }
      transfer = report.transfer;
      paddedLength = bytes.length;
      const [curve] = match;
      const curveIndex = order.indexOf(curve);
      if (curveIndex <= previousCurve)
        warn(`out-of-order curve: ${curve} (fixture order: ${order.join(', ')})`);
      previousCurve = curveIndex;
      writes.push({ curve, reports: group.map((entry) => hex(entry.bytes)), commit: hex(bytes) });
    } else if (data[0] === group.length && group.length < REPORT_COUNT) {
      group.push(report);
      pending.set(stream, group);
    } else {
      if (group.length) warn('incomplete write discarded');
      pending.delete(stream);
      if (data[0] === 0) pending.set(stream, [report]);
      else warn('unexpected report index; packet skipped');
    }
  }
  for (const group of pending.values()) if (group.length) warn('incomplete write discarded');
  if (!transfer || writes.length === 0)
    throw new Error(`No complete valid writes; ${JSON.stringify([...counts])}`);
  return {
    golden: {
      capturedOn: options.capturedOn,
      os: options.os,
      browser: options.browser,
      transfer,
      paddedLength,
      writes,
    },
    warnings: [...counts].map(([message, count]) => ({ message, count })),
  };
}

/**
 * Compare in recorded order, ignoring monotonic timestamps, never removing a
 * prefix or padding. A missing/extra report cannot disappear through regrouping.
 * Accepts the actual diagnostics object or its wireLog array, not an assumed
 * {reports: ...} format. Differences name the write, report/commit and byte.
 * @param {unknown} input
 * @param {unknown} goldenInput
 * @returns {string[]}
 */
export function compareWireLog(input, goldenInput) {
  const golden = object(goldenInput);
  const paddedLength = integer(golden.paddedLength);
  if (
    !paddedLength ||
    paddedLength < REPORT_SIZE + 1 ||
    !['interrupt', 'control'].includes(String(golden.transfer)) ||
    !Array.isArray(golden.writes) ||
    golden.writes.length === 0
  ) {
    throw new Error('Invalid golden: transfer, paddedLength and nonempty writes are required');
  }
  /** @type {{bytes: Uint8Array, label: string}[]} */
  const expected = [];
  golden.writes.forEach((entry, index) => {
    const write = object(entry);
    if (
      typeof write.curve !== 'string' ||
      !Array.isArray(write.reports) ||
      write.reports.length !== REPORT_COUNT
    ) {
      throw new Error(`Invalid golden write ${index + 1}`);
    }
    [...write.reports, write.commit].forEach((value, reportIndex) => {
      const bytes = hexBytes(value);
      if (bytes.length !== paddedLength || bytes[0] !== HID_REPORT_ID) {
        throw new Error(`Invalid golden buffer in write ${index + 1}`);
      }
      expected.push({
        bytes,
        label: `write ${index + 1} (${write.curve}) ${reportIndex === REPORT_COUNT ? 'commit' : `report ${reportIndex}`}`,
      });
    });
  });
  const diagnostics = object(input);
  const entries = Array.isArray(input) ? input : diagnostics.wireLog;
  if (!Array.isArray(entries))
    throw new Error('Expected a wireLog array or diagnostics object with wireLog');
  const differences = [];
  for (const field of ['transfer', 'paddedLength']) {
    if (diagnostics[field] !== undefined && diagnostics[field] !== golden[field]) {
      differences.push(`${field}: expected ${golden[field]}, got ${diagnostics[field]}`);
    }
  }
  if (entries.length !== expected.length)
    differences.push(`buffer count: expected ${expected.length}, got ${entries.length}`);
  for (let i = 0; i < Math.max(entries.length, expected.length); i++) {
    const wanted = expected[i];
    const entry = object(entries[i]);
    if (i >= entries.length) {
      differences.push(`${wanted.label}: missing buffer`);
      continue;
    }
    const atMs = entry.atMs;
    if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs < 0) {
      differences.push(`buffer ${i + 1}: invalid atMs`);
    }
    let actual;
    try {
      actual = hexBytes(entry.hex);
    } catch {
      differences.push(`buffer ${i + 1}: malformed hex`);
      continue;
    }
    if (!wanted) {
      differences.push(`buffer ${i + 1}: unexpected extra buffer`);
      continue;
    }
    if (actual.length !== wanted.bytes.length) {
      differences.push(
        `${wanted.label}: padded length expected ${wanted.bytes.length}, got ${actual.length}`,
      );
    }
    const offset = wanted.bytes.findIndex((byte, index) => byte !== actual[index]);
    if (offset >= 0)
      differences.push(
        `${wanted.label}: byte ${offset} expected ${hex(wanted.bytes.slice(offset, offset + 1))}, got ${actual[offset] === undefined ? 'missing' : hex(actual.slice(offset, offset + 1))}`,
      );
  }
  return differences;
}

export const USAGE = `Usage:
  node tools/usb-golden.mjs <tshark.json> --captured-on <date> --os <os> --browser <browser>
    [--address <bus.dev>] [--interface <number>] [--out <file>]
    [--input-format tshark|interrupt-out-raw] [--provenance <metadata.json>]
  node tools/usb-golden.mjs --compare <wire-log.json> [--golden <golden.json>]

Default output/golden: test/fixtures/usb-wire-golden.json
Capture all enumeration descriptors; do not filter away setup/configuration packets.
Use --address when enumeration is absent or multiple matching devices are present.
interrupt-out-raw: reviewed [{frame, t, hex}] extraction of HID interrupt OUT
submissions (relative seconds, CB + 31 bytes); cannot use --address/--interface.
--provenance copies a reviewed metadata object to the golden's _provenance.
Curve IDs follow eq0xcb.reference.json, then neutro (ten OFF sections, -0.5 dB).
Golden hex retains CB and padding. Mixed routes/lengths and unknown curves fail.
Warnings count skipped packets/incomplete writes; partial captures are not F5 12/12 proof.
Metadata comes only from flags, never the local clock or environment.`;

/** @param {string[]} args */
export function parseArgs(args) {
  /** @type {Record<string, string>} */
  const flags = {};
  let capture;
  const allowed = [
    '--captured-on',
    '--os',
    '--browser',
    '--address',
    '--interface',
    '--out',
    '--compare',
    '--golden',
    '--input-format',
    '--provenance',
  ];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' && args.length === 1) return { help: true, flags };
    if (allowed.includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || flags[arg] !== undefined) throw new Error(USAGE);
      flags[arg] = value;
    } else if (!arg.startsWith('-') && capture === undefined) capture = arg;
    else throw new Error(USAGE);
  }
  if (flags['--compare']) {
    if (capture || Object.keys(flags).some((flag) => !['--compare', '--golden'].includes(flag)))
      throw new Error(USAGE);
  } else {
    if (
      !capture ||
      !flags['--captured-on']?.trim() ||
      !flags['--os']?.trim() ||
      !flags['--browser']?.trim() ||
      flags['--golden']
    )
      throw new Error(USAGE);
    if (flags['--address']) parseAddress(flags['--address']);
    if (
      (flags['--input-format'] &&
        !['tshark', 'interrupt-out-raw'].includes(flags['--input-format'])) ||
      (flags['--input-format'] === 'interrupt-out-raw' &&
        (flags['--address'] !== undefined || flags['--interface'] !== undefined))
    )
      throw new Error(USAGE);
    if (flags['--interface'] !== undefined) {
      const id = integer(flags['--interface']);
      if (id === undefined || id < 0 || id > 255) throw new Error('Invalid --interface');
    }
  }
  return { help: false, capture, flags };
}

/** @param {string[]} args */
export function main(args) {
  const parsed = parseArgs(args);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const { flags } = parsed;
  /** @param {string} file @returns {unknown} */
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const defaultGolden = 'test/fixtures/usb-wire-golden.json';
  if (flags['--compare']) {
    const differences = compareWireLog(
      readJson(flags['--compare']),
      readJson(flags['--golden'] ?? defaultGolden),
    );
    if (differences.length) {
      console.error(differences.join('\n'));
      return 1;
    }
    console.log('Wire log matches golden (all reports, commit, report IDs and padded buffers).');
    return 0;
  }
  const { golden, warnings } = captureGolden(readJson(parsed.capture ?? ''), {
    capturedOn: flags['--captured-on'],
    os: flags['--os'],
    browser: flags['--browser'],
    address: flags['--address'],
    interface: integer(flags['--interface']),
    inputFormat: flags['--input-format'],
  });
  const provenance = flags['--provenance'] ? readJson(flags['--provenance']) : undefined;
  if (provenance !== undefined && Object.keys(object(provenance)).length === 0)
    throw new Error('Provenance must be a nonempty metadata object');
  for (const { message, count } of warnings) console.error(`Warning (${count}): ${message}`);
  const out = flags['--out'] ?? defaultGolden;
  writeFileSync(
    out,
    `${JSON.stringify(provenance === undefined ? golden : { _provenance: provenance, ...golden }, null, 2)}\n`,
  );
  console.log(
    `Validated ${golden.writes.length} writes, ${golden.transfer}, ${golden.paddedLength} bytes -> ${out}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
