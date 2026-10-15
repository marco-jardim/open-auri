// 0xCB wire format — open implementation.
//
// Spec: ../../docs/protocol-0xcb.md
//
// Credit: the wire layout (header, Q23 preamp, Q27 sections in
// [b0, b2, -a1, b1, -a2] order, CRC, framing and commit) and the structure of
// the filter-design code follow the reference implementation by Kuba
// (https://equalizador.kuba.audio/). Filter formulas: Robert Bristow-Johnson,
// "Cookbook formulae for audio EQ biquad filter coefficients".
//
// Exported names and the local names inside the functions shared with the
// reference (A, w, al, c, s, a0; b, c, v, n, pre, crc; b, pk, p, chunk;
// k, nr, ni, dr, di) are kept identical to it, so the two can be read side
// by side.
//
// This module is pure (no DOM, no HID), so it runs identically in Node and in
// the browser. The HID transport lives elsewhere; here we only build the bytes.
//
// blob() is the last gate before the chip's flash, and the flash cannot be
// read back. It therefore refuses anything that could write silence or an
// unstable filter: unknown types, non-finite or out-of-range parameters,
// coefficients that do not fit int32, and sections whose *quantized* poles are
// not strictly inside the unit circle.

export const VENDOR_ID = 0x3302;
export const PRODUCT_ID = 0x8902;
export const REPORT_ID = 0xcb;

/** DSP sample rate the coefficients are designed for. */
export const FS = 96000;

/** Number of biquad sections the firmware stores. */
export const BAND_COUNT = 10;

/** Fixed 14-byte prologue: ASCII "EQ1#", then (hypothesis) a u16 LE length and layout bytes. */
export const HEADER = Object.freeze([
  0x45, 0x51, 0x31, 0x23, 0xd6, 0x00, 0x00, 0x0a, 0x04, 0x05, 0x01, 0x0a, 0x00, 0x00,
]);

/** Commit packet as the reference sends it (5 bytes): persists the preset to flash. */
export const APPLY = Object.freeze([0x01, 0x65, 0x00, 0x01, 0xff]);

/** Blob size in bytes: 14 header + 4 preamp + 10*5*4 coefficients + 2 CRC. */
export const BLOB_SIZE = 220;

export const PACKET_SIZE = 31;
export const PACKET_COUNT = 9;

/**
 * Supported band types. `OFF` is an exact pass-through section
 * ([b0, b2, -a1, b1, -a2] = [1, 0, 0, 0, 0]); prefer it to a 0 dB peaking band,
 * which still runs poles close to the unit circle.
 */
export const FILTER_TYPES = Object.freeze(['PK', 'LS', 'HS', 'LP', 'HP', 'OFF']);

export const OFF = Object.freeze({ type: 'OFF' });

/** Ten exact pass-through sections: the known-good neutral preset. */
export const NEUTRAL_BANDS = Object.freeze(Array.from({ length: BAND_COUNT }, () => OFF));

const GAIN_TYPES = new Set(['PK', 'LS', 'HS']);
const PREAMP_SCALE = 2 ** 23; // Q23
const COEFF_SCALE = 2 ** 27; // Q27
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

// --- Biquad design (RBJ cookbook) -------------------------------------------

/** RBJ peaking EQ. */
export function peak(f, g, q, fs = FS) {
  const A = Math.pow(10, g / 40);
  const w = (2 * Math.PI * f) / fs;
  const al = Math.sin(w) / (2 * q);
  const a0 = 1 + al / A;
  const b0 = (1 + al * A) / a0;
  const b1 = (-2 * Math.cos(w)) / a0;
  const b2 = (1 - al * A) / a0;
  const a1 = b1;
  const a2 = (1 - al / A) / a0;
  return { b0, b1, b2, a1, a2 };
}

