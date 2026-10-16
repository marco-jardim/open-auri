import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { crc16Ccitt, designSection, encodePayload, encodeSection } from '../../src/dsp/eq0xcb.mjs';
import { EqualizerApoError, parseEqualizerApo } from '../../src/io/equalizer-apo.mjs';
import { MeasurementError, parseMeasurement } from '../../src/io/measurement.mjs';
import { gate } from '../../src/safety/gate.mjs';
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

function assertDecodedGrid(curve) {
  assert.equal(curve.version, 1);
  assert.equal(curve.variant, 0);
  assert.equal(curve.bands.length, 10);
  assertGrid(curve.preampDb, -25.5, 0, 10);
  for (const band of curve.bands) {
    assert.ok(['PK', 'LS', 'HS', 'LP', 'HP', 'OFF'].includes(band.kind));
    if (band.kind === 'OFF') {
      assert.deepEqual(band, OFF);
      continue;
    }
    assertGrid(band.freqHz, 1, 20000, 1);
    assertGrid(band.qFactor, 0.01, 20.47, 100);
    if (band.kind === 'LP' || band.kind === 'HP') assert.equal(band.gainDb, undefined);
    else assertGrid(band.gainDb, -25.6, 12.7, 10);
  }
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

const shareBandArb = fc.oneof(
  fc.constant(OFF),
  fc.record({
    kind: fc.constantFrom('PK', 'LS', 'HS'),
    freqHz: fc.integer({ min: 1, max: 20000 }),
    gainDb: fc.integer({ min: -256, max: 127 }).map((value) => value / 10),
    qFactor: fc.integer({ min: 1, max: 2047 }).map((value) => value / 100),
  }),
  fc.record({
    kind: fc.constantFrom('LP', 'HP'),
    freqHz: fc.integer({ min: 1, max: 20000 }),
    qFactor: fc.integer({ min: 1, max: 2047 }).map((value) => value / 100),
  }),
);
const shareCurveArb = fc.record({
  bands: fc.array(shareBandArb, { minLength: 10, maxLength: 10 }),
  preampDb: fc.integer({ min: -255, max: 0 }).map((value) => value / 10),
});

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
  fc.assert(
    fc.property(
      textArb,
      fc.constantFrom(...Object.keys(envelope), 'recipe', 'extra'),
      fc.jsonValue(),
      (text, key, value) => {
        assertEnvelopeResult(parseEnvelope(text));
        assertEnvelopeResult(parseEnvelope(JSON.stringify({ ...envelope, [key]: value })));
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
        let gateCalls = 0;
        await assert.rejects(
          writeCurve(device, bands, preampDb, {
            clock,
            gate(receivedBands, receivedPreamp) {
              gateCalls++;
              assert.equal(receivedBands, bands);
              assert.ok(Object.is(receivedPreamp, preampDb));
              return { ok: false, reasons };
            },
          }),
          (error) => {
            assert.ok(error instanceof GateRejectedError);
            assert.deepEqual(error.reasons, reasons);
            return true;
          },
        );
        assert.equal(gateCalls, 1);
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
