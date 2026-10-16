import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as codec from '../../src/dsp/eq0xcb.mjs';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);
const presetIds = Object.keys(fixture.presets);

const peaking = (freqHz, gainDb, qFactor) => ({ kind: 'PK', freqHz, gainDb, qFactor });
const withNeutral = (band) => [band, ...codec.NEUTRAL_BANDS.slice(1)];
const toDb = (ratio) => 20 * Math.log10(Math.abs(ratio));
const dcGainDb = (s) => toDb((s.b0 + s.b1 + s.b2) / (1 + s.a1 + s.a2));
const nyquistGainDb = (s) => toDb((s.b0 - s.b1 + s.b2) / (1 - s.a1 + s.a2));
const MINUS_3DB = 20 * Math.log10(Math.SQRT1_2);

// --- Independent checks (do not derive from the reference) -------------------

// CRC-16/CCITT-FALSE check value for "123456789" is 0x29B1 (CRC catalogue).
test('crc16Ccitt matches the published check value', () => {
  const ascii = [...'123456789'].map((ch) => ch.charCodeAt(0));
  assert.equal(codec.crc16Ccitt(ascii), 0x29b1);
});

test('preamp 0 dB encodes 1.0 in Q23', () => {
  assert.equal(codec.preampWord(0), 1 << 23);
  assert.equal(codec.preampWord(), 1 << 23);
});

// RBJ cookbook properties, from the filter definitions themselves.
test('peaking: gain at the centre frequency equals gainDb', () => {
  for (const [freqHz, gainDb, qFactor] of [
    [1000, 6, 1],
    [100, -9, 2],
    [8000, 3, 0.7],
    [40, -12, 4],
  ]) {
    const measured = codec.magnitudeDb([peaking(freqHz, gainDb, qFactor)], freqHz);
    assert.ok(Math.abs(measured - gainDb) < 1e-9, `PK ${freqHz} ${gainDb} ${qFactor}`);
  }
});

test('peaking with 0 dB has coinciding zeros and poles', () => {
  const s = codec.designPeaking(1000, 0, 1);
  assert.equal(s.b0, 1);
  assert.equal(s.b1, s.a1);
  assert.equal(s.b2, s.a2);
});

test('low shelf: DC gain is gainDb, Nyquist gain is 0 dB', () => {
  const s = codec.designLowShelf(100, 6, 0.7);
  assert.ok(Math.abs(dcGainDb(s) - 6) < 1e-6);
  assert.ok(Math.abs(nyquistGainDb(s)) < 1e-9);
});

test('high shelf: Nyquist gain is gainDb, DC gain is 0 dB', () => {
  const s = codec.designHighShelf(8000, -4, 0.7);
  assert.ok(Math.abs(nyquistGainDb(s) + 4) < 1e-9);
  assert.ok(Math.abs(dcGainDb(s)) < 1e-6);
});

test('low/high pass: unity in the passband, -3.01 dB at the corner for Q = 1/sqrt(2)', () => {
  const lowPass = { kind: 'LP', freqHz: 1000, qFactor: Math.SQRT1_2 };
  const highPass = { kind: 'HP', freqHz: 1000, qFactor: Math.SQRT1_2 };
  assert.ok(Math.abs(dcGainDb(codec.designSection(lowPass))) < 1e-6);
  assert.ok(Math.abs(nyquistGainDb(codec.designSection(highPass))) < 1e-9);
  assert.ok(Math.abs(codec.magnitudeDb([lowPass], 1000) - MINUS_3DB) < 1e-9);
  assert.ok(Math.abs(codec.magnitudeDb([highPass], 1000) - MINUS_3DB) < 1e-9);
});

// --- Reference equivalence ------------------------------------------------------

test('constants match the reference', () => {
  const ref = fixture.constants;
  assert.deepEqual(codec.PREAMBLE, ref.preamble);
  assert.deepEqual(codec.COMMIT_COMMAND, ref.commitCommand);
  assert.equal(codec.HID_REPORT_ID, ref.hidReportId);
  assert.equal(codec.SAMPLE_RATE, ref.sampleRate);
  assert.equal(codec.USB_VID, ref.usbVid);
  assert.equal(codec.USB_PID, ref.usbPid);
});

test('fixture covers every Auri preset', () => {
  assert.ok(presetIds.length >= 11, `expected >= 11 presets, got ${presetIds.length}`);
});