/** RBJ low shelf. */
export function lowShelf(f, g, q, fs = FS) {
  const A = Math.pow(10, g / 40);
  const w = (2 * Math.PI * f) / fs;
  const al = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const s = 2 * Math.sqrt(A) * al;
  const a0 = A + 1 + (A - 1) * c + s;
  return {
    b0: (A * (A + 1 - (A - 1) * c + s)) / a0,
    b1: (2 * A * (A - 1 - (A + 1) * c)) / a0,
    b2: (A * (A + 1 - (A - 1) * c - s)) / a0,
    a1: (-2 * (A - 1 + (A + 1) * c)) / a0,
    a2: (A + 1 + (A - 1) * c - s) / a0,
  };
}

/** RBJ high shelf. */
export function highShelf(f, g, q, fs = FS) {
  const A = Math.pow(10, g / 40);
  const w = (2 * Math.PI * f) / fs;
  const al = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const s = 2 * Math.sqrt(A) * al;
  const a0 = A + 1 - (A - 1) * c + s;
  return {
    b0: (A * (A + 1 + (A - 1) * c + s)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * c)) / a0,
    b2: (A * (A + 1 + (A - 1) * c - s)) / a0,
    a1: (2 * (A - 1 - (A + 1) * c)) / a0,
    a2: (A + 1 - (A - 1) * c - s) / a0,
  };
}

/** RBJ 2nd-order low pass. */
export function lowPass(f, q, fs = FS) {
  const w = (2 * Math.PI * f) / fs;
  const c = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  const a0 = 1 + al;
  return {
    b0: ((1 - c) / 2) / a0,
    b1: (1 - c) / a0,
    b2: ((1 - c) / 2) / a0,
    a1: (-2 * c) / a0,
    a2: (1 - al) / a0,
  };
}

/** RBJ 2nd-order high pass. */
export function highPass(f, q, fs = FS) {
  const w = (2 * Math.PI * f) / fs;
  const c = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  const a0 = 1 + al;
  return {
    b0: ((1 + c) / 2) / a0,
    b1: (-(1 + c)) / a0,
    b2: ((1 + c) / 2) / a0,
    a1: (-2 * c) / a0,
    a2: (1 - al) / a0,
  };
}

/**
 * Coeffs for a band `{type, f, g, q}`, normalized by a0. Throws on an unknown
 * type: names such as `LSQ`/`HSQ` (EqualizerAPO, hangout.audio) must be mapped
 * explicitly by the caller, never guessed.
 */
export function coeffs(b, fs = FS) {
  switch (b.type) {
    case 'PK': return peak(b.f, b.g, b.q, fs);
    case 'LS': return lowShelf(b.f, b.g, b.q, fs);
    case 'HS': return highShelf(b.f, b.g, b.q, fs);
    case 'LP': return lowPass(b.f, b.q, fs);
    case 'HP': return highPass(b.f, b.q, fs);
    case 'OFF': return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    default: throw new TypeError(`unknown filter type ${JSON.stringify(b.type)}`);
  }
}

// --- Validation -------------------------------------------------------------

function bandError(i, message) {
  return new RangeError(`band ${i}: ${message}`);
}

/** Rejects bands whose parameters cannot describe a valid filter at FS. */
export function checkBand(b, i = 0) {
  if (b === null || typeof b !== 'object') throw new TypeError(`band ${i}: not an object`);
  if (!FILTER_TYPES.includes(b.type)) {
    throw new TypeError(`band ${i}: unknown filter type ${JSON.stringify(b.type)}`);
  }
  if (b.type === 'OFF') return;
  if (!(Number.isFinite(b.f) && b.f > 0 && b.f < FS / 2)) {
    throw bandError(i, `f must be in (0, ${FS / 2}) Hz, got ${b.f}`);
  }
  if (!(Number.isFinite(b.q) && b.q > 0)) throw bandError(i, `q must be > 0, got ${b.q}`);
  if (GAIN_TYPES.has(b.type) && !Number.isFinite(b.g)) {
    throw bandError(i, `g must be a finite dB value, got ${b.g}`);
  }
}

/** Jury criterion for 1 + a1 z^-1 + a2 z^-2: both poles strictly inside the unit circle. */
export function isStable(a1, a2) {
  return Math.abs(a2) < 1 && Math.abs(a1) < 1 + a2;
}

