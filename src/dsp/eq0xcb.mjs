// 0xCB wire format — open implementation.
//
// Spec: ../../docs/protocol-0xcb.md
//
// Sources:
// - Peaking, low-shelf and high-shelf design are ported from AutoEq
//   (https://github.com/jaakkopasanen/AutoEq, autoeq/peq.py:
//   Peaking/LowShelf/HighShelf.biquad_coefficients),
//   Copyright (c) 2018-2022 Jaakko Pasanen, MIT License — see
//   THIRD_PARTY_NOTICES.md. The arithmetic is kept in AutoEq's order.
// - Low and high pass follow Robert Bristow-Johnson's Audio EQ Cookbook
//   directly (AutoEq has no such filters).
// - The magnitude response is this project's own (see magnitudeDb).
// - The byte layout (preamble, Q23 preamp, Q27 sections in [b0, b2, -a1, b1, -a2]
//   order, CRC, framing and commit command) was learned from the reference
//   implementation by Kuba (https://equalizador.kuba.audio/). No code or names
//   come from it.
//
// This module is pure (no DOM, no HID), so it runs identically in Node and in
// the browser. The HID transport lives elsewhere; here we only build the bytes.
//
// encodePayload() is the last gate before the chip's flash, and the flash cannot
// be read back. It therefore refuses anything that could write silence, an
// unstable filter or gain before the bands: unknown kinds, non-finite or
// out-of-range parameters, a positive preamp, coefficients that do not fit
// int32, and sections whose *quantized* poles are not strictly inside the unit
// circle.
//
// Every entry point that takes a band list first copies it with snapshotBands()
// (one read per field), so validation and the encoded bytes always see the same
// values, even when the caller passes getters or Proxies.

/**
 * @typedef {{kind: 'PK' | 'LS' | 'HS', freqHz: number, gainDb: number, qFactor: number}} GainBand
 * @typedef {{kind: 'LP' | 'HP', freqHz: number, gainDb?: number, qFactor: number}} PassBand
 * @typedef {GainBand | PassBand | {kind: 'OFF'}} Band
 * @typedef {{b0: number, b1: number, b2: number, a1: number, a2: number}} Section
 */

export const USB_VID = 0x3302;
export const USB_PID = 0x8902;
export const HID_REPORT_ID = 0xcb;

/** Sample rate the coefficients are designed for. */
export const SAMPLE_RATE = 96000;

/** Number of biquad sections the firmware stores. */
export const BAND_COUNT = 10;

/** Fixed 14-byte prologue: ASCII "EQ1#", then (hypothesis) a u16 LE length and layout bytes. */
export const PREAMBLE = Object.freeze([
  0x45, 0x51, 0x31, 0x23, 0xd6, 0x00, 0x00, 0x0a, 0x04, 0x05, 0x01, 0x0a, 0x00, 0x00,
]);

/** Commit command as the reference sends it (5 bytes): persists the preset to flash. */
export const COMMIT_COMMAND = Object.freeze([0x01, 0x65, 0x00, 0x01, 0xff]);

/** Payload size in bytes: 14 preamble + 4 preamp + 10*5*4 coefficients + 2 CRC. */
export const PAYLOAD_SIZE = 220;

export const REPORT_SIZE = 31;
export const REPORT_COUNT = 9;

/**
 * Supported filter kinds. `OFF` is an exact pass-through section
 * (wire words [1, 0, 0, 0, 0]); prefer it to a 0 dB peaking band, which still
 * runs poles close to the unit circle.
 */
export const FILTER_KINDS = Object.freeze(['PK', 'LS', 'HS', 'LP', 'HP', 'OFF']);

/** @type {Readonly<{kind: 'OFF'}>} */
export const OFF = Object.freeze({ kind: 'OFF' });

/** Ten exact pass-through sections: the known-good neutral preset. */
export const NEUTRAL_BANDS = Object.freeze(Array.from({ length: BAND_COUNT }, () => OFF));

const KINDS_WITH_GAIN = new Set(['PK', 'LS', 'HS']);
const REPORT_DATA_SIZE = REPORT_SIZE - 1; // byte 0 of every report is its index
const Q23_ONE = 2 ** 23;
const Q27_ONE = 2 ** 27;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

// --- Biquad design ----------------------------------------------------------
//
// Every design function returns { b0, b1, b2, a1, a2 } normalized by a0, with
// the cookbook sign convention: H(z) = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2).

