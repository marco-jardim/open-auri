import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { crc16Ccitt, encodePayload } from '../../src/dsp/eq0xcb.mjs';
import {
  S1_BYTES,
  S1_FREQ_MAX,
  S1_KIND_CODES,
  S1_LENGTH,
  S1_VARIANT_PARAMETRIC,
  S1_VERSION,
  S1_VERSIONS,
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

// Frozen snapshots of S1 v2 (docs/s1-format.md, "padrao com um corte a 25 kHz"):
// padrao with band 6 replaced by a PK cut at 25 kHz, -3 dB, Q 1.
const PADRAO_V2_BAND = Object.freeze({ kind: 'PK', freqHz: 25000, gainDb: -3, qFactor: 1 });
const PADRAO_V2_S1 = 'gABn8AeACW8QRQIvc4I0EPzhksBNe1pEAcCs4SwYajxBkAIID4UQL5hyJcF2sRA7HHGI';
const PADRAO_V2_HEX =
  '800067f00780096f1045022f73823410fce192c04d7b5a4401c0ace12c186a3c419002080f85102f' +
  '987225c176b1103b1c7188';
const PADRAO_V2_ID = '2sa7worwmkel';
const PADRAO_V2_KEY =
  'v2;-28;PK,25,-8,30;PK,150,-30,69;PK,520,31,81;PK,2237,-100,141;PK,3046,57,151;' +
  'PK,4348,-61,300;PK,4958,-83,272;PK,5995,34,59;PK,7178,-100,300;PK,25000,-30,100';

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

// Kind codes as docs/s1-format.md lists them (independent of S1_KIND_CODES).
const WIRE_KINDS = ['PK', 'LS', 'HS', 'LP', 'HP', 'OFF'];

/**
 * Independent packer of the frozen bit layout (docs/s1-format.md), for byte-identity
 * checks: the version field, then each band and the preamp at their documented
 * offsets, then the CRC. Takes a curve on the grid.
 * @param {1 | 2} version
 * @param {{bands: Array<Record<string, any>>, preampDb: number}} curve
 */
function referenceS1(version, curve) {
  const bytes = new Uint8Array(S1_BYTES);
  setBits(bytes, 0, 2, version);
  setBits(bytes, 2, 2, 0);
  curve.bands.forEach((band, index) => {
    const offset = bandOffset(index);
    setBits(bytes, offset, 3, WIRE_KINDS.indexOf(band.kind));
    if (band.kind === 'OFF') return;
    setBits(bytes, offset + 3, 15, band.freqHz);
    setBits(bytes, offset + 18, 9, Math.round((band.gainDb ?? 0) * 10) & 0x1ff);
    setBits(bytes, offset + 27, 11, Math.round(band.qFactor * 100));
  });
  setBits(bytes, PREAMP_OFFSET, 8, Math.round(-curve.preampDb * 10));
  return reseal(bytes);
}

const padraoS1 = () => encodeS1({ bands: PADRAO.eqBands, preampDb: PADRAO.preampDb });

/** @param {number} index @param {object} band */
const padraoWith = (index, band) => ({
  bands: PADRAO.eqBands.map((/** @type {object} */ b, i) => (i === index ? band : b)),
  preampDb: PADRAO.preampDb,
});

/** The v2 golden curve: padrao with band 6 at 25 kHz. */
const padraoV2 = () => padraoWith(6, { ...PADRAO_V2_BAND });

// --- Grid arbitraries -----------------------------------------------------------

const freqArb = fc.integer({ min: 1, max: 20000 });
const freqV2Arb = fc.integer({ min: 1, max: 32000 });
const ultrasonicArb = fc.integer({ min: 20001, max: 32000 });
const gainArb = fc.integer({ min: -256, max: 127 }).map((n) => n / 10);
const qArb = fc.integer({ min: 1, max: 2047 }).map((n) => n / 100);
const preampArb = fc.integer({ min: 0, max: 255 }).map((n) => (n === 0 ? 0 : -n / 10));
/**
 * Bands on the grid with frequencies from `freq`; OFF unless `off` is false.
 * fc.record may build null-prototype objects; decoded bands are plain objects.
 * @param {fc.Arbitrary<number>} freq
 * @param {boolean} [off]
 */
const bandArbOf = (freq, off = true) =>
  fc
    .oneof(
      fc.record({
        kind: fc.constantFrom('PK', 'LS', 'HS'),
        freqHz: freq,
        gainDb: gainArb,
        qFactor: qArb,
      }),
      fc.record({ kind: fc.constantFrom('LP', 'HP'), freqHz: freq, qFactor: qArb }),
      ...(off ? [fc.constant({ kind: 'OFF' })] : []),
    )
    .map((band) => ({ ...band }));
const bandArb = bandArbOf(freqArb);
const curveArb = fc.record({
  bands: fc.array(bandArb, { minLength: 10, maxLength: 10 }),
  preampDb: preampArb,
});
// S1 v2 curves: bands up to 32 kHz, at least one non-OFF band above 20 kHz.
const curveV2Arb = fc
  .record({
    bands: fc.array(bandArbOf(freqV2Arb), { minLength: 10, maxLength: 10 }),
    preampDb: preampArb,
    at: fc.integer({ min: 0, max: 9 }),
    ultrasonic: bandArbOf(ultrasonicArb, false),
  })
  .map(({ bands, preampDb, at, ultrasonic }) => ({
    bands: bands.map((band, index) => (index === at ? ultrasonic : band)),
    preampDb,
  }));

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
  assert.equal(s1, referenceS1(1, { bands: PADRAO.eqBands, preampDb: PADRAO.preampDb }));
});

