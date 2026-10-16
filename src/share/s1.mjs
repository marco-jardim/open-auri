// S1 v1: compact, canonical and lossless share code for a 10-band EQ curve.
//
// Spec (frozen): ../../docs/s1-format.md
//
// 51 bytes = 4-bit header (version, variant) + 10 x 38-bit bands + 8-bit preamp
// + CRC-16/CCITT-FALSE, written MSB first and serialized as exactly 68 base64url
// characters without padding. Bands keep their wire order: the internal peak of
// the chain depends on it.
//
// Pure ESM with no DOM or Node built-ins, so it runs unchanged in Node, browsers
// and Workers. curveId() uses WebCrypto (globalThis.crypto.subtle).

import { BAND_COUNT, crc16Ccitt, snapshotBands } from '../dsp/eq0xcb.mjs';

/** @import { Band } from '../dsp/eq0xcb.mjs' */

/**
 * @typedef {'s1:charset' | 's1:length' | 's1:version' | 's1:variant' | 's1:crc' | 's1:kind'
 *   | 's1:range' | 's1:noncanonical' | 's1:grid' | 's1:bands'} S1ErrorCode
 * @typedef {{version: number, variant: number, bands: Band[], preampDb: number}} S1Curve
 * @typedef {{bands: readonly Band[], preampDb: number}} S1Input
 * @typedef {{code: number, freq: number, gain: number, q: number}} WireBand
 */

/** Value of the version field for S1 v1. */
export const S1_VERSION = 1;

/** Value of the variant field for the parametric variant (the only one defined in v1). */
export const S1_VARIANT_PARAMETRIC = 0;

/** Size of an S1 v1 code in bytes. */
export const S1_BYTES = 51;

/** Size of an S1 v1 code in base64url characters (no padding). */
export const S1_LENGTH = 68;

/**
 * Kind codes on the wire (3 bits). Frozen by the format: this table is owned by
 * S1, not derived from the codec, so the codec may reorder its list freely.
 */
export const S1_KIND_CODES = /** @type {const} */ (['PK', 'LS', 'HS', 'LP', 'HP', 'OFF']);

const OFF_CODE = 5;
const BODY_BYTES = 49; // everything the CRC covers
const KIND_BITS = 3;
const FREQ_BITS = 15;
const GAIN_BITS = 9;
const Q_BITS = 11;
const PREAMP_BITS = 8;
const FREQ_MIN = 1;
const FREQ_MAX = 20000;
const GAIN_MIN = -256; // tenths of dB
const GAIN_MAX = 127;
const Q_MIN = 1; // hundredths
const Q_MAX = 2047;
const PREAMP_MAX = 255; // tenths of dB below 0
const GRID_TOLERANCE = 1e-9;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const CURVE_ID_LENGTH = 12;

/** Typed error with a stable `code` (see docs/s1-format.md). */
export class S1Error extends Error {
  /**
   * @param {S1ErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'S1Error';
    /** @type {S1ErrorCode} */
    this.code = code;
  }
}

// --- Validation and quantization -----------------------------------------------

/**
 * Maps a value to an integer number of grid steps. Refuses values off the grid
 * (beyond GRID_TOLERANCE) or outside [min, max] steps: it never rounds.
 * @param {unknown} value
 * @param {number} scale steps per unit
 * @param {number} min
 * @param {number} max
 * @param {string} what
 */
function toSteps(value, scale, min, max, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new S1Error('s1:range', `${what} must be a finite number`);
  }
  const steps = Math.round(value * scale) + 0;
  if (Math.abs(value - steps / scale) > GRID_TOLERANCE) {
    throw new S1Error('s1:grid', `${what} ${value} is not a multiple of ${1 / scale}`);
  }
  if (steps < min || steps > max) {
    throw new S1Error('s1:range', `${what} ${value} is outside [${min / scale}, ${max / scale}]`);
  }
  return steps;
}

/**
 * @param {Band} band
 * @param {number} index
 * @returns {WireBand}
 */
function toWireBand(band, index) {
  const where = `band ${index}`;
  const code = S1_KIND_CODES.indexOf(band.kind);
  if (code < 0) {
    throw new S1Error('s1:kind', `${where}: unknown filter kind`);
  }
  if (band.kind === 'OFF') return { code, freq: 0, gain: 0, q: 0 };
  const freq = toSteps(band.freqHz, 1, FREQ_MIN, FREQ_MAX, `${where} freqHz`);
  const q = toSteps(band.qFactor, 100, Q_MIN, Q_MAX, `${where} qFactor`);
  if (band.kind === 'LP' || band.kind === 'HP') {
    if (band.gainDb !== undefined) {
      const gain = toSteps(band.gainDb, 10, GAIN_MIN, GAIN_MAX, `${where} gainDb`);
      if (gain !== 0) {
        throw new S1Error('s1:range', `${where}: ${band.kind} carries no gain, got ${band.gainDb}`);
      }
    }
    return { code, freq, gain: 0, q };
  }
  const gain = toSteps(band.gainDb, 10, GAIN_MIN, GAIN_MAX, `${where} gainDb`);
  return { code, freq, gain, q };
}

