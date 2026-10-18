import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  crc16Ccitt,
  designSection,
  encodePayload,
  encodeSection,
  snapshotBands,
} from '../../src/dsp/eq0xcb.mjs';
import { EqualizerApoError, parseEqualizerApo } from '../../src/io/equalizer-apo.mjs';
import { MeasurementError, parseMeasurement } from '../../src/io/measurement.mjs';
import { gate, gateForWrite } from '../../src/safety/gate.mjs';
import { THRESHOLDS } from '../../src/safety/thresholds.mjs';
import { parseEnvelope, serializeEnvelope } from '../../src/share/envelope.mjs';
import { decodeS1, encodeS1, S1Error } from '../../src/share/s1.mjs';
import { createFakeClock, FakeHIDDevice } from '../../src/transport/fake-device.mjs';
import { GateRejectedError, writeCurve } from '../../src/transport/webhid.mjs';

const OPTIONS = Object.freeze({ numRuns: 1000, seed: 20261016 });
const OFF = Object.freeze({ kind: 'OFF' });
const offBands = () => Array.from({ length: 10 }, () => ({ ...OFF }));
const textArb = fc.string({ maxLength: 2048 });
const numericArb = fc.oneof(
  fc.double(),
  fc.constantFrom(NaN, Infinity, -Infinity, -0, 0, 5e-324, -5e-324, 1e300, -1e300),
);
const malformedBandArb = fc.oneof(
  fc.constantFrom(null, undefined, false, 1, 'PK'),
  fc.record({
    kind: fc.oneof(
      fc.constantFrom('PK', 'LS', 'HS', 'LP', 'HP', 'OFF', 'INVALID', '', null, 17),
      fc.string({ maxLength: 12 }),
    ),
    freqHz: numericArb,
    gainDb: numericArb,
    qFactor: numericArb,
  }),
);

function assertGrid(value, min, max, scale) {
  assert.ok(Number.isFinite(value));
  assert.ok(value >= min && value <= max, `${value} outside [${min}, ${max}]`);
  assert.ok(Math.abs(value * scale - Math.round(value * scale)) < 1e-8);
}

// S1 v1 bands go up to 20000 Hz, v2 bands up to 32000 Hz (docs/s1-format.md).
const S1_FREQ_LIMITS = Object.freeze({ 1: 20000, 2: 32000 });

function assertDecodedGrid(curve) {
  assert.ok(curve.version === 1 || curve.version === 2, `version ${curve.version}`);
  assert.equal(curve.variant, 0);
  assert.equal(curve.bands.length, 10);
  assertGrid(curve.preampDb, -25.5, 0, 10);
  let ultrasonic = false;
  for (const band of curve.bands) {
    assert.ok(['PK', 'LS', 'HS', 'LP', 'HP', 'OFF'].includes(band.kind));
    if (band.kind === 'OFF') {
      assert.deepEqual(band, OFF);
      continue;
    }
    assertGrid(band.freqHz, 1, S1_FREQ_LIMITS[curve.version], 1);
    if (band.freqHz > S1_FREQ_LIMITS[1]) ultrasonic = true;
    assertGrid(band.qFactor, 0.01, 20.47, 100);
    if (band.kind === 'LP' || band.kind === 'HP') assert.equal(band.gainDb, undefined);
    else assertGrid(band.gainDb, -25.6, 12.7, 10);
  }
  // Canonical version: v2 if and only if a non-OFF band is above 20000 Hz.
  assert.equal(curve.version, ultrasonic ? 2 : 1);
}

// Catch only the parser call, so assertions cannot be mistaken for expected errors.
function parseOrTypedError(parse, ErrorType, check) {
  let parsed;
  try {
    parsed = parse();
  } catch (error) {
    assert.ok(error instanceof ErrorType, `unexpected ${error?.constructor?.name}: ${error}`);
    return false;
  }
  check(parsed);
  return true;
}

