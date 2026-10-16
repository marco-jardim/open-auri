import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { crc16Ccitt, encodePayload } from '../../src/dsp/eq0xcb.mjs';
import {
  S1_BYTES,
  S1_KIND_CODES,
  S1_LENGTH,
  S1_VARIANT_PARAMETRIC,
  S1_VERSION,
  S1Error,
  canonKey,
  curveId,
  decodeS1,
  encodeS1,
} from '../../src/share/s1.mjs';

const reference = JSON.parse(
  readFileSync(new URL('../fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);
const PRESETS = reference.presets;
const PADRAO = PRESETS.padrao;
const NEUTRAL = {
  preampDb: -0.5,
  eqBands: Array.from({ length: 10 }, () => ({ kind: 'OFF' })),
};

// Frozen snapshots of S1 v1 (docs/s1-format.md, worked example).
const PADRAO_S1 = 'QABn8AeACW8QRQIvc4I0EPzhksBNe1pEAcCs4SwKzfOEsAIID4UQL5hyJcF2sRA7HLwv';
const PADRAO_HEX =
  '400067f00780096f1045022f73823410fce192c04d7b5a4401c0ace12c0acdf384b002080f85102f' +
  '987225c176b1103b1cbc2f';
const PADRAO_ID = 'mlz36rzp4knt';

const BAND_BITS = 38;
const PREAMP_OFFSET = 4 + 10 * BAND_BITS;

/** @param {number} index */
const bandOffset = (index) => 4 + BAND_BITS * index;

/**
 * @param {() => unknown} fn
 * @param {string} code
 */
function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof S1Error, String(error));
    assert.equal(error.code, code);
    assert.ok(error.message.startsWith(`${code}: `));
    return true;
  });
}

/** @param {string} s1 */
const bytesOf = (s1) => new Uint8Array(Buffer.from(s1, 'base64url'));

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} width
 * @param {number} value
 */
function setBits(bytes, offset, width, value) {
  for (let i = 0; i < width; i++) {
    const bit = offset + i;
    const mask = 0x80 >>> (bit & 7);
    if ((value >>> (width - 1 - i)) & 1) bytes[bit >>> 3] |= mask;
    else bytes[bit >>> 3] &= ~mask;
  }
}

/** Recomputes the CRC so only the intended defect remains. @param {Uint8Array} bytes */
function reseal(bytes) {
  const crc = crc16Ccitt(bytes.subarray(0, 49));
  bytes[49] = crc >>> 8;
  bytes[50] = crc & 0xff;
  return Buffer.from(bytes).toString('base64url');
}

/**
 * @param {string} s1
 * @param {(bytes: Uint8Array) => void} change
 */
function mutate(s1, change) {
  const bytes = bytesOf(s1);
  change(bytes);
  return reseal(bytes);
}

/** Independent RFC 4648 base32 (lowercase, no padding). @param {Uint8Array} bytes */
function base32(bytes) {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let text = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    text += 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(bits.slice(i, i + 5), 2)];
  }
  return text;
}

/** @param {string} s1 */
const expectedId = (s1) => base32(createHash('sha256').update(bytesOf(s1)).digest()).slice(0, 12);

const padraoS1 = () => encodeS1({ bands: PADRAO.eqBands, preampDb: PADRAO.preampDb });

/** @param {number} index @param {object} band */
const padraoWith = (index, band) => ({
  bands: PADRAO.eqBands.map((/** @type {object} */ b, i) => (i === index ? band : b)),
  preampDb: PADRAO.preampDb,
});

// --- Grid arbitraries -----------------------------------------------------------

const freqArb = fc.integer({ min: 1, max: 20000 });
const gainArb = fc.integer({ min: -256, max: 127 }).map((n) => n / 10);
const qArb = fc.integer({ min: 1, max: 2047 }).map((n) => n / 100);
const bandArb = fc.oneof(
  fc.record({
    kind: fc.constantFrom('PK', 'LS', 'HS'),
    freqHz: freqArb,
    gainDb: gainArb,
    qFactor: qArb,
  }),
  fc.record({ kind: fc.constantFrom('LP', 'HP'), freqHz: freqArb, qFactor: qArb }),
  fc.constant({ kind: 'OFF' }),
);
const curveArb = fc.record({
  // fc.record may build null-prototype objects; decoded bands are plain objects.
  bands: fc.array(
    bandArb.map((band) => ({ ...band })),
    { minLength: 10, maxLength: 10 },
  ),
  preampDb: fc.integer({ min: 0, max: 255 }).map((n) => (n === 0 ? 0 : -n / 10)),
});