test('S1 versions: readers accept 1 and 2; S1_VERSION stays 1; one length for both', () => {
  assert.equal(S1_VERSION, 1);
  assert.deepEqual([...S1_VERSIONS], [1, 2]);
  assert.deepEqual({ ...S1_FREQ_MAX }, { 1: 20000, 2: 32000 });
  assert.ok(Object.isFrozen(S1_VERSIONS));
  assert.ok(Object.isFrozen(S1_FREQ_MAX));
  assert.equal(S1_BYTES, 51);
  assert.equal(S1_LENGTH, 68);
});

test('padrao v2 snapshot: frozen S1 v2 string, bytes, curveId and v2; canonKey', async () => {
  const curve = padraoV2();
  const s1 = encodeS1(curve);
  assert.equal(s1, PADRAO_V2_S1);
  assert.equal(s1.length, S1_LENGTH);
  assert.equal(Buffer.from(bytesOf(s1)).toString('hex'), PADRAO_V2_HEX);
  assert.equal(s1, referenceS1(2, curve));
  assert.equal(await curveId(s1), PADRAO_V2_ID);
  assert.equal(expectedId(s1), PADRAO_V2_ID);
  assert.equal(canonKey(curve.bands, curve.preampDb), PADRAO_V2_KEY);
  assert.equal(s1[0], 'g'); // version 2, variant 0, first kind PK
  const decoded = decodeS1(s1);
  assert.deepEqual(decoded, {
    version: 2,
    variant: S1_VARIANT_PARAMETRIC,
    bands: curve.bands,
    preampDb: curve.preampDb,
  });
  assert.equal(encodeS1(decoded), s1);
  // Against padrao v1: only the version field, band 6 (bytes 29 to 33) and the CRC.
  const v1 = bytesOf(PADRAO_S1);
  const v2 = bytesOf(s1);
  const changed = [...v2.keys()].filter((index) => v1[index] !== v2[index]);
  assert.deepEqual(changed, [0, 29, 30, 31, 32, 33, 49, 50]);
});