/**
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 */
function toWireCurve(bands, preampDb) {
  /** @type {readonly Readonly<Band>[]} */
  let snapshot;
  try {
    snapshot = snapshotBands(bands, BAND_COUNT);
  } catch {
    throw new S1Error('s1:bands', `expected exactly ${BAND_COUNT} readable band objects, no holes`);
  }
  const wireBands = snapshot.map(toWireBand);
  const preamp = -toSteps(preampDb, 10, -PREAMP_MAX, 0, 'preampDb') + 0;
  return { wireBands, preamp };
}

// --- Bit packing ----------------------------------------------------------------

/**
 * @param {readonly WireBand[]} wireBands
 * @param {number} preamp tenths of dB below 0
 */
function pack(wireBands, preamp) {
  const bytes = new Uint8Array(S1_BYTES);
  let bit = 0;
  /**
   * @param {number} value
   * @param {number} width
   */
  const put = (value, width) => {
    for (let shift = width - 1; shift >= 0; shift--) {
      if ((value >>> shift) & 1) bytes[bit >>> 3] |= 0x80 >>> (bit & 7);
      bit++;
    }
  };
  put(S1_VERSION, 2);
  put(S1_VARIANT_PARAMETRIC, 2);
  for (const band of wireBands) {
    put(band.code, KIND_BITS);
    put(band.freq, FREQ_BITS);
    put(band.gain & 0x1ff, GAIN_BITS);
    put(band.q, Q_BITS);
  }
  put(preamp, PREAMP_BITS);
  const crc = crc16Ccitt(bytes.subarray(0, BODY_BYTES));
  bytes[BODY_BYTES] = crc >>> 8;
  bytes[BODY_BYTES + 1] = crc & 0xff;
  return bytes;
}

/** @param {Uint8Array} bytes */
function bitReader(bytes) {
  let bit = 0;
  /** @param {number} width */
  return (width) => {
    let value = 0;
    for (let i = 0; i < width; i++) {
      value = (value << 1) | ((bytes[bit >>> 3] >>> (7 - (bit & 7))) & 1);
      bit++;
    }
    return value;
  };
}

// --- base64url (RFC 4648 §5, no padding) ---------------------------------------

/** @param {Uint8Array} bytes length is a multiple of 3 */
function toBase64Url(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    text +=
      BASE64URL[n >>> 18] +
      BASE64URL[(n >>> 12) & 63] +
      BASE64URL[(n >>> 6) & 63] +
      BASE64URL[n & 63];
  }
  return text;
}

/** @param {string} text validated charset, length is a multiple of 4 */
function fromBase64Url(text) {
  const bytes = new Uint8Array((text.length / 4) * 3);
  for (let i = 0, j = 0; i < text.length; i += 4, j += 3) {
    const n =
      (BASE64URL.indexOf(text[i]) << 18) |
      (BASE64URL.indexOf(text[i + 1]) << 12) |
      (BASE64URL.indexOf(text[i + 2]) << 6) |
      BASE64URL.indexOf(text[i + 3]);
    bytes[j] = n >>> 16;
    bytes[j + 1] = (n >>> 8) & 0xff;
    bytes[j + 2] = n & 0xff;
  }
  return bytes;
}

// --- Decoding -------------------------------------------------------------------

/**
 * @param {number} index
 * @param {number} code
 * @param {number} freq
 * @param {number} gain signed tenths of dB
 * @param {number} q hundredths
 * @returns {Band}
 */
function fromWireBand(index, code, freq, gain, q) {
  const where = `band ${index}`;
  const kind = S1_KIND_CODES[code];
  if (kind === undefined) throw new S1Error('s1:kind', `${where}: invalid kind code ${code}`);
  if (kind === 'OFF') {
    if (freq !== 0 || gain !== 0 || q !== 0) {
      throw new S1Error('s1:noncanonical', `${where}: OFF band with non-zero fields`);
    }
    return { kind };
  }
  if (freq < FREQ_MIN || freq > FREQ_MAX) {
    throw new S1Error('s1:range', `${where}: freqHz ${freq} outside [${FREQ_MIN}, ${FREQ_MAX}]`);
  }
  if (gain > GAIN_MAX) {
    throw new S1Error('s1:range', `${where}: gainDb ${gain / 10} above ${GAIN_MAX / 10}`);
  }
  if (q < Q_MIN) throw new S1Error('s1:range', `${where}: qFactor 0`);
  if (kind === 'LP' || kind === 'HP') {
    if (gain !== 0) throw new S1Error('s1:noncanonical', `${where}: ${kind} with non-zero gain`);
    return { kind, freqHz: freq, qFactor: q / 100 };
  }
  return { kind, freqHz: freq, gainDb: gain / 10, qFactor: q / 100 };
}