// --- Round trips ----------------------------------------------------------------

test('the 11 official presets round-trip exactly, with a byte-identical payload', () => {
  const ids = Object.keys(PRESETS);
  assert.equal(ids.length, 11);
  for (const id of ids) {
    const { eqBands, preampDb, payload } = PRESETS[id];
    const s1 = encodeS1({ bands: eqBands, preampDb });
    assert.equal(s1.length, S1_LENGTH, id);
    assert.match(s1, /^[A-Za-z0-9_-]+$/, id);
    assert.equal(bytesOf(s1).length, S1_BYTES, id);
    const decoded = decodeS1(s1);
    assert.deepEqual(
      decoded,
      { version: S1_VERSION, variant: S1_VARIANT_PARAMETRIC, bands: eqBands, preampDb },
      id,
    );
    const before = encodePayload(eqBands, preampDb);
    assert.deepEqual(encodePayload(decoded.bands, decoded.preampDb), before, id);
    assert.deepEqual(before, payload, id);
    assert.equal(encodeS1(decoded), s1, id);
  }
});

test('Neutro (10 x OFF, preamp -0.5 dB) round-trips with a byte-identical payload', () => {
  const s1 = encodeS1({ bands: NEUTRAL.eqBands, preampDb: NEUTRAL.preampDb });
  const decoded = decodeS1(s1);
  assert.deepEqual(decoded.bands, NEUTRAL.eqBands);
  assert.equal(decoded.preampDb, -0.5);
  assert.deepEqual(
    encodePayload(decoded.bands, decoded.preampDb),
    encodePayload(NEUTRAL.eqBands, NEUTRAL.preampDb),
  );
  assert.equal(encodeS1(decoded), s1);
});

test('padrao snapshot: frozen S1 v1 string, bytes and curveId', async () => {
  const s1 = padraoS1();
  assert.equal(s1, PADRAO_S1);
  assert.equal(Buffer.from(bytesOf(s1)).toString('hex'), PADRAO_HEX);
  assert.equal(await curveId(s1), PADRAO_ID);
  assert.equal(s1[0], 'Q'); // version 1, variant 0, first kind PK
});

test('property: every curve on the UI grid round-trips losslessly', () => {
  fc.assert(
    fc.property(curveArb, (curve) => {
      const s1 = encodeS1(curve);
      assert.equal(s1.length, S1_LENGTH);
      const decoded = decodeS1(s1);
      assert.deepEqual(decoded.bands, curve.bands);
      assert.equal(decoded.preampDb, curve.preampDb);
      assert.equal(encodeS1(decoded), s1);
    }),
    { numRuns: 2000 },
  );
});

test('property: any sealed v1 body either decodes canonically or is refused with a code', () => {
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 49, maxLength: 49 }), (body) => {
      const bytes = new Uint8Array(S1_BYTES);
      bytes.set(body);
      setBits(bytes, 0, 4, 0b0100);
      const s1 = reseal(bytes);
      let decoded;
      try {
        decoded = decodeS1(s1);
      } catch (error) {
        assert.ok(error instanceof S1Error);
        assert.ok(['s1:kind', 's1:range', 's1:noncanonical'].includes(error.code), error.code);
        return;
      }
      assert.equal(encodeS1(decoded), s1);
    }),
    { numRuns: 1000 },
  );
});

test('wire order is preserved', () => {
  const reversed = [...PADRAO.eqBands].reverse();
  const s1 = encodeS1({ bands: reversed, preampDb: PADRAO.preampDb });
  assert.notEqual(s1, padraoS1());
  assert.deepEqual(decodeS1(s1).bands, reversed);
});

test('kind codes are frozen in wire order', () => {
  assert.deepEqual([...S1_KIND_CODES], ['PK', 'LS', 'HS', 'LP', 'HP', 'OFF']);
});

// --- Encoding rules -------------------------------------------------------------