/**
 * AutoEq returns the feedback coefficients negated (its PEQFilter.fr flips them
 * back before use). Flip them once here; negation is exact in IEEE 754.
 * @param {Section} section
 * @returns {Section}
 */
function fromAutoEqSign({ a1, a2, b0, b1, b2 }) {
  return { b0, b1, b2, a1: -a1, a2: -a2 };
}

/**
 * Peaking EQ — AutoEq `Peaking.biquad_coefficients`.
 * @param {number} freqHz
 * @param {number} gainDb
 * @param {number} qFactor
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export function designPeaking(freqHz, gainDb, qFactor, sampleRate = SAMPLE_RATE) {
  // Math.pow, not `**`, so the result matches other JS implementations bit for bit.
  const amp = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * qFactor);
  const cosW0 = Math.cos(w0);

  const a0 = 1 + alpha / amp;
  return fromAutoEqSign({
    a1: -(-2 * cosW0) / a0,
    a2: -(1 - alpha / amp) / a0,
    b0: (1 + alpha * amp) / a0,
    b1: (-2 * cosW0) / a0,
    b2: (1 - alpha * amp) / a0,
  });
}

/**
 * Low shelf — AutoEq `LowShelf.biquad_coefficients`.
 * @param {number} freqHz
 * @param {number} gainDb
 * @param {number} qFactor
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export function designLowShelf(freqHz, gainDb, qFactor, sampleRate = SAMPLE_RATE) {
  const amp = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * qFactor);
  const cosW0 = Math.cos(w0);
  const twoSqrtAmpAlpha = 2 * Math.sqrt(amp) * alpha;

  const a0 = amp + 1 + (amp - 1) * cosW0 + twoSqrtAmpAlpha;
  return fromAutoEqSign({
    a1: -(-2 * (amp - 1 + (amp + 1) * cosW0)) / a0,
    a2: -(amp + 1 + (amp - 1) * cosW0 - twoSqrtAmpAlpha) / a0,
    b0: (amp * (amp + 1 - (amp - 1) * cosW0 + twoSqrtAmpAlpha)) / a0,
    b1: (2 * amp * (amp - 1 - (amp + 1) * cosW0)) / a0,
    b2: (amp * (amp + 1 - (amp - 1) * cosW0 - twoSqrtAmpAlpha)) / a0,
  });
}

/**
 * High shelf — AutoEq `HighShelf.biquad_coefficients`.
 * @param {number} freqHz
 * @param {number} gainDb
 * @param {number} qFactor
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export function designHighShelf(freqHz, gainDb, qFactor, sampleRate = SAMPLE_RATE) {
  const amp = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * qFactor);
  const cosW0 = Math.cos(w0);
  const twoSqrtAmpAlpha = 2 * Math.sqrt(amp) * alpha;

  const a0 = amp + 1 - (amp - 1) * cosW0 + twoSqrtAmpAlpha;
  return fromAutoEqSign({
    a1: -(2 * (amp - 1 - (amp + 1) * cosW0)) / a0,
    a2: -(amp + 1 - (amp - 1) * cosW0 - twoSqrtAmpAlpha) / a0,
    b0: (amp * (amp + 1 + (amp - 1) * cosW0 + twoSqrtAmpAlpha)) / a0,
    b1: (-2 * amp * (amp - 1 + (amp + 1) * cosW0)) / a0,
    b2: (amp * (amp + 1 + (amp - 1) * cosW0 - twoSqrtAmpAlpha)) / a0,
  });
}

/**
 * 2nd-order low pass — RBJ Audio EQ Cookbook.
 * @param {number} freqHz
 * @param {number} qFactor
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export function designLowPass(freqHz, qFactor, sampleRate = SAMPLE_RATE) {
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * qFactor);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cosW0) / 2 / a0,
    b1: (1 - cosW0) / a0,
    b2: (1 - cosW0) / 2 / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * 2nd-order high pass — RBJ Audio EQ Cookbook.
 * @param {number} freqHz
 * @param {number} qFactor
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export function designHighPass(freqHz, qFactor, sampleRate = SAMPLE_RATE) {
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * qFactor);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosW0) / 2 / a0,
    b1: -(1 + cosW0) / a0,
    b2: (1 + cosW0) / 2 / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Section coefficients for a band `{ kind, freqHz, gainDb, qFactor }`. Throws on
 * an unknown kind: codes such as `LSQ`/`HSQ` (EqualizerAPO, hangout.audio) must
 * be mapped explicitly by the caller, never guessed.
 * @param {Band} band
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export function designSection(band, sampleRate = SAMPLE_RATE) {
  switch (band.kind) {
    case 'PK':
      return designPeaking(band.freqHz, band.gainDb, band.qFactor, sampleRate);
    case 'LS':
      return designLowShelf(band.freqHz, band.gainDb, band.qFactor, sampleRate);
    case 'HS':
      return designHighShelf(band.freqHz, band.gainDb, band.qFactor, sampleRate);
    case 'LP':
      return designLowPass(band.freqHz, band.qFactor, sampleRate);
    case 'HP':
      return designHighPass(band.freqHz, band.qFactor, sampleRate);
    case 'OFF':
      return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    default:
      throw new TypeError(`unknown filter kind ${JSON.stringify(/** @type {Band} */ (band).kind)}`);
  }
}

// --- Snapshot ---------------------------------------------------------------

/**
 * One-read copy of a band list, taken before any check, so every later check and
 * the encoded bytes see the same values whatever the caller passes (getters,
 * Proxies, objects mutated in between).
 *
 * Reads `bands.length` once, then each index 0..length−1 once, in order, and of
 * each element `kind`, `freqHz`, `gainDb` and `qFactor` exactly once each, in
 * that order, even for OFF. Each element becomes a new frozen plain object:
 * `{kind: 'OFF'}` for OFF, otherwise `kind` plus the other three fields as read,
 * omitting those that read as `undefined`. Nothing is coerced or validated
 * here: the codec rejects invalid values.
 *
 * Throws a TypeError for a non-array (`bands must be an array`), for a hole
 * (`band <i>: missing (hole in a sparse array)`; holes are never skipped) and for
 * a non-object element (`band <i>: not an object`, the codec's own message).
 * With `expectedLength`, a different length throws `RangeError('expected <n>
 * bands')` before any element is read. Errors thrown by getters or Proxy traps
 * propagate unchanged.
 * @param {unknown} bands
 * @param {number} [expectedLength]
 * @returns {readonly Readonly<Band>[]} A frozen array of frozen bands.
 */
export function snapshotBands(bands, expectedLength) {
  if (!Array.isArray(bands)) throw new TypeError('bands must be an array');
  const length = bands.length;
  if (expectedLength !== undefined && length !== expectedLength) {
    throw new RangeError(`expected ${expectedLength} bands`);
  }
  if (!(Number.isSafeInteger(length) && length >= 0)) {
    throw new RangeError(`invalid band count ${String(length)}`);
  }
  /** @type {Readonly<Band>[]} */
  const copies = [];
  for (let index = 0; index < length; index++) {
    if (!(index in bands)) throw new TypeError(`band ${index}: missing (hole in a sparse array)`);
    /** @type {unknown} */
    const band = bands[index];
    if (band === null || typeof band !== 'object') {
      throw new TypeError(`band ${index}: not an object`);
    }
    const { kind, freqHz, gainDb, qFactor } = /** @type {Record<string, unknown>} */ (band);
    if (kind === 'OFF') {
      copies.push(Object.freeze({ kind: 'OFF' }));
      continue;
    }
    /** @type {Record<string, unknown>} */
    const copy = { kind };
    if (freqHz !== undefined) copy.freqHz = freqHz;
    if (gainDb !== undefined) copy.gainDb = gainDb;
    if (qFactor !== undefined) copy.qFactor = qFactor;
    copies.push(/** @type {Readonly<Band>} */ (/** @type {unknown} */ (Object.freeze(copy))));
  }
  return Object.freeze(copies);
}

// --- Validation -------------------------------------------------------------

/**
 * @param {number} index
 * @param {string} message
 */
function bandError(index, message) {
  return new RangeError(`band ${index}: ${message}`);
}

/**
 * Rejects bands whose parameters cannot describe a valid filter at SAMPLE_RATE.
 * @param {Band} band
 * @param {number} [index]
 */
export function checkBand(band, index = 0) {
  if (band === null || typeof band !== 'object')
    throw new TypeError(`band ${index}: not an object`);
  if (!FILTER_KINDS.includes(band.kind)) {
    throw new TypeError(`band ${index}: unknown filter kind ${JSON.stringify(band.kind)}`);
  }
  if (band.kind === 'OFF') return;
  const nyquist = SAMPLE_RATE / 2;
  if (!(Number.isFinite(band.freqHz) && band.freqHz > 0 && band.freqHz < nyquist)) {
    throw bandError(index, `freqHz must be in (0, ${nyquist}), got ${band.freqHz}`);
  }
  if (!(Number.isFinite(band.qFactor) && band.qFactor > 0)) {
    throw bandError(index, `qFactor must be > 0, got ${band.qFactor}`);
  }
  if (KINDS_WITH_GAIN.has(band.kind) && !Number.isFinite(band.gainDb)) {
    throw bandError(index, `gainDb must be finite, got ${band.gainDb}`);
  }
}

/**
 * Jury criterion for 1 + a1 z^-1 + a2 z^-2: both poles strictly inside the unit circle.
 * @param {number} a1
 * @param {number} a2
 */
export function isStable(a1, a2) {
  return Math.abs(a2) < 1 && Math.abs(a1) < 1 + a2;
}

/**
 * Quantizes one section to its 5 wire words `[b0, b2, -a1, b1, -a2]` (Q27).
 * Stability is checked on the quantized feedback words, which is what the chip
 * will actually run.
 * @param {Section} section
 * @param {number} [index]
 */
export function encodeSection(section, index = 0) {
  const ordered = [section.b0, section.b2, -section.a1, section.b1, -section.a2];
  const words = ordered.map((coefficient) => {
    // `+ 0` turns -0 (from negating a zero a1/a2) into 0.
    const word = Math.round(coefficient * Q27_ONE) + 0;
    if (!Number.isInteger(word) || word > INT32_MAX || word < INT32_MIN) {
      throw bandError(index, 'coefficient does not fit Q27 in int32');
    }
    return word;
  });
  if (!isStable(-words[2] / Q27_ONE, -words[4] / Q27_ONE)) {
    throw bandError(index, 'unstable section: poles on or outside the unit circle');
  }
  return words;
}

// --- Wire encoding ----------------------------------------------------------

/**
 * Q23 linear-gain word for a preamp in dB. The preamp runs before the bands,
 * so a positive value clips full-scale content: it is refused.
 */
export function preampWord(preampDb = 0) {
  if (!Number.isFinite(preampDb)) {
    throw new RangeError(`preamp must be a finite dB value, got ${preampDb}`);
  }
  if (preampDb > 0) throw new RangeError(`preamp must be <= 0 dB, got ${preampDb}`);
  return Math.round(Math.pow(10, preampDb / 20) * Q23_ONE);
}

/**
 * CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no final XOR).
 * @param {Iterable<number>} data
 */
export function crc16Ccitt(data) {
  let register = 0xffff;
  for (const byte of data) {
    register ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      register = register & 0x8000 ? ((register << 1) ^ 0x1021) & 0xffff : (register << 1) & 0xffff;
    }
  }
  return register;
}

