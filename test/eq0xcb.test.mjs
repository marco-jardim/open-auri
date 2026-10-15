import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as eq from '../src/dsp/eq0xcb.mjs';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);
const ids = Object.keys(fixture.presets);

const PK = (f, g, q) => ({ type: 'PK', f, g, q });
const withNeutral = (band) => [band, ...eq.NEUTRAL_BANDS.slice(1)];
const db = (x) => 20 * Math.log10(Math.abs(x));
const dcGain = (c) => db((c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2));
const nyquistGain = (c) => db((c.b0 - c.b1 + c.b2) / (1 - c.a1 + c.a2));
const MINUS_3DB = 20 * Math.log10(Math.SQRT1_2);

// --- Independent checks (do not derive from the reference) -------------------

// CRC-16/CCITT-FALSE check value for "123456789" is 0x29B1 (CRC catalogue).
test('crc16-ccitt matches the published check value', () => {
  const bytes = [...'123456789'].map((c) => c.charCodeAt(0));
  assert.equal(eq.crc16(bytes), 0x29b1);
});

test('preamp 0 dB encodes 1.0 in Q23', () => {
  assert.equal(eq.preampWord(0), 1 << 23);
  assert.equal(eq.preampWord(), 1 << 23);
});

// RBJ cookbook properties, from the filter definitions themselves.
test('RBJ peaking: gain at f0 equals g', () => {
  for (const [f, g, q] of [[1000, 6, 1], [100, -9, 2], [8000, 3, 0.7], [40, -12, 4]]) {
    assert.ok(Math.abs(eq.response([PK(f, g, q)], f) - g) < 1e-9, `PK ${f} ${g} ${q}`);
  }
});

test('RBJ peaking with g = 0 has coinciding zeros and poles', () => {
  const c = eq.peak(1000, 0, 1);
  assert.equal(c.b0, 1);
  assert.equal(c.b1, c.a1);
  assert.equal(c.b2, c.a2);
});

test('RBJ low shelf: DC gain is g, Nyquist gain is 0 dB', () => {
  const c = eq.lowShelf(100, 6, 0.7);
  assert.ok(Math.abs(dcGain(c) - 6) < 1e-6);
  assert.ok(Math.abs(nyquistGain(c)) < 1e-9);
});

test('RBJ high shelf: Nyquist gain is g, DC gain is 0 dB', () => {
  const c = eq.highShelf(8000, -4, 0.7);
  assert.ok(Math.abs(nyquistGain(c) + 4) < 1e-9);
  assert.ok(Math.abs(dcGain(c)) < 1e-6);
});

test('RBJ low/high pass: unity in the passband, -3.01 dB at f0 for Q = 1/sqrt(2)', () => {
  const lp = { type: 'LP', f: 1000, q: Math.SQRT1_2 };
  const hp = { type: 'HP', f: 1000, q: Math.SQRT1_2 };
  assert.ok(Math.abs(dcGain(eq.coeffs(lp))) < 1e-6);
  assert.ok(Math.abs(nyquistGain(eq.coeffs(hp))) < 1e-9);
  assert.ok(Math.abs(eq.response([lp], 1000) - MINUS_3DB) < 1e-9);
  assert.ok(Math.abs(eq.response([hp], 1000) - MINUS_3DB) < 1e-9);
});

// --- Reference equivalence ------------------------------------------------------

test('constants match the reference', () => {
  assert.deepEqual(eq.HEADER, fixture.constants.HEADER);
  assert.deepEqual(eq.APPLY, fixture.constants.APPLY);
  assert.equal(eq.REPORT_ID, fixture.constants.REPORT_ID);
  assert.equal(eq.FS, fixture.constants.FS);
  assert.equal(eq.VENDOR_ID, fixture.constants.VENDOR_ID);
  assert.equal(eq.PRODUCT_ID, fixture.constants.PRODUCT_ID);
});

test('fixture covers every Auri preset', () => {
  assert.ok(ids.length >= 11, `expected >= 11 presets, got ${ids.length}`);
});

for (const id of ids) {
  const ref = fixture.presets[id];

  test(`blob matches reference: ${id}`, () => {
    assert.equal(ref.blob.length, eq.BLOB_SIZE);
    assert.deepEqual(eq.blob(ref.bands, ref.pre), ref.blob);
  });

  test(`packets match reference: ${id}`, () => {
    const got = eq.packets(ref.bands, ref.pre).map((p) => Array.from(p));
    assert.deepEqual(got, ref.packets);
  });
}

// --- Structure --------------------------------------------------------------------