test('on-grid floats within 1e-9 map exactly', () => {
  const base = padraoS1();
  const nearly = { kind: 'PK', freqHz: 150, gainDb: -3 + 5e-10, qFactor: 0.1 + 0.59 };
  assert.equal(encodeS1(padraoWith(1, nearly)), base);
  assert.equal(encodeS1({ bands: PADRAO.eqBands, preampDb: -2.8 - 5e-10 }), base);
  const drifted = { kind: 'PK', freqHz: 25 + 1e-10, gainDb: -0.8, qFactor: 0.1 + 0.2 };
  assert.equal(encodeS1(padraoWith(0, drifted)), base);
});

test('off-grid values are refused, never rounded', () => {
  const cases = [
    { kind: 'PK', freqHz: 100.5, gainDb: 0, qFactor: 1 },
    { kind: 'PK', freqHz: 100, gainDb: -2.85, qFactor: 1 },
    { kind: 'PK', freqHz: 100, gainDb: 0, qFactor: 0.695 },
    { kind: 'LP', freqHz: 100, qFactor: 0.7071 },
    { kind: 'HP', freqHz: 100, gainDb: 0.05, qFactor: 0.7 },
  ];
  for (const band of cases) expectCode(() => encodeS1(padraoWith(2, band)), 's1:grid');
  expectCode(() => encodeS1({ bands: PADRAO.eqBands, preampDb: -2.85 }), 's1:grid');
  expectCode(() => canonKey(PADRAO.eqBands, -2.81), 's1:grid');
});

test('out-of-range or non-numeric values are refused', () => {
  const cases = [
    { kind: 'PK', freqHz: 0, gainDb: 0, qFactor: 1 },
    { kind: 'PK', freqHz: 20001, gainDb: 0, qFactor: 1 },
    { kind: 'PK', freqHz: 100, gainDb: 12.8, qFactor: 1 },
    { kind: 'PK', freqHz: 100, gainDb: -25.7, qFactor: 1 },
    { kind: 'PK', freqHz: 100, gainDb: 0, qFactor: 0 },
    { kind: 'PK', freqHz: 100, gainDb: 0, qFactor: 20.48 },
    { kind: 'PK', freqHz: Number.NaN, gainDb: 0, qFactor: 1 },
    { kind: 'PK', freqHz: 100, gainDb: Infinity, qFactor: 1 },
    { kind: 'PK', freqHz: 100, gainDb: '3', qFactor: 1 },
    { kind: 'LS', freqHz: 100, qFactor: 1 },
    { kind: 'LP', freqHz: 100, gainDb: 1, qFactor: 0.7 },
  ];
  for (const band of cases) expectCode(() => encodeS1(padraoWith(4, band)), 's1:range');
  for (const preampDb of [0.1, -25.6, Number.NaN, undefined]) {
    expectCode(() => encodeS1({ bands: PADRAO.eqBands, preampDb }), 's1:range');
  }
  // Extremes of the grid are accepted.
  const extremes = [
    { kind: 'PK', freqHz: 1, gainDb: -25.6, qFactor: 0.01 },
    { kind: 'HS', freqHz: 20000, gainDb: 12.7, qFactor: 20.47 },
  ];
  const s1 = encodeS1({ bands: [...extremes, ...PADRAO.eqBands.slice(2)], preampDb: -25.5 });
  assert.deepEqual(decodeS1(s1).bands.slice(0, 2), extremes);
  assert.equal(decodeS1(s1).preampDb, -25.5);
});

test('exactly 10 bands and known kinds are required', () => {
  expectCode(() => encodeS1({ bands: PADRAO.eqBands.slice(0, 9), preampDb: 0 }), 's1:bands');
  expectCode(
    () => encodeS1({ bands: [...PADRAO.eqBands, { kind: 'OFF' }], preampDb: 0 }),
    's1:bands',
  );
  expectCode(() => encodeS1({ bands: 'x', preampDb: 0 }), 's1:bands');
  expectCode(() => encodeS1(null), 's1:bands');
  expectCode(() => canonKey(PADRAO.eqBands.slice(1), 0), 's1:bands');
  expectCode(() => encodeS1(padraoWith(0, { kind: 'LSQ', freqHz: 100, qFactor: 1 })), 's1:kind');
  expectCode(() => encodeS1(padraoWith(0, { freqHz: 100 })), 's1:kind');
  expectCode(() => encodeS1(padraoWith(0, null)), 's1:kind');
});