test('the version follows the bands: 20000 Hz stays v1, 20001 Hz makes v2', () => {
  /** @param {number} freqHz */
  const at = (freqHz) => padraoWith(6, { kind: 'PK', freqHz, gainDb: -3, qFactor: 1 });
  const edge = encodeS1(at(20000));
  assert.equal(edge[0], 'Q');
  assert.equal(decodeS1(edge).version, 1);
  assert.ok(canonKey(at(20000).bands, PADRAO.preampDb).startsWith('v1;'));
  const above = encodeS1(at(20001));
  assert.equal(above[0], 'g');
  assert.equal(decodeS1(above).version, 2);
  assert.deepEqual(decodeS1(above).bands, at(20001).bands);
  assert.ok(canonKey(at(20001).bands, PADRAO.preampDb).startsWith('v2;'));
  // An LP or HP band counts like any other non-OFF band.
  const pass = padraoWith(9, { kind: 'LP', freqHz: 24000, qFactor: 0.71 });
  assert.equal(decodeS1(encodeS1(pass)).version, 2);
  // OFF bands never count, whatever stray fields they hold.
  const stray = padraoWith(6, { kind: 'OFF', freqHz: 25000, gainDb: 0, qFactor: 1 });
  assert.equal(encodeS1(stray)[0], 'Q');
  assert.equal(decodeS1(encodeS1(stray)).version, 1);
  assert.ok(canonKey(stray.bands, PADRAO.preampDb).startsWith('v1;'));
});

test('property: every v1-grid curve encodes byte-identically to the frozen v1 layout (Q–T)', () => {
  fc.assert(
    fc.property(curveArb, (curve) => {
      const s1 = encodeS1(curve);
      assert.equal(s1, referenceS1(1, curve));
      assert.match(s1, /^[Q-T]/);
      assert.equal(decodeS1(s1).version, 1);
      assert.ok(canonKey(curve.bands, curve.preampDb).startsWith('v1;'));
    }),
    { numRuns: 2000 },
  );
});

test('property: every v2 curve (a band above 20 kHz) round-trips as v2, first character g–i', () => {
  fc.assert(
    fc.property(curveV2Arb, (curve) => {
      const s1 = encodeS1(curve);
      assert.equal(s1.length, S1_LENGTH);
      assert.equal(s1, referenceS1(2, curve));
      assert.match(s1, /^[ghi]/);
      const decoded = decodeS1(s1);
      assert.equal(decoded.version, 2);
      assert.deepEqual(decoded.bands, curve.bands);
      assert.equal(decoded.preampDb, curve.preampDb);
      assert.equal(encodeS1(decoded), s1);
      assert.ok(canonKey(curve.bands, curve.preampDb).startsWith('v2;'));
    }),
    { numRuns: 2000 },
  );
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

test('property: any sealed v2 body either decodes canonically as v2 or is refused with a code', () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 49, maxLength: 49 }),
      fc.boolean(),
      (body, withGoldenBands) => {
        const bytes = new Uint8Array(S1_BYTES);
        bytes.set(body);
        if (withGoldenBands) {
          // Keep the golden bands and randomize only the preamp, so some bodies decode.
          bytes.set(bytesOf(PADRAO_V2_S1).subarray(0, 48));
        }
        setBits(bytes, 0, 4, 0b1000);
        const s1 = reseal(bytes);
        let decoded;
        try {
          decoded = decodeS1(s1);
        } catch (error) {
          assert.ok(error instanceof S1Error);
          assert.ok(['s1:kind', 's1:range', 's1:noncanonical'].includes(error.code), error.code);
          return;
        }
        assert.equal(decoded.version, 2);
        assert.ok(decoded.bands.some((band) => band.kind !== 'OFF' && band.freqHz > 20000));
        assert.equal(encodeS1(decoded), s1);
      },
    ),
    { numRuns: 1000 },
  );
});

test('wire order is preserved', () => {
  const reversed = [...PADRAO.eqBands].reverse();
  const s1 = encodeS1({ bands: reversed, preampDb: PADRAO.preampDb });
  assert.notEqual(s1, padraoS1());
  assert.deepEqual(decodeS1(s1).bands, reversed);
});

test('kind codes are frozen in wire order and valid first characters are Q, R or S', () => {
  assert.deepEqual([...S1_KIND_CODES], ['PK', 'LS', 'HS', 'LP', 'HP', 'OFF']);
  for (const [index, kind] of S1_KIND_CODES.entries()) {
    const band = kind === 'OFF' ? { kind } : { kind, freqHz: 100, gainDb: 0, qFactor: 1 };
    assert.equal(encodeS1(padraoWith(0, band))[0], ['Q', 'Q', 'R', 'R', 'S', 'S'][index]);
  }
});