for (const id of presetIds) {
  const expected = fixture.presets[id];

  test(`payload matches reference: ${id}`, () => {
    assert.equal(expected.payload.length, codec.PAYLOAD_SIZE);
    assert.deepEqual(codec.encodePayload(expected.eqBands, expected.preampDb), expected.payload);
  });

  test(`reports match reference: ${id}`, () => {
    const actual = codec
      .encodeReports(expected.eqBands, expected.preampDb)
      .map((r) => Array.from(r));
    assert.deepEqual(actual, expected.reports);
  });
}

// --- Structure --------------------------------------------------------------------

test('framing: 9 reports of 31 bytes with the index in byte 0', () => {
  const { eqBands } = fixture.presets[presetIds[0]];
  const reports = codec.encodeReports(eqBands, -3);
  assert.equal(reports.length, 9);
  reports.forEach((report, index) => {
    assert.equal(report.length, 31);
    assert.equal(report[0], index);
  });
});

test('preamble bytes 4..5 are a u16 LE length of everything after them', () => {
  const { eqBands, preampDb } = fixture.presets.padrao;
  const payload = codec.encodePayload(eqBands, preampDb);
  assert.equal(payload[4] | (payload[5] << 8), payload.length - 6);
});

test('commitReport is the reference commit command zero-padded to 31 bytes', () => {
  const report = codec.commitReport();
  assert.equal(report.length, codec.REPORT_SIZE);
  assert.deepEqual(Array.from(report.slice(0, codec.COMMIT_COMMAND.length)), [
    ...codec.COMMIT_COMMAND,
  ]);
  assert.ok(report.slice(codec.COMMIT_COMMAND.length).every((byte) => byte === 0));
});

test('exported constants cannot be mutated', () => {
  assert.throws(() => codec.PREAMBLE.push(0), TypeError);
  assert.throws(() => {
    codec.COMMIT_COMMAND[0] = 0;
  }, TypeError);
  assert.ok(Object.isFrozen(codec.NEUTRAL_BANDS));
});

// --- Neutral / pass-through -------------------------------------------------------

test('OFF encodes the exact identity section', () => {
  assert.deepEqual(codec.encodeSection(codec.designSection(codec.OFF)), [2 ** 27, 0, 0, 0, 0]);
});

test('neutral preset: ten identity sections and a flat response', () => {
  const payload = codec.encodePayload(codec.NEUTRAL_BANDS, 0);
  for (let section = 0; section < codec.BAND_COUNT; section++) {
    const bytes = payload.slice(18 + section * 20, 38 + section * 20);
    assert.deepEqual(bytes, [0, 0, 0, 8, ...new Array(16).fill(0)]);
  }
  assert.equal(codec.magnitudeDb(codec.NEUTRAL_BANDS, 1000), 0);
});

// --- Validation: nothing harmful may reach the flash ----------------------------------

test('encodePayload rejects a band count other than 10', () => {
  assert.throws(() => codec.encodePayload([], 0), /expected 10 bands/);
  assert.throws(() => codec.encodePayload(null, 0), /expected 10 bands/);
});

for (const [label, band] of [
  ['qFactor = 0 (would encode a silent section)', peaking(1000, 6, 0)],
  ['qFactor < 0 (would encode an unstable section)', peaking(1000, 6, -1)],
  ['freqHz = NaN (would encode a silent section)', peaking(NaN, 6, 1)],
  ['freqHz = 0', peaking(0, 6, 1)],
  ['freqHz at Nyquist', peaking(48000, 6, 1)],
  ['freqHz above Nyquist (would encode an unstable section)', peaking(60000, 6, 1)],
  ['gainDb = NaN', peaking(1000, NaN, 1)],
  ['gainDb = Infinity', peaking(1000, Infinity, 1)],
]) {
  test(`encodePayload rejects ${label}`, () => {
    assert.throws(() => codec.encodePayload(withNeutral(band), 0), RangeError);
  });
}

test('encodePayload rejects unknown or missing filter kinds instead of guessing', () => {
  const shelf = { freqHz: 100, gainDb: 6, qFactor: 0.7 };
  assert.throws(() => codec.encodePayload(withNeutral({ kind: 'LSQ', ...shelf }), 0), TypeError);
  assert.throws(() => codec.encodePayload(withNeutral(shelf), 0), TypeError);
  assert.throws(() => codec.encodePayload(withNeutral(null), 0), TypeError);
  assert.throws(() => codec.magnitudeDb([{ kind: 'HSQ', ...shelf }], 1000), TypeError);
});