test('LP/HP carry no gain: absent and 0 encode the same and decode without gainDb', () => {
  const absent = { kind: 'LP', freqHz: 18000, qFactor: 0.71 };
  const zero = { kind: 'LP', freqHz: 18000, gainDb: 0, qFactor: 0.71 };
  const s1 = encodeS1(padraoWith(9, absent));
  assert.equal(encodeS1(padraoWith(9, zero)), s1);
  const decoded = decodeS1(s1);
  assert.deepEqual(decoded.bands[9], absent);
  assert.deepEqual(
    encodePayload(decoded.bands, decoded.preampDb),
    encodePayload(padraoWith(9, zero).bands, PADRAO.preampDb),
  );
});

test('OFF bands encode their unused fields as zero (one curve, one string)', () => {
  const plain = encodeS1(padraoWith(3, { kind: 'OFF' }));
  const stray = { kind: 'OFF', freqHz: 1000, gainDb: 3, qFactor: 1 };
  assert.equal(encodeS1(padraoWith(3, stray)), plain);
  const bytes = bytesOf(plain);
  const offset = bandOffset(3);
  for (let bit = offset + 3; bit < offset + BAND_BITS; bit++) {
    assert.equal((bytes[bit >>> 3] >>> (7 - (bit & 7))) & 1, 0);
  }
  assert.deepEqual(decodeS1(plain).bands[3], { kind: 'OFF' });
});

// --- Decoding errors ------------------------------------------------------------

test('decode refuses unknown versions and variants', () => {
  const s1 = padraoS1();
  for (const version of [0, 2, 3]) {
    const other = mutate(s1, (bytes) => setBits(bytes, 0, 2, version));
    expectCode(() => decodeS1(other), 's1:version');
    expectCode(() => decodeS1(other.slice(0, 20)), 's1:version');
  }
  for (const variant of [1, 2, 3]) {
    expectCode(() => decodeS1(mutate(s1, (bytes) => setBits(bytes, 2, 2, variant))), 's1:variant');
  }
});

test('decode refuses a bad CRC', () => {
  const s1 = padraoS1();
  const bytes = bytesOf(s1);
  bytes[50] ^= 1;
  expectCode(() => decodeS1(Buffer.from(bytes).toString('base64url')), 's1:crc');
  const body = bytesOf(s1);
  body[20] ^= 0x10;
  expectCode(() => decodeS1(Buffer.from(body).toString('base64url')), 's1:crc');
  const swapped = s1.slice(0, 30) + (s1[30] === 'A' ? 'B' : 'A') + s1.slice(31);
  expectCode(() => decodeS1(swapped), 's1:crc');
});

test('decode refuses truncated or extended strings', () => {
  const s1 = padraoS1();
  expectCode(() => decodeS1(''), 's1:length');
  expectCode(() => decodeS1(s1.slice(0, 67)), 's1:length');
  expectCode(() => decodeS1(s1.slice(0, 64)), 's1:length');
  expectCode(() => decodeS1(`${s1}A`), 's1:length');
  expectCode(() => decodeS1(s1 + s1.slice(0, 4)), 's1:length');
});

test('decode refuses characters outside base64url, including padding', () => {
  const s1 = padraoS1();
  for (const bad of ['+', '/', ' ', '=', '.', 'é']) {
    expectCode(() => decodeS1(s1.slice(0, 10) + bad + s1.slice(11)), 's1:charset');
  }
  expectCode(() => decodeS1(`${s1}=`), 's1:charset');
  expectCode(() => decodeS1(`${s1.slice(0, 66)}==`), 's1:charset');
  expectCode(() => decodeS1(123), 's1:charset');
  expectCode(() => decodeS1(null), 's1:charset');
});

test('decode refuses invalid kind codes', () => {
  for (const code of [6, 7]) {
    const s1 = mutate(padraoS1(), (bytes) => setBits(bytes, bandOffset(3), 3, code));
    expectCode(() => decodeS1(s1), 's1:kind');
  }
});

test('decode refuses fields outside the ranges', () => {
  const s1 = padraoS1();
  /** @type {Array<[number, number, number]>} */
  const cases = [
    [3, 15, 0], // freq 0
    [3, 15, 20001],
    [3, 15, 32767],
    [18, 9, 128], // gain +12.8
    [18, 9, 255],
    [27, 11, 0], // Q 0
  ];
  for (const [field, width, value] of cases) {
    const bad = mutate(s1, (bytes) => setBits(bytes, bandOffset(5) + field, width, value));
    expectCode(() => decodeS1(bad), 's1:range');
  }
});