test('valid S1 v2 first characters are g, h or i', () => {
  for (const [index, kind] of S1_KIND_CODES.entries()) {
    const band = kind === 'OFF' ? { kind } : { kind, freqHz: 100, gainDb: 0, qFactor: 1 };
    const curve = padraoV2();
    curve.bands[0] = band;
    const s1 = encodeS1(curve);
    assert.equal(s1[0], ['g', 'g', 'h', 'h', 'i', 'i'][index]);
    assert.equal(decodeS1(s1).version, 2);
  }
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
    // 20001 to 32000 Hz is S1 v2; above the v2 grid is out of range.
    { kind: 'PK', freqHz: 32001, gainDb: 0, qFactor: 1 },
    { kind: 'LP', freqHz: 32001, qFactor: 0.71 },
    { kind: 'PK', freqHz: 32768, gainDb: 0, qFactor: 1 },
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
  assert.equal(decodeS1(s1).version, 1);
  // The top of the v2 grid is accepted too (as v2).
  const top = { kind: 'HS', freqHz: 32000, gainDb: 12.7, qFactor: 20.47 };
  const v2 = encodeS1({ bands: [extremes[0], top, ...PADRAO.eqBands.slice(2)], preampDb: -25.5 });
  assert.equal(decodeS1(v2).version, 2);
  assert.deepEqual(decodeS1(v2).bands.slice(0, 2), [extremes[0], top]);
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
  expectCode(() => encodeS1(padraoWith(0, null)), 's1:bands');
});

test('holes and non-object bands always fail with s1:bands in both writing APIs', () => {
  for (const invalid of [undefined, null, 0, false, 'PK', 1n, Symbol('band'), () => 1]) {
    const bands = [...NEUTRAL.eqBands];
    bands[4] = invalid;
    expectCode(() => encodeS1({ bands, preampDb: 0 }), 's1:bands');
    expectCode(() => canonKey(bands, 0), 's1:bands');
  }
  fc.assert(
    fc.property(fc.sparseArray(bandArb, { maxLength: 10, maxNumElements: 9 }), (bands) => {
      bands.length = 10; // At least one hole, including trailing holes.
      expectCode(() => encodeS1({ bands, preampDb: 0 }), 's1:bands');
      expectCode(() => canonKey(bands, 0), 's1:bands');
    }),
    { numRuns: 1000 },
  );
});

test('property: arbitrary inputs and band fields throw only S1Error, never raw TypeError', () => {
  fc.assert(
    fc.property(fc.anything({ withBigInt: true, withNullPrototype: true }), (value) => {
      const arbitraryBands = Array.from({ length: 10 }, () => value);
      const fieldBands = ['kind', 'freqHz', 'gainDb', 'qFactor'].map((field) => [
        { kind: 'PK', freqHz: 100, gainDb: 0, qFactor: 1, [field]: value },
        ...NEUTRAL.eqBands.slice(1),
      ]);
      const operations = [
        () => encodeS1(value),
        () => encodeS1({ bands: value, preampDb: 0 }),
        () => canonKey(value, 0),
        () => encodeS1({ bands: NEUTRAL.eqBands, preampDb: value }),
        () => canonKey(NEUTRAL.eqBands, value),
        ...[arbitraryBands, ...fieldBands].flatMap((bands) => [
          () => encodeS1({ bands, preampDb: 0 }),
          () => canonKey(bands, 0),
        ]),
      ];
      for (const run of operations) {
        try {
          assert.equal(typeof run(), 'string');
        } catch (error) {
          assert.ok(error instanceof S1Error, String(error));
        }
      }
    }),
    { numRuns: 1000 },
  );
});