test('encodePayload rejects a non-finite preamp', () => {
  assert.throws(() => codec.encodePayload(codec.NEUTRAL_BANDS, NaN), RangeError);
  assert.throws(() => codec.encodePayload(codec.NEUTRAL_BANDS, Infinity), RangeError);
});

test('encodePayload rejects a positive preamp and accepts 0 dB and cuts', () => {
  assert.throws(() => codec.encodePayload(codec.NEUTRAL_BANDS, 0.1), /<= 0 dB/);
  assert.throws(() => codec.preampWord(6), /<= 0 dB/);
  assert.equal(codec.preampWord(-0), 1 << 23);
  assert.ok(codec.preampWord(-6) < 1 << 23);
});

test('encodePayload rejects coefficients outside int32 (Q27)', () => {
  assert.throws(
    () => codec.encodePayload(withNeutral(peaking(20000, 40, 0.1)), 0),
    /does not fit Q27/,
  );
});

test('isStable implements the Jury criterion', () => {
  assert.equal(codec.isStable(-1.9, 0.95), true);
  assert.equal(codec.isStable(0, 1), false);
  assert.equal(codec.isStable(-2.1, 0.5), false);
});

test('stability is checked on the quantized coefficients, not the ideal ones', () => {
  const nearlyMarginal = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 1 - 1e-12 };
  assert.equal(codec.isStable(nearlyMarginal.a1, nearlyMarginal.a2), true);
  assert.throws(() => codec.encodeSection(nearlyMarginal), /unstable/);
});

// --- One read per field (snapshotBands) --------------------------------------

/** A band whose every property read is logged; values come from `values`. */
function loggedBand(values, log) {
  return new Proxy(
    {},
    {
      get(_, key) {
        log.push(key);
        return values[key];
      },
    },
  );
}