/** Grid bands with frequencies in [min, max]; OFF too unless `off` is false. */
const shareBandArbOf = (min, max, off = true) =>
  fc.oneof(
    ...(off ? [fc.constant(OFF)] : []),
    fc.record({
      kind: fc.constantFrom('PK', 'LS', 'HS'),
      freqHz: fc.integer({ min, max }),
      gainDb: fc.integer({ min: -256, max: 127 }).map((value) => value / 10),
      qFactor: fc.integer({ min: 1, max: 2047 }).map((value) => value / 100),
    }),
    fc.record({
      kind: fc.constantFrom('LP', 'HP'),
      freqHz: fc.integer({ min, max }),
      qFactor: fc.integer({ min: 1, max: 2047 }).map((value) => value / 100),
    }),
  );
const sharePreampArb = fc.integer({ min: -255, max: 0 }).map((value) => value / 10);
const shareCurveV1Arb = fc.record({
  bands: fc.array(shareBandArbOf(1, 20000), { minLength: 10, maxLength: 10 }),
  preampDb: sharePreampArb,
});
// S1 v2 curves: bands up to 32000 Hz and at least one non-OFF band above 20000 Hz.
const shareCurveV2Arb = fc
  .record({
    bands: fc.array(shareBandArbOf(1, 32000), { minLength: 10, maxLength: 10 }),
    preampDb: sharePreampArb,
    at: fc.integer({ min: 0, max: 9 }),
    ultrasonic: shareBandArbOf(20001, 32000, false),
  })
  .map(({ bands, preampDb, at, ultrasonic }) => ({
    bands: bands.map((band, index) => (index === at ? ultrasonic : band)),
    preampDb,
  }));
const shareCurveArb = fc.oneof(shareCurveV1Arb, shareCurveV2Arb);

test('fuzz: decodeS1 arbitrary strings yields only S1Error or an in-grid curve', () => {
  fc.assert(
    fc.property(textArb, (text) => {
      parseOrTypedError(() => decodeS1(text), S1Error, assertDecodedGrid);
    }),
    OPTIONS,
  );
});

test('fuzz: mutated valid S1, including repaired CRCs, never escapes typed errors or grid', (t) => {
  let decodedCount = 0;
  fc.assert(
    fc.property(
      shareCurveArb,
      fc.uint8Array({ minLength: 1, maxLength: 6 }),
      fc.integer({ min: 0, max: 50 }),
      fc.boolean(),
      fc.constantFrom('bits', 'bits', 'bits', 'bits', 'replace', 'insert', 'delete'),
      (curve, changes, start, repairCrc, mutation) => {
        const valid = encodeS1(curve);
        const original = decodeS1(valid);
        assertDecodedGrid(original);
        assert.deepEqual(
          original.bands,
          curve.bands.map((band) => ({ ...band })),
        );
        assert.equal(original.preampDb, curve.preampDb);
        const bytes = Buffer.from(valid, 'base64url');
        for (let i = 0; i < changes.length; i++) {
          bytes[(start + i) % bytes.length] ^= changes[i] | 1;
        }
        if (repairCrc) {
          const crc = crc16Ccitt(bytes.subarray(0, 49));
          bytes[49] = crc >>> 8;
          bytes[50] = crc & 0xff;
        }
        let candidate = bytes.toString('base64url');
        const position = start % valid.length;
        if (mutation === 'replace') {
          const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
          const replacement = alphabet[(alphabet.indexOf(valid[position]) + 1) % alphabet.length];
          candidate = valid.slice(0, position) + replacement + valid.slice(position + 1);
        } else if (mutation === 'insert') {
          candidate = `${valid.slice(0, position)}!${valid.slice(position)}`;
        } else if (mutation === 'delete') {
          candidate = valid.slice(0, position) + valid.slice(position + 1);
        }
        if (
          parseOrTypedError(
            () => decodeS1(candidate),
            S1Error,
            (decoded) => {
              assertDecodedGrid(decoded);
              assert.equal(encodeS1(decoded), candidate);
            },
          )
        ) {
          decodedCount++;
        }
      },
    ),
    OPTIONS,
  );
  assert.ok(decodedCount >= 25, `only ${decodedCount} CRC-valid mutations reached the grid checks`);
  t.diagnostic(`1000 mutations, ${decodedCount} accepted and independently checked on the S1 grid`);
});