test('decode refuses non-canonical OFF and LP/HP fields', () => {
  const off = encodeS1(padraoWith(6, { kind: 'OFF' }));
  for (const [field, width] of [
    [3, 15],
    [18, 9],
    [27, 11],
  ]) {
    const bad = mutate(off, (bytes) => setBits(bytes, bandOffset(6) + field, width, 1));
    expectCode(() => decodeS1(bad), 's1:noncanonical');
  }
  const hp = encodeS1(padraoWith(6, { kind: 'HP', freqHz: 20, qFactor: 0.5 }));
  const bad = mutate(hp, (bytes) => setBits(bytes, bandOffset(6) + 18, 9, 0x1ff));
  expectCode(() => decodeS1(bad), 's1:noncanonical');
});

test('preamp field covers 0 to -25.5 dB', () => {
  const s1 = mutate(padraoS1(), (bytes) => setBits(bytes, PREAMP_OFFSET, 8, 0));
  assert.ok(Object.is(decodeS1(s1).preampDb, 0));
  const deep = mutate(padraoS1(), (bytes) => setBits(bytes, PREAMP_OFFSET, 8, 255));
  assert.equal(decodeS1(deep).preampDb, -25.5);
});

// --- canonKey -------------------------------------------------------------------

test('canonKey is equal for every permutation of the same bands', () => {
  fc.assert(
    fc.property(
      curveArb,
      fc.shuffledSubarray([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { minLength: 10, maxLength: 10 }),
      (curve, order) => {
        const permuted = order.map((i) => curve.bands[i]);
        assert.equal(canonKey(permuted, curve.preampDb), canonKey(curve.bands, curve.preampDb));
      },
    ),
    { numRuns: 1000 },
  );
});

test('canonKey format, OFF normalization and tie-breaking', () => {
  const bands = [
    { kind: 'OFF', freqHz: 5 },
    { kind: 'PK', freqHz: 100, gainDb: 2, qFactor: 1 },
    { kind: 'PK', freqHz: 100, gainDb: -2, qFactor: 1 },
    { kind: 'LS', freqHz: 100, gainDb: 1, qFactor: 0.7 },
    { kind: 'PK', freqHz: 100, gainDb: 0, qFactor: 0.5 },
    { kind: 'HP', freqHz: 20, gainDb: 0, qFactor: 0.71 },
    { kind: 'OFF' },
    { kind: 'PK', freqHz: 50, gainDb: -1, qFactor: 2 },
    { kind: 'OFF' },
    { kind: 'LP', freqHz: 18000, qFactor: 0.71 },
  ];
  assert.equal(
    canonKey(bands, -3),
    'v1;-30;HP,20,0,71;PK,50,-10,200;PK,100,0,50;PK,100,-20,100;PK,100,20,100;' +
      'LS,100,10,70;LP,18000,0,71;OFF;OFF;OFF',
  );
  assert.equal(canonKey(NEUTRAL.eqBands, 0), 'v1;0;OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF');
  const reversed = [...PADRAO.eqBands].reverse();
  assert.equal(canonKey(reversed, PADRAO.preampDb), canonKey(PADRAO.eqBands, PADRAO.preampDb));
  assert.notEqual(canonKey(PADRAO.eqBands, -2.9), canonKey(PADRAO.eqBands, PADRAO.preampDb));
});

// --- curveId --------------------------------------------------------------------

test('curveId is SHA-256 of the S1 bytes in base32, 12 chars, and order-sensitive', async () => {
  const s1 = padraoS1();
  const id = await curveId(s1);
  assert.match(id, /^[a-z2-7]{12}$/);
  assert.equal(await curveId(s1), id);
  assert.equal(id, expectedId(s1));
  const reversed = encodeS1({ bands: [...PADRAO.eqBands].reverse(), preampDb: PADRAO.preampDb });
  assert.notEqual(await curveId(reversed), id);
  for (const preset of Object.values(PRESETS)) {
    const other = encodeS1({ bands: preset.eqBands, preampDb: preset.preampDb });
    assert.equal(await curveId(other), expectedId(other));
  }
});

test('curveId validates its input', async () => {
  await assert.rejects(curveId('not s1!'), (error) => {
    assert.ok(error instanceof S1Error);
    assert.equal(error.code, 's1:charset');
    return true;
  });
  await assert.rejects(curveId(padraoS1().slice(1)), S1Error);
});
