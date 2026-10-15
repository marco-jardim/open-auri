// 0xCB wire format — open implementation.
//
// Reconstructed from a working implementation of the Kuba equalizer page.
// Spec: ../../docs/protocol-0xcb.md
//
// This module is pure (no DOM, no HID), so it runs identically in Node and in
// the browser. The HID transport lives elsewhere; here we only build the bytes.

export const VENDOR_ID = 0x3302;
export const PRODUCT_ID = 0x8902;
export const REPORT_ID = 0xcb;

/** DSP sample rate the coefficients are designed for. */
export const FS = 96000;

/** Number of biquad sections the firmware stores. */
export const BAND_COUNT = 10;

/** Fixed 14-byte prologue (ASCII "EQ1#" followed by 10 bytes). */
export const HEADER = [
  0x45, 0x51, 0x31, 0x23, 0xd6, 0x00, 0x00, 0x0a, 0x04, 0x05, 0x01, 0x0a, 0x00, 0x00,
];

/** Commit packet: persists the preset to the chip's flash. */
export const APPLY = [0x01, 0x65, 0x00, 0x01, 0xff];

/** Blob size in bytes: 14 header + 4 preamp + 10*5*4 coefficients + 2 CRC. */
export const BLOB_SIZE = 220;

export const PACKET_SIZE = 31;
export const PACKET_COUNT = 9;

const PREAMP_SCALE = 2 ** 23; // Q23
const COEFF_SCALE = 2 ** 27; // Q27
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

// --- Biquad design (RBJ cookbook) -------------------------------------------

function omega(f, fs) {
  return (2 * Math.PI * f) / fs;
}

/** RBJ peaking EQ. */
export function peak(f, g, q, fs = FS) {
  const A = Math.pow(10, g / 40);
  const w = omega(f, fs);
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
  const w = omega(f, fs);
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
  const w = omega(f, fs);
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
  const w = omega(f, fs);
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
  const w = omega(f, fs);
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

/** Coeffs for a band `{type, f, g, q}`. Returns `{b0,b1,b2,a1,a2}` normalized by a0. */
export function coeffs(band, fs = FS) {
  if (band.type === 'LS') return lowShelf(band.f, band.g, band.q, fs);
  if (band.type === 'HS') return highShelf(band.f, band.g, band.q, fs);
  if (band.type === 'LP') return lowPass(band.f, band.q, fs);
  if (band.type === 'HP') return highPass(band.f, band.q, fs);
  return peak(band.f, band.g, band.q, fs);
}

// --- Wire encoding ----------------------------------------------------------

/** Q23 linear-gain word for a preamp in dB. */
export function preampWord(preDb) {
  return Math.round(Math.pow(10, (preDb || 0) / 20) * PREAMP_SCALE);
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
  if (n > INT32_MAX || n < INT32_MIN) throw new Error('Filter out of the DSP range');
  out.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
}

/**
 * Builds the 220-byte blob for 10 bands and a preamp.
 * Band coefficient order on the wire: `[b0, b2, -a1, b1, -a2]`, each int32 LE in Q27.
 */
export function blob(bands, preDb) {
  if (bands.length !== BAND_COUNT) throw new Error(`${BAND_COUNT} bands are required`);
  const out = [...HEADER];
  pushI32LE(out, preampWord(preDb));
  for (const band of bands) {
    const c = coeffs(band);
    for (const v of [c.b0, c.b2, -c.a1, c.b1, -c.a2]) {
      pushI32LE(out, Math.round(v * COEFF_SCALE));
    }
  }
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
  const out = [];
  for (let i = 0; i < PACKET_COUNT; i++) {
    const p = new Uint8Array(PACKET_SIZE);
    p[0] = i;
    p.set(b.slice(i * 30, i * 30 + 30), 1);
    out.push(p);
  }
  return out;
}

/**
 * Magnitude response (dB) of `bands` at frequency `f`, summed across sections.
 * Mirrors docs/protocol-0xcb.md; used for the curve preview.
 */
export function response(bands, f, fs = FS) {
  let db = 0;
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  for (const band of bands) {
    const k = coeffs(band, fs);
    const nr = k.b0 + k.b1 * c1 + k.b2 * c2;
    const ni = -(k.b1 * s1 + k.b2 * s2);
    const dr = 1 + k.a1 * c1 + k.a2 * c2;
    const di = -(k.a1 * s1 + k.a2 * s2);
    db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return db;
}