test('invalid fields need no coercion or JSON serialization to produce typed errors', () => {
  const circular = {};
  circular.self = circular;
  for (const value of [Object.create(null), circular, 1n, Symbol('value')]) {
    const bands = [{ kind: value }, ...NEUTRAL.eqBands.slice(1)];
    expectCode(() => encodeS1({ bands, preampDb: 0 }), 's1:kind');
    expectCode(() => canonKey(bands, 0), 's1:kind');
    expectCode(() => encodeS1({ bands: NEUTRAL.eqBands, preampDb: value }), 's1:range');
    expectCode(() => canonKey(NEUTRAL.eqBands, value), 's1:range');
  }
});

test('both writing APIs snapshot length, indices and fields once and map read failures', () => {
  for (const write of [
    (bands) => encodeS1({ bands, preampDb: PADRAO.preampDb }),
    (bands) => canonKey(bands, PADRAO.preampDb),
  ]) {
    const reads = [];
    const bands = new Proxy(
      PADRAO.eqBands.map(
        (band, index) =>
          new Proxy(band, {
            get(target, key) {
              reads.push(`${index}.${String(key)}`);
              return Reflect.get(target, key);
            },
          }),
      ),
      {
        get(target, key) {
          reads.push(String(key));
          return Reflect.get(target, key);
        },
      },
    );
    assert.equal(write(bands), write(PADRAO.eqBands));
    assert.deepEqual(reads, [
      'length',
      ...PADRAO.eqBands.flatMap((_, index) => [
        String(index),
        ...['kind', 'freqHz', 'gainDb', 'qFactor'].map((field) => `${index}.${field}`),
      ]),
    ]);
    const throwing = new Proxy([...NEUTRAL.eqBands], {
      get() {
        throw new TypeError('unreadable bands');
      },
    });
    expectCode(() => write(throwing), 's1:bands');
    const unreadable = new Proxy(NEUTRAL.eqBands[0], {
      get() {
        throw new Error('unreadable field');
      },
    });
    expectCode(() => write([unreadable, ...NEUTRAL.eqBands.slice(1)]), 's1:bands');
  }
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

test('decode refuses unknown versions (0 and 3) and variants, for v1 and v2 codes', () => {
  for (const s1 of [padraoS1(), PADRAO_V2_S1]) {
    for (const version of [0, 3]) {
      const other = mutate(s1, (bytes) => setBits(bytes, 0, 2, version));
      expectCode(() => decodeS1(other), 's1:version');
      expectCode(() => decodeS1(other.slice(0, 20)), 's1:version');
    }
    for (const variant of [1, 2, 3]) {
      expectCode(() => decodeS1(mutate(s1, (bytes) => setBits(bytes, 2, 2, variant))), 's1:variant');
    }
  }
  // Version 2 is known: its length is judged next.
  expectCode(() => decodeS1(PADRAO_V2_S1.slice(0, 20)), 's1:length');
  expectCode(() => decodeS1(`${PADRAO_V2_S1}A`), 's1:length');
});

test('decode refuses a v2 code without a band above 20 kHz (s1:noncanonical)', async () => {
  // padrao (every band at or below 20 kHz) relabelled as v2.
  const relabelled = mutate(padraoS1(), (bytes) => setBits(bytes, 0, 2, 2));
  assert.equal(relabelled[0], 'g');
  expectCode(() => decodeS1(relabelled), 's1:noncanonical');
  await assert.rejects(curveId(relabelled), (error) => {
    assert.ok(error instanceof S1Error);
    assert.equal(error.code, 's1:noncanonical');
    return true;
  });
  // The golden code with its 25 kHz band lowered to exactly 20 kHz: a v1 curve.
  const lowered = mutate(PADRAO_V2_S1, (bytes) => setBits(bytes, bandOffset(6) + 3, 15, 20000));
  expectCode(() => decodeS1(lowered), 's1:noncanonical');
  // Neutro (10 x OFF) relabelled as v2.
  const neutral = encodeS1({ bands: NEUTRAL.eqBands, preampDb: NEUTRAL.preampDb });
  const offV2 = mutate(neutral, (bytes) => setBits(bytes, 0, 2, 2));
  assert.equal(offV2[0], 'i');
  expectCode(() => decodeS1(offV2), 's1:noncanonical');
  // The reverse: the golden v2 curve relabelled as v1 is outside the v1 range.
  const asV1 = mutate(PADRAO_V2_S1, (bytes) => setBits(bytes, 0, 2, 1));
  assert.equal(asV1[0], 'Q');
  expectCode(() => decodeS1(asV1), 's1:range');
});

test('S1 v2 decode refuses frequencies above 32000 Hz (s1:range) and invalid kinds', () => {
  for (const index of [0, 5, 6, 9]) {
    for (const value of [32001, 32767]) {
      const bad = mutate(PADRAO_V2_S1, (bytes) =>
        setBits(bytes, bandOffset(index) + 3, 15, value),
      );
      expectCode(() => decodeS1(bad), 's1:range');
    }
    const zero = mutate(PADRAO_V2_S1, (bytes) => setBits(bytes, bandOffset(index) + 3, 15, 0));
    expectCode(() => decodeS1(zero), 's1:range');
  }
  // The top of the v2 grid decodes.
  const top = mutate(PADRAO_V2_S1, (bytes) => setBits(bytes, bandOffset(6) + 3, 15, 32000));
  assert.equal(decodeS1(top).bands[6].freqHz, 32000);
  // A v1-range band of a v2 code may sit anywhere in 1 to 32000 Hz too.
  const both = mutate(PADRAO_V2_S1, (bytes) => setBits(bytes, bandOffset(0) + 3, 15, 31000));
  /** @param {{freqHz: number}} band */
  const hz = (band) => band.freqHz;
  assert.deepEqual(decodeS1(both).bands.map(hz), [
    31000,
    ...PADRAO.eqBands.slice(1, 6).map(hz),
    25000,
    ...PADRAO.eqBands.slice(7).map(hz),
  ]);
  for (const code of [6, 7]) {
    const invalidFirst = mutate(PADRAO_V2_S1, (bytes) => setBits(bytes, bandOffset(0), 3, code));
    assert.equal(invalidFirst[0], 'j');
    expectCode(() => decodeS1(invalidFirst), 's1:kind');
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
    const invalidFirst = mutate(padraoS1(), (bytes) => setBits(bytes, bandOffset(0), 3, code));
    assert.equal(invalidFirst[0], 'T');
    expectCode(() => decodeS1(invalidFirst), 's1:kind');
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

test('v2: canonKey is equal for every permutation of the same bands, and stays v2', () => {
  fc.assert(
    fc.property(
      curveV2Arb,
      fc.shuffledSubarray([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { minLength: 10, maxLength: 10 }),
      (curve, order) => {
        const permuted = order.map((i) => curve.bands[i]);
        const key = canonKey(curve.bands, curve.preampDb);
        assert.ok(key.startsWith('v2;'), key);
        assert.equal(canonKey(permuted, curve.preampDb), key);
        // Every wire order of a v2 curve is a v2 code of its own.
        const s1 = encodeS1({ bands: permuted, preampDb: curve.preampDb });
        assert.equal(decodeS1(s1).version, 2);
        assert.deepEqual(decodeS1(s1).bands, permuted);
      },
    ),
    { numRuns: 1000 },
  );
  const golden = padraoV2();
  const reversed = [...golden.bands].reverse();
  assert.equal(canonKey(reversed, golden.preampDb), PADRAO_V2_KEY);
  assert.notEqual(encodeS1({ bands: reversed, preampDb: golden.preampDb }), PADRAO_V2_S1);
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
  // v2 keeps the definition, and is order-sensitive too.
  assert.equal(await curveId(PADRAO_V2_S1), expectedId(PADRAO_V2_S1));
  const golden = padraoV2();
  const v2Reversed = encodeS1({ bands: [...golden.bands].reverse(), preampDb: golden.preampDb });
  assert.equal(await curveId(v2Reversed), expectedId(v2Reversed));
  assert.notEqual(await curveId(v2Reversed), await curveId(PADRAO_V2_S1));
});

test('curveId validates its input', async () => {
  await assert.rejects(curveId('not s1!'), (error) => {
    assert.ok(error instanceof S1Error);
    assert.equal(error.code, 's1:charset');
    return true;
  });
  await assert.rejects(curveId(padraoS1().slice(1)), S1Error);
});