test('packet framing: 9 reports of 31 bytes with the index in byte 0', () => {
  const { bands } = fixture.presets[ids[0]];
  const pk = eq.packets(bands, -3);
  assert.equal(pk.length, 9);
  pk.forEach((p, i) => {
    assert.equal(p.length, 31);
    assert.equal(p[0], i);
  });
});

test('header bytes 4..5 are a u16 LE length of everything after them', () => {
  const b = eq.blob(fixture.presets.padrao.bands, fixture.presets.padrao.pre);
  assert.equal(b[4] | (b[5] << 8), b.length - 6);
});

test('applyPacket is the reference commit zero-padded to 31 bytes', () => {
  const p = eq.applyPacket();
  assert.equal(p.length, eq.PACKET_SIZE);
  assert.deepEqual(Array.from(p.slice(0, eq.APPLY.length)), [...eq.APPLY]);
  assert.ok(p.slice(eq.APPLY.length).every((x) => x === 0));
});

test('exported constants cannot be mutated', () => {
  assert.throws(() => eq.HEADER.push(0), TypeError);
  assert.throws(() => { eq.APPLY[0] = 0; }, TypeError);
  assert.ok(Object.isFrozen(eq.NEUTRAL_BANDS));
});

// --- Neutral / pass-through -------------------------------------------------------

test('OFF encodes the exact identity section', () => {
  assert.deepEqual(eq.encodeSection(eq.coeffs(eq.OFF)), [2 ** 27, 0, 0, 0, 0]);
});

test('neutral preset: ten identity sections and a flat response', () => {
  const b = eq.blob(eq.NEUTRAL_BANDS, 0);
  for (let k = 0; k < eq.BAND_COUNT; k++) {
    const sec = b.slice(18 + k * 20, 38 + k * 20);
    assert.deepEqual(sec, [0, 0, 0, 8, ...new Array(16).fill(0)]);
  }
  assert.equal(eq.response(eq.NEUTRAL_BANDS, 1000), 0);
});

// --- Validation: nothing harmful may reach the flash ----------------------------------

test('blob rejects a band count other than 10', () => {
  assert.throws(() => eq.blob([], 0), /bands are required/);
  assert.throws(() => eq.blob(null, 0), /bands are required/);
});

for (const [label, band] of [
  ['q = 0 (would encode a silent section)', PK(1000, 6, 0)],
  ['q < 0 (would encode an unstable section)', PK(1000, 6, -1)],
  ['f = NaN (would encode a silent section)', PK(NaN, 6, 1)],
  ['f = 0', PK(0, 6, 1)],
  ['f at Nyquist', PK(48000, 6, 1)],
  ['f above Nyquist (would encode an unstable section)', PK(60000, 6, 1)],
  ['g = NaN', PK(1000, NaN, 1)],
  ['g = Infinity', PK(1000, Infinity, 1)],
]) {
  test(`blob rejects ${label}`, () => {
    assert.throws(() => eq.blob(withNeutral(band), 0), RangeError);
  });
}

test('blob rejects unknown or missing filter types instead of guessing', () => {
  assert.throws(() => eq.blob(withNeutral({ type: 'LSQ', f: 100, g: 6, q: 0.7 }), 0), TypeError);
  assert.throws(() => eq.blob(withNeutral({ f: 100, g: 6, q: 0.7 }), 0), TypeError);
  assert.throws(() => eq.blob(withNeutral(null), 0), TypeError);
  assert.throws(() => eq.response([{ type: 'HSQ', f: 8000, g: 3, q: 0.7 }], 1000), TypeError);
});

test('blob rejects a non-finite preamp', () => {
  assert.throws(() => eq.blob(eq.NEUTRAL_BANDS, NaN), RangeError);
  assert.throws(() => eq.blob(eq.NEUTRAL_BANDS, Infinity), RangeError);
});

test('blob rejects coefficients outside int32 (Q27)', () => {
  assert.throws(() => eq.blob(withNeutral(PK(20000, 40, 0.1)), 0), /out of the DSP range/);
});

test('isStable implements the Jury criterion', () => {
  assert.equal(eq.isStable(-1.9, 0.95), true);
  assert.equal(eq.isStable(0, 1), false);
  assert.equal(eq.isStable(-2.1, 0.5), false);
});

test('stability is checked on the quantized coefficients, not the ideal ones', () => {
  const nearlyMarginal = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 1 - 1e-12 };
  assert.equal(eq.isStable(nearlyMarginal.a1, nearlyMarginal.a2), true);
  assert.throws(() => eq.encodeSection(nearlyMarginal), /unstable/);
});