/**
 * Quantizes one section to its 5 wire words `[b0, b2, -a1, b1, -a2]` (Q27).
 * Stability is checked on the quantized feedback words, which is what the chip
 * will actually run.
 */
export function encodeSection(c, i = 0) {
  const words = [];
  for (const v of [c.b0, c.b2, -c.a1, c.b1, -c.a2]) {
    // `+ 0` turns -0 (from negating a zero a1/a2) into 0.
    const n = Math.round(v * COEFF_SCALE) + 0;
    if (!Number.isInteger(n) || n > INT32_MAX || n < INT32_MIN) {
      throw bandError(i, 'Filter out of the DSP range');
    }
    words.push(n);
  }
  if (!isStable(-words[2] / COEFF_SCALE, -words[4] / COEFF_SCALE)) {
    throw bandError(i, 'unstable section: poles on or outside the unit circle');
  }
  return words;
}

// --- Wire encoding ----------------------------------------------------------

/** Q23 linear-gain word for a preamp in dB. */
export function preampWord(preDb = 0) {
  if (!Number.isFinite(preDb)) throw new RangeError(`preamp must be a finite dB value, got ${preDb}`);
  return Math.round(Math.pow(10, preDb / 20) * PREAMP_SCALE);
}

/** CRC16-CCITT (poly 0x1021, init 0xFFFF, no reflection). */
export function crc16(bytes) {
  let c = 0xffff;
  for (const x of bytes) {
    c ^= x << 8;
    for (let i = 0; i < 8; i++) {
      c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
  }
  return c;
}

function pushI32LE(out, n) {
  if (!Number.isInteger(n) || n > INT32_MAX || n < INT32_MIN) {
    throw new RangeError('Filter out of the DSP range');
  }
  out.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
}

/**
 * Builds the 220-byte blob for 10 bands and a preamp. Bands are written in the
 * order given: keep cuts before boosts (see docs/protocol-0xcb.md), the
 * ordering the reference uses to avoid internal clipping.
 */
export function blob(bands, preDb = 0) {
  if (!Array.isArray(bands) || bands.length !== BAND_COUNT) {
    throw new RangeError(`${BAND_COUNT} bands are required`);
  }
  bands.forEach(checkBand);
  const out = [...HEADER];
  const pre = preampWord(preDb);
  pushI32LE(out, pre);
  bands.forEach((b, i) => {
    const c = coeffs(b);
    for (const n of encodeSection(c, i)) pushI32LE(out, n);
  });
  const crc = crc16(out);
  out.push(crc & 255, crc >> 8);
  return out;
}

/**
 * Splits the blob into the 9 HID reports: byte 0 is the packet index,
 * bytes 1..30 carry 30 bytes of the blob.
 */
export function packets(bands, preDb) {
  const b = blob(bands, preDb);
  const pk = [];
  for (let i = 0; i < PACKET_COUNT; i++) {
    const p = new Uint8Array(PACKET_SIZE);
    p[0] = i;
    const chunk = b.slice(i * 30, i * 30 + 30);
    p.set(chunk, 1);
    pk.push(p);
  }
  return pk;
}

/**
 * The commit packet zero-padded to the 31-byte report size, so every transport
 * sends the same bytes. The reference sends the bare 5 bytes; whether the
 * firmware distinguishes the two is unverified.
 */
export function applyPacket() {
  const p = new Uint8Array(PACKET_SIZE);
  p.set(APPLY);
  return p;
}

/**
 * Magnitude response (dB) of `bands` at frequency `f`, summed across sections.
 * Used for the curve preview.
 */
export function response(bands, f, fs = FS) {
  let db = 0;
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  for (const b of bands) {
    const k = coeffs(b, fs);
    const nr = k.b0 + k.b1 * c1 + k.b2 * c2;
    const ni = -(k.b1 * s1 + k.b2 * s2);
    const dr = 1 + k.a1 * c1 + k.a2 * c2;
    const di = -(k.a1 * s1 + k.a2 * s2);
    db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return db;
}