/**
 * @param {number[]} buffer
 * @param {number} value
 */
function appendInt32LE(buffer, value) {
  if (!Number.isInteger(value) || value > INT32_MAX || value < INT32_MIN) {
    throw new RangeError(`value does not fit int32: ${value}`);
  }
  buffer.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/**
 * Builds the 220-byte payload for 10 bands and a preamp. Bands are written in
 * the order given: keep cuts before boosts (see docs/protocol-0xcb.md), the
 * ordering the reference uses to avoid internal clipping.
 *
 * The bands are copied once with {@link snapshotBands} before anything else, so
 * every check and every byte comes from the same read of each field. Throws a
 * RangeError for a non-array or a count other than 10, a TypeError for holes,
 * non-object elements and unknown kinds, and a RangeError for invalid values;
 * it never returns anything but a 220-byte payload.
 * @param {readonly Band[]} eqBands
 * @param {number} [preampDb] Must be a finite number <= 0 (nothing is coerced).
 * @returns {number[]}
 */
export function encodePayload(eqBands, preampDb = 0) {
  if (!Array.isArray(eqBands)) throw new RangeError(`expected ${BAND_COUNT} bands`);
  const bands = snapshotBands(eqBands, BAND_COUNT);
  for (let index = 0; index < BAND_COUNT; index++) checkBand(bands[index], index);
  const payload = [...PREAMBLE];
  appendInt32LE(payload, preampWord(preampDb));
  for (let index = 0; index < BAND_COUNT; index++) {
    for (const word of encodeSection(designSection(bands[index]), index)) {
      appendInt32LE(payload, word);
    }
  }
  const checksum = crc16Ccitt(payload);
  payload.push(checksum & 0xff, checksum >>> 8);
  return payload;
}

/**
 * Splits an already encoded payload into the 9 HID reports: byte 0 is the report
 * index, bytes 1..30 carry 30 bytes of the payload (the last report is
 * zero-padded). Throws a RangeError unless `payload` holds exactly 220 bytes
 * (integers 0..255) whose last two are the little-endian CRC-16 of the rest, so
 * a transport can send exactly the bytes a gate approved, without re-encoding.
 * @param {ArrayLike<number>} payload
 * @returns {Uint8Array[]}
 */
export function reportsFromPayload(payload) {
  if (payload === null || typeof payload !== 'object' || payload.length !== PAYLOAD_SIZE) {
    throw new RangeError(`payload must be ${PAYLOAD_SIZE} bytes`);
  }
  const bytes = new Uint8Array(PAYLOAD_SIZE);
  for (let index = 0; index < PAYLOAD_SIZE; index++) {
    const byte = payload[index];
    if (!(Number.isInteger(byte) && byte >= 0 && byte <= 0xff)) {
      throw new RangeError(`payload byte ${index} is not a byte: ${byte}`);
    }
    bytes[index] = byte;
  }
  const crc = bytes[PAYLOAD_SIZE - 2] | (bytes[PAYLOAD_SIZE - 1] << 8);
  if (crc !== crc16Ccitt(bytes.subarray(0, PAYLOAD_SIZE - 2))) {
    throw new RangeError('payload CRC mismatch');
  }
  return Array.from({ length: REPORT_COUNT }, (_, index) => {
    const report = new Uint8Array(REPORT_SIZE);
    report[0] = index;
    report.set(bytes.subarray(index * REPORT_DATA_SIZE, (index + 1) * REPORT_DATA_SIZE), 1);
    return report;
  });
}

/**
 * The 9 HID reports for 10 bands and a preamp:
 * `reportsFromPayload(encodePayload(eqBands, preampDb))`.
 * @param {readonly Band[]} eqBands
 * @param {number} [preampDb]
 */
export function encodeReports(eqBands, preampDb) {
  return reportsFromPayload(encodePayload(eqBands, preampDb));
}

/**
 * The commit command zero-padded to the 31-byte report size, so every transport
 * sends the same bytes. The reference sends the bare 5 bytes; whether the
 * firmware distinguishes the two is unverified.
 */
export function commitReport() {
  const report = new Uint8Array(REPORT_SIZE);
  report.set(COMMIT_COMMAND);
  return report;
}

/**
 * Magnitude response (dB) of `eqBands` at `freqHz`, summed across sections.
 *
 * Each polynomial p0 + p1 z^-1 + p2 z^-2 is evaluated around z^-1 = 1, with
 * u = 1 - e^-jw = 2 sin^2(w/2) + j sin w, as S - T u + p2 u^2 where
 * S = p0 + p1 + p2 and T = p1 + 2 p2. Near DC, where low-frequency poles and
 * zeros cluster, this avoids the cancellation that costs other forms precision.
 * Worst error against an exact (200-bit) evaluation of the same coefficients,
 * measured on ~27 000 cases: 6e-14 dB, against 4e-9 dB for the direct form and
 * 1.5e-7 dB for AutoEq's phi form (PEQFilter.fr), which is why that one is not
 * used here.
 * @param {readonly Band[]} eqBands
 * @param {number} freqHz
 * @param {number} [sampleRate]
 */
export function magnitudeDb(eqBands, freqHz, sampleRate = SAMPLE_RATE) {
  const omega = (2 * Math.PI * freqHz) / sampleRate;
  const halfSin = Math.sin(omega / 2);
  const uRe = 2 * halfSin * halfSin;
  const uIm = Math.sin(omega);
  const uSquaredRe = uRe * uRe - uIm * uIm;
  const uSquaredIm = 2 * uRe * uIm;
  /**
   * @param {number} p0
   * @param {number} p1
   * @param {number} p2
   */
  const powerAt = (p0, p1, p2) => {
    const sum = p0 + p1 + p2;
    const slope = p1 + 2 * p2;
    const re = sum - slope * uRe + p2 * uSquaredRe;
    const im = -slope * uIm + p2 * uSquaredIm;
    return re * re + im * im;
  };
  let totalDb = 0;
  for (const band of eqBands) {
    const { b0, b1, b2, a1, a2 } = designSection(band, sampleRate);
    totalDb += 10 * Math.log10(powerAt(b0, b1, b2) / powerAt(1, a1, a2));
  }
  return totalDb;
}