test('fuzz: S1 v2 codes, mutated and resealed, never escape typed errors or the v2 grid', (t) => {
  let decodedCount = 0;
  let refusedCount = 0;
  fc.assert(
    fc.property(
      shareCurveV2Arb,
      fc.constantFrom(0, 1, 2, 3),
      fc.array(fc.tuple(fc.integer({ min: 4, max: 391 }), fc.boolean()), { maxLength: 6 }),
      (curve, version, flips) => {
        const valid = encodeS1(curve);
        assert.match(valid, /^[ghi]/);
        const original = decodeS1(valid);
        assertDecodedGrid(original);
        assert.equal(original.version, 2);
        // Rewrite the version field, flip body bits (frequencies above 32000 Hz, a band
        // brought down to 20 kHz, kinds 6 and 7...), then repair the CRC.
        const bytes = Buffer.from(valid, 'base64url');
        bytes[0] = (bytes[0] & 0x3f) | (version << 6);
        for (const [bit, value] of flips) {
          const mask = 0x80 >>> (bit & 7);
          if (value) bytes[bit >>> 3] |= mask;
          else bytes[bit >>> 3] &= ~mask;
        }
        const crc = crc16Ccitt(bytes.subarray(0, 49));
        bytes[49] = crc >>> 8;
        bytes[50] = crc & 0xff;
        const candidate = bytes.toString('base64url');
        const accepted = parseOrTypedError(
          () => decodeS1(candidate),
          S1Error,
          (decoded) => {
            assertDecodedGrid(decoded);
            assert.equal(encodeS1(decoded), candidate);
          },
        );
        if (accepted) decodedCount++;
        else refusedCount++;
        if (version === 0 || version === 3) assert.equal(accepted, false);
      },
    ),
    OPTIONS,
  );
  assert.ok(decodedCount >= 40, `only ${decodedCount} v2 mutations decoded`);
  assert.ok(refusedCount >= 300, `only ${refusedCount} v2 mutations refused`);
  t.diagnostic(`1000 v2 mutations: ${decodedCount} decoded on the grid, ${refusedCount} refused`);
});

function assertEnvelopeResult(result) {
  assert.equal(typeof result.ok, 'boolean');
  if (result.ok) {
    assertDecodedGrid(decodeS1(result.value.code));
    assert.deepEqual(parseEnvelope(serializeEnvelope(result.value)), result);
  } else {
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    for (const error of result.errors) {
      assert.equal(typeof error.path, 'string');
      assert.match(error.code, /^env:/);
      assert.equal(typeof error.message, 'string');
    }
  }
}

test('fuzz: parseEnvelope arbitrary JSON values and their serialized forms never throw', () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      assertEnvelopeResult(parseEnvelope(value));
      assertEnvelopeResult(parseEnvelope(JSON.stringify(value)));
    }),
    OPTIONS,
  );
});

test('fuzz: parseEnvelope arbitrary strings and arbitrary envelope fields never throw', () => {
  const curve = { bands: offBands(), preampDb: -0.5 };
  const envelope = {
    format: 'open-auri/preset@1',
    name: 'Fuzz fixture',
    description: '',
    source: 'custom',
    license: 'CC0-1.0',
    lang: 'en-US',
    createdAt: '2026-10-16T00:00:00Z',
    code: encodeS1(curve),
    ...curve,
  };
  // An S1 v2 curve (a band above 20 kHz) in open-auri/preset@2.
  const curveV2 = {
    bands: [{ kind: 'PK', freqHz: 25000, gainDb: -3, qFactor: 1 }, ...offBands().slice(1)],
    preampDb: -0.5,
  };
  const envelopeV2 = {
    ...envelope,
    format: 'open-auri/preset@2',
    code: encodeS1(curveV2),
    ...curveV2,
  };
  assertEnvelopeResult(parseEnvelope(JSON.stringify(envelopeV2)));
  assert.equal(parseEnvelope(JSON.stringify(envelopeV2)).ok, true);
  assert.equal(decodeS1(envelopeV2.code).version, 2);
  fc.assert(
    fc.property(
      textArb,
      fc.constantFrom(envelope, envelopeV2),
      fc.constantFrom(...Object.keys(envelope), 'labels', 'recipe', 'extra'),
      fc.jsonValue(),
      (text, base, key, value) => {
        assertEnvelopeResult(parseEnvelope(text));
        assertEnvelopeResult(parseEnvelope(JSON.stringify({ ...base, [key]: value })));
      },
    ),
    OPTIONS,
  );
});