test('snapshotBands reads length once, each index once and each field once', () => {
  const fieldLog = [];
  const band = loggedBand({ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 }, fieldLog);
  const off = loggedBand({ kind: 'OFF', freqHz: 5, gainDb: 1 }, fieldLog);
  const arrayLog = [];
  const bands = new Proxy([band, off], {
    get(target, key, receiver) {
      arrayLog.push(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  const snapshot = codec.snapshotBands(bands);
  assert.deepEqual(arrayLog, ['length', '0', '1']);
  assert.deepEqual(fieldLog, [
    ...['kind', 'freqHz', 'gainDb', 'qFactor'],
    ...['kind', 'freqHz', 'gainDb', 'qFactor'],
  ]);
  assert.deepEqual(snapshot, [peaking(1000, -3, 1), { kind: 'OFF' }]);
  assert.ok(Object.isFrozen(snapshot) && snapshot.every((b) => Object.isFrozen(b)));
  assert.ok(Array.isArray(snapshot));
  // Undefined fields are omitted; nothing is coerced.
  const lp = codec.snapshotBands([{ kind: 'LP', freqHz: '1000', qFactor: 0.7 }])[0];
  assert.deepEqual(lp, { kind: 'LP', freqHz: '1000', qFactor: 0.7 });
  assert.ok(!Object.hasOwn(lp, 'gainDb'));
});

test('snapshotBands: holes, non-objects, non-arrays and bad lengths throw', () => {
  const sparse = [...codec.NEUTRAL_BANDS];
  delete sparse[4];
  assert.throws(() => codec.snapshotBands(sparse), {
    name: 'TypeError',
    message: 'band 4: missing (hole in a sparse array)',
  });
  assert.throws(() => codec.snapshotBands(new Array(3)), /band 0: missing/);
  assert.throws(() => codec.snapshotBands([codec.OFF, null]), {
    name: 'TypeError',
    message: 'band 1: not an object',
  });
  assert.throws(() => codec.snapshotBands([() => codec.OFF]), /band 0: not an object/);
  assert.throws(() => codec.snapshotBands({ length: 0 }), /bands must be an array/);
  assert.throws(() => codec.snapshotBands('PK'), TypeError);
  assert.throws(() => codec.snapshotBands([codec.OFF], 10), {
    name: 'RangeError',
    message: 'expected 10 bands',
  });
  const reads = [];
  const lying = new Proxy([], {
    get: (target, key) => (key === 'length' ? 1.5 : Reflect.get(target, key)),
  });
  assert.throws(() => codec.snapshotBands(lying), /invalid band count 1.5/);
  const tooLong = new Proxy([], {
    get(target, key) {
      reads.push(key);
      return key === 'length' ? 11 : Reflect.get(target, key);
    },
  });
  assert.throws(() => codec.snapshotBands(tooLong, 10), /expected 10 bands/);
  assert.deepEqual(reads, ['length']);
  const getterError = new Error('getter failed');
  const throwing = {
    get kind() {
      throw getterError;
    },
  };
  assert.throws(() => codec.snapshotBands([throwing]), getterError);
  assert.deepEqual(codec.snapshotBands([]), []);
});

test('B7: LP/HP gainDb must be absent or exactly 0, and 0 is dropped from the snapshot', () => {
  for (const kind of ['LP', 'HP']) {
    const plain = { kind, freqHz: 1000, qFactor: 0.7 };
    const reference = codec.encodePayload(withNeutral(plain), -1);
    codec.checkBand(plain);
    for (const zero of [0, -0]) {
      const snap = codec.snapshotBands([{ ...plain, gainDb: zero }])[0];
      assert.deepEqual(snap, plain);
      assert.ok(!Object.hasOwn(snap, 'gainDb'));
      codec.checkBand({ ...plain, gainDb: zero });
      assert.deepEqual(codec.encodePayload(withNeutral({ ...plain, gainDb: zero }), -1), reference);
    }
    for (const bad of [6, -0.1, 5e-324, NaN, Infinity, '0', null, false, 0n]) {
      const band = { ...plain, gainDb: bad };
      // Kept by the snapshot (never coerced) so that the codec refuses it.
      assert.ok(Object.is(codec.snapshotBands([band])[0].gainDb, bad));
      assert.throws(() => codec.checkBand(band), {
        name: 'RangeError',
        message: new RegExp(`^band 0: ${kind} takes no gain: gainDb must be absent or 0, got `),
      });
      assert.throws(() => codec.encodePayload(withNeutral(band), -1), RangeError);
    }
    for (const bad of [{}, [], Symbol('g'), () => 0]) {
      assert.throws(() => codec.encodePayload(withNeutral({ ...plain, gainDb: bad }), -1), {
        name: 'TypeError',
        message: /^band 0: gainDb must be a number, got (an object|a symbol|a function)$/,
      });
    }
  }
  assert.throws(() => codec.checkBand({ kind: 'LP', freqHz: 1000, gainDb: 6, qFactor: 1 }, 3), {
    message: 'band 3: LP takes no gain: gainDb must be absent or 0, got 6',
  });
  // Gain kinds keep the gain exactly as given (−0 included).
  const pk = codec.snapshotBands([{ kind: 'PK', freqHz: 1000, gainDb: -0, qFactor: 1 }])[0];
  assert.ok(Object.is(pk.gainDb, -0));
});

test('N2: codec errors never run caller code (no coercion, no toJSON) to format values', () => {
  let calls = 0;
  const trap = {
    [Symbol.toPrimitive]() {
      calls++;
      throw new Error('ran');
    },
    toString() {
      calls++;
      return 'ran';
    },
    valueOf() {
      calls++;
      return 0;
    },
    toJSON() {
      calls++;
      return 'ran';
    },
  };
  const base = peaking(1000, -3, 1);
  for (const field of ['freqHz', 'gainDb', 'qFactor']) {
    assert.throws(() => codec.encodePayload(withNeutral({ ...base, [field]: trap }), -1), {
      name: 'TypeError',
      message: `band 0: ${field} must be a number, got an object`,
    });
  }
  assert.throws(() => codec.checkBand({ ...base, kind: trap }), {
    name: 'TypeError',
    message: 'band 0: unknown filter kind an object',
  });
  assert.throws(() => codec.designSection({ kind: trap }), {
    name: 'TypeError',
    message: 'unknown filter kind an object',
  });
  assert.throws(() => codec.preampWord(trap), {
    name: 'RangeError',
    message: 'preamp must be a finite dB value, got an object',
  });
  assert.throws(() => codec.encodePayload(codec.NEUTRAL_BANDS, trap), RangeError);
  const payload = codec.encodePayload(codec.NEUTRAL_BANDS, -0.5);
  payload[3] = trap;
  assert.throws(() => codec.reportsFromPayload(payload), {
    message: 'payload byte 3 is not a byte: an object',
  });
  const lying = new Proxy([], {
    get: (target, key) => (key === 'length' ? trap : Reflect.get(target, key)),
  });
  assert.throws(() => codec.snapshotBands(lying), {
    name: 'RangeError',
    message: 'invalid band count an object',
  });
  assert.equal(calls, 0);

  // Every kind of value has a description that needs no conversion.
  const message = (band) => {
    try {
      codec.checkBand({ ...base, ...band });
    } catch (error) {
      return error.message;
    }
    return 'accepted';
  };
  assert.equal(message({ freqHz: () => 1 }), 'band 0: freqHz must be a number, got a function');
  const symbolQ = message({ qFactor: Symbol('q') });
  assert.equal(symbolQ, 'band 0: qFactor must be a number, got a symbol');
  assert.equal(message({ freqHz: 1n }), 'band 0: freqHz must be in (0, 48000), got 1n');
  assert.equal(message({ freqHz: -0 }), 'band 0: freqHz must be in (0, 48000), got -0');
  assert.equal(message({ freqHz: '1000' }), 'band 0: freqHz must be in (0, 48000), got "1000"');
  assert.equal(message({ qFactor: null }), 'band 0: qFactor must be > 0, got null');
  assert.equal(message({ qFactor: true }), 'band 0: qFactor must be > 0, got true');
  assert.equal(message({ gainDb: undefined }), 'band 0: gainDb must be finite, got undefined');
  assert.equal(
    message({ freqHz: 'x'.repeat(60) }),
    `band 0: freqHz must be in (0, 48000), got "${'x'.repeat(40)}"…`,
  );
  assert.equal(message({}), 'accepted');
  assert.throws(() => codec.designSection({ kind: 2n }), { message: 'unknown filter kind 2n' });
});

test('C1: encodePayload reads each band field once (getter cannot change the bytes)', () => {
  let reads = 0;
  const flipping = {
    kind: 'PK',
    freqHz: 1000,
    qFactor: 1,
    get gainDb() {
      reads += 1;
      return reads === 1 ? -3 : 12;
    },
  };
  const payload = codec.encodePayload(withNeutral(flipping), -1);
  assert.equal(reads, 1);
  assert.deepEqual(payload, codec.encodePayload(withNeutral(peaking(1000, -3, 1)), -1));
});

test('M2: encodePayload never returns a short payload for sparse arrays', () => {
  for (const index of [0, 4, 9]) {
    const sparse = [...codec.NEUTRAL_BANDS];
    delete sparse[index];
    assert.equal(sparse.length, 10);
    assert.throws(() => codec.encodePayload(sparse, 0), {
      name: 'TypeError',
      message: `band ${index}: missing (hole in a sparse array)`,
    });
  }
  assert.throws(() => codec.encodePayload(new Array(10), 0), TypeError);
  assert.throws(() => codec.encodeReports(new Array(10), 0), TypeError);
});

test('reportsFromPayload splits a payload exactly like encodeReports', () => {
  for (const id of presetIds) {
    const { eqBands, preampDb, payload, reports } = fixture.presets[id];
    const split = codec.reportsFromPayload(payload);
    assert.deepEqual(
      split.map((report) => [...report]),
      reports,
      id,
    );
    assert.deepEqual(split, codec.encodeReports(eqBands, preampDb), id);
    assert.deepEqual(codec.reportsFromPayload(Uint8Array.from(payload)), split, id);
  }
});

test('reportsFromPayload refuses wrong sizes, non-bytes and bad CRCs', () => {
  const payload = codec.encodePayload(codec.NEUTRAL_BANDS, -0.5);
  assert.throws(() => codec.reportsFromPayload(payload.slice(0, 200)), {
    name: 'RangeError',
    message: 'payload must be 220 bytes',
  });
  assert.throws(() => codec.reportsFromPayload([...payload, 0]), RangeError);
  assert.throws(() => codec.reportsFromPayload(null), RangeError);
  assert.throws(() => codec.reportsFromPayload('x'.repeat(220)), RangeError);
  for (const bad of [256, -1, 1.5, NaN, '1']) {
    const copy = [...payload];
    copy[17] = bad;
    assert.throws(() => codec.reportsFromPayload(copy), /payload byte 17 is not a byte/);
  }
  const corrupted = [...payload];
  corrupted[20] ^= 1;
  assert.throws(() => codec.reportsFromPayload(corrupted), /payload CRC mismatch/);
});