/** @param {unknown} text */
function parse(text) {
  if (typeof text !== 'string' || !BASE64URL_RE.test(text)) {
    throw new S1Error('s1:charset', 'expected base64url characters [A-Za-z0-9_-] without padding');
  }
  if (text.length === 0) throw new S1Error('s1:length', 'empty string');
  // The header sits in the first character, so a future version is recognized
  // before its (possibly different) length is judged.
  const head = BASE64URL.indexOf(text[0]);
  const version = head >>> 4;
  if (version !== S1_VERSION) throw new S1Error('s1:version', `unsupported version ${version}`);
  const variant = (head >>> 2) & 3;
  if (variant !== S1_VARIANT_PARAMETRIC) {
    throw new S1Error('s1:variant', `unsupported variant ${variant}`);
  }
  if (text.length !== S1_LENGTH) {
    throw new S1Error('s1:length', `expected ${S1_LENGTH} characters, got ${text.length}`);
  }
  const bytes = fromBase64Url(text);
  const stored = (bytes[BODY_BYTES] << 8) | bytes[BODY_BYTES + 1];
  if (crc16Ccitt(bytes.subarray(0, BODY_BYTES)) !== stored) {
    throw new S1Error('s1:crc', 'checksum mismatch');
  }
  const read = bitReader(bytes);
  read(4);
  /** @type {Band[]} */
  const bands = [];
  for (let index = 0; index < BAND_COUNT; index++) {
    const code = read(KIND_BITS);
    const freq = read(FREQ_BITS);
    const rawGain = read(GAIN_BITS);
    const q = read(Q_BITS);
    bands.push(fromWireBand(index, code, freq, rawGain >= 256 ? rawGain - 512 : rawGain, q));
  }
  const preamp = read(PREAMP_BITS);
  return { bytes, bands, preampDb: preamp === 0 ? 0 : -preamp / 10 };
}

// --- Public API -----------------------------------------------------------------

/**
 * Encodes a curve as its S1 v1 string (68 characters). Bands keep their order.
 * Throws an S1Error (`s1:bands`, `s1:kind`, `s1:range`, `s1:grid`) for anything
 * that is not exactly representable; values are never rounded.
 * @param {S1Input} curve
 * @returns {string}
 */
export function encodeS1(curve) {
  if (curve === null || typeof curve !== 'object') {
    throw new S1Error('s1:bands', 'expected { bands, preampDb }');
  }
  const { wireBands, preamp } = toWireCurve(curve.bands, curve.preampDb);
  return toBase64Url(pack(wireBands, preamp));
}

/**
 * Decodes and validates an S1 string. Throws an S1Error with one of the codes
 * `s1:charset`, `s1:length`, `s1:version`, `s1:variant`, `s1:crc`, `s1:kind`,
 * `s1:range`, `s1:noncanonical`.
 * @param {string} s1
 * @returns {S1Curve}
 */
export function decodeS1(s1) {
  const { bands, preampDb } = parse(s1);
  return { version: S1_VERSION, variant: S1_VARIANT_PARAMETRIC, bands, preampDb };
}

/**
 * Order-independent canonical key for deduplication and similarity: equal for
 * every permutation of the same bands. Integer units (Hz, 0.1 dB, 0.01 Q),
 * bands sorted by frequency, kind code, Q and gain, OFF bands last as `OFF`.
 * Validates like encodeS1. Never use this order on the wire.
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @returns {string}
 */
export function canonKey(bands, preampDb) {
  const { wireBands, preamp } = toWireCurve(bands, preampDb);
  const sorted = [...wireBands].sort(
    (a, b) =>
      Number(a.code === OFF_CODE) - Number(b.code === OFF_CODE) ||
      a.freq - b.freq ||
      a.code - b.code ||
      a.q - b.q ||
      a.gain - b.gain,
  );
  const parts = sorted.map((band) =>
    band.code === OFF_CODE
      ? 'OFF'
      : `${S1_KIND_CODES[band.code]},${band.freq},${band.gain},${band.q}`,
  );
  return [`v${S1_VERSION}`, String(-preamp + 0), ...parts].join(';');
}

/**
 * Stable short id of a curve in wire order: the first 12 characters of the
 * lowercase, unpadded RFC 4648 base32 of SHA-256 over the 51 S1 bytes.
 * Validates the string first (same errors as decodeS1).
 * @param {string} s1
 * @returns {Promise<string>}
 */
export async function curveId(s1) {
  const { bytes } = parse(s1);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let id = '';
  let buffer = 0;
  let bits = 0;
  let next = 0;
  while (id.length < CURVE_ID_LENGTH) {
    if (bits < 5) {
      buffer = ((buffer << 8) | digest[next++]) & 0xfff;
      bits += 8;
    }
    id += BASE32[(buffer >>> (bits - 5)) & 31];
    bits -= 5;
  }
  return id;
}