const apoTextArb = fc.oneof(
  textArb,
  fc
    .array(
      fc.tuple(
        fc.constantFrom('', '# ', 'Preamp: ', 'Filter 1: ON PK Fc ', 'Filter 2: OFF LSQ '),
        fc.string({ maxLength: 128 }),
      ),
      { maxLength: 16 },
    )
    .map((lines) => lines.map(([prefix, text]) => prefix + text).join('\n')),
);

test('fuzz: parseEqualizerApo arbitrary text throws only EqualizerApoError', () => {
  fc.assert(
    fc.property(apoTextArb, (text) => {
      parseOrTypedError(
        () => parseEqualizerApo(text),
        EqualizerApoError,
        (parsed) => {
          assert.equal(parsed.bands.length, 10);
          assert.ok(Number.isFinite(parsed.preampDb));
          assert.ok(Array.isArray(parsed.warnings));
        },
      );
    }),
    OPTIONS,
  );
});

const measurementTextArb = fc.oneof(
  textArb,
  fc
    .tuple(fc.constantFrom('frequency,raw\n', '* REW\n', 'frequency;spl\n'), textArb)
    .map(([header, text]) => header + text),
  fc.constant('frequency,raw\n20,0\n1000,1\n20000,0\n'),
);

test('fuzz: parseMeasurement arbitrary text throws only MeasurementError', () => {
  fc.assert(
    fc.property(measurementTextArb, (text) => {
      parseOrTypedError(
        () => parseMeasurement(text),
        MeasurementError,
        (parsed) => {
          assert.ok(parsed.frequencies.length > 0);
          assert.equal(parsed.frequencies.length, parsed.values.length);
          parsed.frequencies.forEach((frequency, index) => {
            assert.ok(Number.isFinite(frequency) && frequency > 0);
            if (index > 0) assert.ok(frequency > parsed.frequencies[index - 1]);
          });
          assert.ok(parsed.values.every(Number.isFinite));
        },
      );
    }),
    OPTIONS,
  );
});

const validBandArb = fc.record({
  kind: fc.constantFrom('PK', 'LS', 'HS', 'LP', 'HP'),
  freqHz: fc.integer({ min: 30, max: 20000 }),
  gainDb: fc.integer({ min: -240, max: 92 }).map((value) => value / 10),
  qFactor: fc.integer({ min: 10, max: 2000 }).map((value) => value / 100),
});
const cutBandArb = fc.record({
  kind: fc.constantFrom('PK', 'LS'),
  freqHz: fc.integer({ min: 100, max: 14000 }),
  gainDb: fc.integer({ min: -40, max: 0 }).map((value) => value / 10),
  qFactor: fc.integer({ min: 50, max: 200 }).map((value) => value / 100),
});
const bandsArb = fc.oneof(
  { weight: 3, arbitrary: fc.array(malformedBandArb, { maxLength: 14 }) },
  { weight: 3, arbitrary: fc.array(malformedBandArb, { minLength: 10, maxLength: 10 }) },
  { weight: 3, arbitrary: validBandArb.map((band) => [band, ...offBands().slice(1)]) },
  { weight: 1, arbitrary: fc.array(cutBandArb, { minLength: 10, maxLength: 10 }) },
);
const preampArb = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -255, max: -5 }).map((value) => value / 10) },
  { weight: 1, arbitrary: numericArb },
);

function assertIndependentWireSafety(bands, preampDb) {
  const payload = Uint8Array.from(encodePayload(bands, preampDb));
  const view = new DataView(payload.buffer);
  for (const [stage, band] of bands.entries()) {
    const words = encodeSection(designSection(band));
    words.forEach((word, position) => {
      assert.ok(Number.isInteger(word));
      assert.ok(Math.abs(word) <= THRESHOLDS.coefficientAbsWords[position]);
      assert.equal(view.getInt32(18 + (stage * 5 + position) * 4, true), word);
    });
    // Solve the quantized denominator independently, without gate.poleRadius/fromWords.
    const a1 = -words[2] / 2 ** 27;
    const a2 = -words[4] / 2 ** 27;
    const discriminant = a1 * a1 - 4 * a2;
    const radius =
      discriminant < 0
        ? Math.hypot(-a1 / 2, Math.sqrt(-discriminant) / 2)
        : Math.max(
            Math.abs((-a1 + Math.sqrt(discriminant)) / 2),
            Math.abs((-a1 - Math.sqrt(discriminant)) / 2),
          );
    assert.ok(Number.isFinite(radius));
    assert.ok(radius <= THRESHOLDS.poleRadius + THRESHOLDS.radiusNumericalTolerance);
  }
}

test('fuzz: arbitrary band arrays never throw; gate.ok implies quantized limits a and b', (t) => {
  let accepted = 0;
  let multiSectionAccepted = 0;
  let rejected = 0;
  fc.assert(
    fc.property(bandsArb, preampArb, fc.boolean(), (bands, preampDb, experimental) => {
      const result = gate(bands, preampDb, { experimental });
      assert.equal(typeof result.ok, 'boolean');
      assert.equal(result.metrics.grid, 'full');
      if (result.ok) {
        accepted++;
        if (bands.filter((band) => band.kind !== 'OFF').length > 1) multiSectionAccepted++;
        assert.deepEqual(result.reasons, []);
        assertIndependentWireSafety(bands, preampDb);
      } else {
        rejected++;
        assert.ok(result.reasons.length > 0);
      }
    }),
    OPTIONS,
  );
  assert.ok(accepted >= 100, `only ${accepted} accepted curves exercised the safety implication`);
  assert.ok(multiSectionAccepted >= 20, `only ${multiSectionAccepted} accepted cascades`);
  assert.ok(rejected >= 100);
  t.diagnostic(
    `1000 curves: ${accepted} accepted (${multiSectionAccepted} cascades), ${rejected} rejected`,
  );
});

test('fuzz: rejecting writeCurve gate never calls sendReport for malformed curves', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(malformedBandArb, { maxLength: 14 }),
      numericArb,
      fc.array(fc.jsonValue(), { maxLength: 5 }),
      async (bands, preampDb, reasons) => {
        const clock = createFakeClock();
        const device = new FakeHIDDevice({ clock });
        const sendReport = device.sendReport.bind(device);
        let sendCalls = 0;
        device.sendReport = async (reportId, bytes) => {
          sendCalls++;
          return sendReport(reportId, bytes);
        };
        // The real gate runs first; the stub only sees curves it approved, as a snapshot.
        const real = gateForWrite(bands, preampDb);
        let gateCalls = 0;
        await assert.rejects(
          writeCurve(device, bands, preampDb, {
            clock,
            gate(receivedBands, receivedPreamp) {
              gateCalls++;
              assert.deepEqual(receivedBands, real.metrics.bands);
              assert.ok(Object.isFrozen(receivedBands));
              assert.ok(Object.is(receivedPreamp, preampDb));
              return { ok: false, reasons };
            },
          }),
          (error) => {
            assert.ok(error instanceof GateRejectedError);
            assert.deepEqual(error.reasons, real.ok ? reasons : real.reasons);
            return true;
          },
        );
        assert.equal(gateCalls, real.ok ? 1 : 0);
        assert.equal(sendCalls, 0);
        assert.equal(device.opened, false);
        assert.equal(device.attempts, 0);
        assert.deepEqual(device.sent, []);
        assert.equal(clock.pending(), 0);
      },
    ),
    OPTIONS,
  );
});

test('fuzz: writeCurve sends iff the real gate approves, exactly the gated bytes', async (t) => {
  let sent = 0;
  let refused = 0;
  await fc.assert(
    fc.asyncProperty(bandsArb, preampArb, fc.boolean(), async (bands, preampDb, experimental) => {
      const verdict = gateForWrite(bands, preampDb, { experimental });
      const clock = createFakeClock(0, { autoAdvance: true });
      const device = new FakeHIDDevice({ clock });
      let sendCalls = 0;
      const sendReport = device.sendReport.bind(device);
      device.sendReport = async (reportId, bytes) => {
        sendCalls++;
        return sendReport(reportId, bytes);
      };
      let result;
      try {
        result = await writeCurve(device, bands, preampDb, { clock, experimental });
      } catch (error) {
        assert.ok(error instanceof GateRejectedError, String(error));
        assert.equal(verdict.ok, false);
        assert.deepEqual(error.reasons, verdict.reasons);
        assert.equal(sendCalls, 0);
        assert.equal(device.opened, false);
        refused++;
        return;
      }
      assert.equal(verdict.ok, true);
      assert.equal(result.status, 'ok');
      assert.equal(sendCalls, 10);
      const payload = device.sent.slice(0, 9).flatMap(({ bytes }) => [...bytes.slice(1)]);
      const expected = encodePayload(snapshotBands(bands), preampDb);
      assert.deepEqual(payload.slice(0, 220), expected);
      assert.deepEqual(payload.slice(0, 220), [...verdict.metrics.payload]);
      assert.ok(payload.slice(220).every((byte) => byte === 0));
      sent++;
    }),
    { numRuns: 300, seed: 20261016 },
  );
  assert.ok(sent >= 15, `only ${sent} curves were sent`);
  assert.ok(refused >= 30, `only ${refused} curves were refused`);
  t.diagnostic(`300 writes through the real gate: ${sent} sent, ${refused} refused`);
});

const sparseBandsArb = fc.oneof(
  fc.sparseArray(fc.oneof(fc.constant(OFF), malformedBandArb), {
    minNumElements: 0,
    maxLength: 14,
  }),
  fc
    .sparseArray(fc.constant(OFF), { minNumElements: 1, maxNumElements: 9, maxLength: 10 })
    .map((bands) => {
      bands.length = 10;
      return bands;
    }),
);
const isSparse = (bands) =>
  Array.from({ length: bands.length }, (_, i) => i in bands).includes(false);

test('fuzz: gate never throws on sparse arrays or arbitrary values; holes are f:codec', () => {
  let holes = 0;
  fc.assert(
    fc.property(
      fc.oneof({ weight: 4, arbitrary: sparseBandsArb }, { weight: 1, arbitrary: fc.anything() }),
      preampArb,
      fc.boolean(),
      (bands, preampDb, experimental) => {
        const result = gate(bands, preampDb, { experimental });
        assert.equal(typeof result.ok, 'boolean');
        if (Array.isArray(bands) && isSparse(bands)) {
          holes++;
          assert.equal(result.ok, false);
          assert.equal(result.reasons.at(-1).code, 'f:codec');
        }
        if (!Array.isArray(bands)) {
          assert.deepEqual(result.reasons, [{ code: 'f:codec', value: 'bands must be an array' }]);
        }
      },
    ),
    OPTIONS,
  );
  assert.ok(holes >= 200, `only ${holes} sparse arrays`);
});

test('fuzz: encodePayload throws only TypeError/RangeError and only returns 220 bytes', () => {
  let encoded = 0;
  fc.assert(
    fc.property(
      fc.oneof(
        { weight: 3, arbitrary: sparseBandsArb },
        { weight: 2, arbitrary: bandsArb },
        { weight: 1, arbitrary: fc.anything() },
      ),
      preampArb,
      (bands, preampDb) => {
        let payload;
        try {
          payload = encodePayload(bands, preampDb);
        } catch (error) {
          assert.ok(
            error instanceof TypeError || error instanceof RangeError,
            `unexpected ${error?.constructor?.name}: ${error}`,
          );
          return;
        }
        encoded++;
        assert.equal(payload.length, 220);
        assert.ok(!isSparse(bands));
        assert.ok(payload.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255));
      },
    ),
    OPTIONS,
  );
  assert.ok(encoded >= 20, `only ${encoded} payloads encoded`);
});
