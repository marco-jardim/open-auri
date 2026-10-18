import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import fc from 'fast-check';
import { classifierVersionInput, classifyCurve } from '../../src/safety/classify.mjs';
import { classifyWith } from '../../src/safety/classify-core.mjs';
import { gateForWrite, isWaivable, YOLO_WAIVABLE } from '../../src/safety/gate.mjs';
import { THRESHOLDS, YOLO_THRESHOLDS } from '../../src/safety/thresholds.mjs';
import { NEUTRAL_BANDS } from '../../src/dsp/eq0xcb.mjs';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);
const presets = Object.entries(fixture.presets);

const OFF = Object.freeze({ kind: 'OFF' });
const PK = (freqHz, gainDb, qFactor) => ({ kind: 'PK', freqHz, gainDb, qFactor });
/** `bands` followed by OFF up to 10 stages. */
const curveOf = (...bands) => [...bands, ...Array.from({ length: 10 - bands.length }, () => OFF)];
const codes = (result) => result.reasons.map((r) => r.code);
const STANDARD = Object.freeze({ class: 'standard', waived: [], reasons: [] });
/** Codes the classification waives: the YOLO profile's class 2 without the kind check. */
const CLASS_WAIVABLE = YOLO_WAIVABLE.filter((code) => code !== 'k:kind-not-allowed');
/** Class-1 codes only the YOLO profile computes. */
const YOLO_ONLY = new Set(['d:prefix-peak-full', 'd:prefix-peak-extended', 'e:output-extended']);
/** design/analysis/limites-v2.md:40: fails only c:section-peak in the standard profile. */
const LIMITES_40 = Object.freeze({ bands: curveOf(PK(1000, 12, 4)), preampDb: -12.6 });
/** An HS cut, within every limit: experimental only. */
const HS_CUT = curveOf({ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 });

/** `gateForWrite` that records every call (its arguments and its result). */
function countingGate() {
  /** @type {{bands: unknown, preampDb: number, options: object, result: object}[]} */
  const calls = [];
  const write = (bands, preampDb, options) => {
    const result = gateForWrite(bands, preampDb, options);
    calls.push({ bands, preampDb, options: { ...options }, result });
    return result;
  };
  return { calls, write };
}

test('the 11 official presets are standard', () => {
  assert.equal(presets.length, 11);
  for (const [id, preset] of presets) {
    assert.deepEqual(classifyCurve(preset.eqBands, preset.preampDb), STANDARD, id);
    assert.deepEqual(
      classifyCurve(preset.eqBands, preset.preampDb, { experimental: true }),
      STANDARD,
      id,
    );
  }
  assert.deepEqual(classifyCurve(NEUTRAL_BANDS, -0.5), STANDARD);
});

test('a curve that only fails c:section-peak is yolo, waiving exactly that', () => {
  const { bands, preampDb } = LIMITES_40;
  assert.deepEqual(codes(gateForWrite(bands, preampDb)), ['c:section-peak']);
  assert.deepEqual(classifyCurve(bands, preampDb), {
    class: 'yolo',
    waived: ['c:section-peak'],
    reasons: [],
  });
  // Two runs: standard, then YOLO on the first run's frozen snapshot.
  const { calls, write } = countingGate();
  assert.deepEqual(classifyWith(write, bands, preampDb, false), classifyCurve(bands, preampDb));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options, { experimental: false });
  assert.deepEqual(calls[1].options, { experimental: false, profile: 'yolo' });
  assert.equal(calls[1].bands, calls[0].result.metrics.bands);
  assert.ok(Object.isFrozen(calls[1].bands));
});

test('a curve failing a class-1 reason is rejected without a YOLO run', () => {
  const cases = [
    // [label, bands, preampDb, the standard codes that block]
    ['feedback and pole', curveOf(PK(20, -12, 20)), -1, ['a:-a1', 'a:-a2', 'b:pole-radius']],
    ['codec', curveOf(), 0.5, ['f:codec']],
    ['not an array', 'nope', -1, ['f:codec']],
    ['d and e', curveOf(PK(1000, 6, 1)), -0.5, ['d:prefix-peak', 'e:output-audible']],
  ];
  for (const [label, bands, preampDb, blocking] of cases) {
    const { calls, write } = countingGate();
    const result = classifyWith(write, bands, preampDb, false);
    assert.equal(result.class, 'rejected', label);
    assert.deepEqual(result.waived, [], label);
    for (const code of blocking) assert.ok(result.reasons.includes(code), `${label}: ${code}`);
    // Only the standard run: its blocking codes, once each, in reason order.
    assert.equal(calls.length, 1, label);
    assert.equal(calls[0].options.profile, undefined, label);
    const standard = calls[0].result;
    assert.deepEqual(
      result.reasons,
      [...new Set(codes(standard).filter((code) => !CLASS_WAIVABLE.includes(code)))],
      label,
    );
    // The YOLO profile refuses it as well: the shortcut changes nothing.
    assert.equal(gateForWrite(bands, preampDb, { profile: 'yolo' }).ok, false, label);
    assert.deepEqual(classifyCurve(bands, preampDb), result, label);
  }
  // A standard pass needs one run too.
  const { calls, write } = countingGate();
  assert.deepEqual(classifyWith(write, NEUTRAL_BANDS, -0.5, false), STANDARD);
  assert.equal(calls.length, 1);
});

test('HS/LP/HP: rejected on k without experimental, standard with it', () => {
  const rejected = { class: 'rejected', waived: [], reasons: ['k:kind-not-allowed'] };
  // The YOLO gate would waive the kind; the classification never does.
  assert.equal(gateForWrite(HS_CUT, -1, { profile: 'yolo' }).ok, true);
  assert.deepEqual(classifyCurve(HS_CUT, -1), rejected);
  assert.deepEqual(classifyCurve(HS_CUT, -1, { experimental: false }), rejected);
  assert.deepEqual(classifyCurve(HS_CUT, -1, { experimental: true }), STANDARD);
  const { calls, write } = countingGate();
  assert.deepEqual(classifyWith(write, HS_CUT, -1, false), rejected);
  assert.equal(calls.length, 1);
  for (const band of [
    { kind: 'LP', freqHz: 18000, qFactor: 0.7 },
    { kind: 'HP', freqHz: 40, qFactor: 0.5 },
  ]) {
    assert.deepEqual(classifyCurve(curveOf(band), -3), rejected, band.kind);
    assert.deepEqual(classifyCurve(curveOf(band), -3, { experimental: true }), STANDARD, band.kind);
  }
  // Experimental, but over a waivable limit: yolo, never k.
  const narrow = curveOf({ kind: 'HS', freqHz: 12000, gainDb: 1, qFactor: 5 });
  assert.deepEqual(classifyCurve(narrow, -10, { experimental: true }), {
    class: 'yolo',
    waived: ['d7:boost-q'],
    reasons: [],
  });
});

test('the preamp: −25.5 dB is the floor (S1), even where the YOLO gate goes lower', () => {
  assert.deepEqual(classifyCurve(NEUTRAL_BANDS, -25.5), STANDARD);
  // Below the floor: g:preamp blocks, without a YOLO run, though YOLO alone would accept it.
  assert.equal(gateForWrite(NEUTRAL_BANDS, -26, { profile: 'yolo' }).ok, true);
  const { calls, write } = countingGate();
  const low = { class: 'rejected', waived: [], reasons: ['g:preamp'] };
  assert.deepEqual(classifyWith(write, NEUTRAL_BANDS, -26, false), low);
  assert.equal(calls.length, 1);
  assert.deepEqual(classifyCurve(NEUTRAL_BANDS, -26), low);
  assert.deepEqual(classifyCurve(LIMITES_40.bands, -30), low);
  // Above the standard range (and below every other limit) it is waived.
  assert.deepEqual(classifyCurve(NEUTRAL_BANDS, -0.48), {
    class: 'yolo',
    waived: ['g:preamp'],
    reasons: [],
  });
});

test('above 20 kHz: cuts are standard, boosts yolo within the extended envelope', () => {
  const opts = { experimental: true };
  // An HS cut at 25 kHz (Engenharia, experimental).
  const hsCut = curveOf({ kind: 'HS', freqHz: 25000, gainDb: -6, qFactor: 0.7 });
  assert.deepEqual(classifyCurve(hsCut, -1, opts), STANDARD);
  // An LS cut at 25 kHz with Q 0.72 breaks the rule: waived in YOLO.
  const lsQ = curveOf({ kind: 'LS', freqHz: 25000, gainDb: -3, qFactor: 0.72 });
  assert.deepEqual(classifyCurve(lsQ, -6), {
    class: 'yolo',
    waived: ['d7:boost-above-20k'],
    reasons: [],
  });
  // +3 dB at 30 kHz: rejected by the extended checks at −3 dB, yolo at −3.5 dB.
  const boost = curveOf(PK(30000, 3, 4));
  assert.deepEqual(classifyCurve(boost, -3), {
    class: 'rejected',
    waived: [],
    reasons: ['d:prefix-peak-extended', 'e:output-extended'],
  });
  assert.deepEqual(classifyCurve(boost, -3.5), {
    class: 'yolo',
    waived: ['d7:pk-boost-above-16k', 'd7:boost-above-20k'],
    reasons: [],
  });
});

/**
 * Reference without the shortcut: always runs both profiles (on the caller's
 * plain bands) and classifies from the YOLO run.
 */
function bothProfiles(bands, preampDb, experimental) {
  const standard = gateForWrite(bands, preampDb, { experimental });
  const yolo = gateForWrite(bands, preampDb, { experimental, profile: 'yolo' });
  const blocks = (r) =>
    !CLASS_WAIVABLE.includes(r.code) ||
    (r.code === 'g:preamp' && !(r.value >= THRESHOLDS.preampMinDb));
  const all = [...yolo.reasons, ...yolo.waivedReasons];
  const blocking = [...new Set(all.filter(blocks).map((r) => r.code))];
  const shortcut = standard.reasons.some(blocks);
  if (standard.ok) return { class: 'standard', waived: [], blocking: [], shortcut };
  if (blocking.length) return { class: 'rejected', waived: [], blocking, shortcut };
  return { class: 'yolo', waived: yolo.waived, blocking: [], shortcut };
}

test('property: the shortcut gives what running both profiles gives', (t) => {
  // Every class on known curves first, then random ones.
  const known = [
    ...presets.map(([, p]) => [p.eqBands, p.preampDb, false]),
    [LIMITES_40.bands, LIMITES_40.preampDb, false],
    [HS_CUT, -1, false],
    [HS_CUT, -1, true],
    [NEUTRAL_BANDS, -26, false],
    [NEUTRAL_BANDS, -0.48, false],
    [curveOf(PK(20, -12, 20)), -1, false],
    [curveOf(PK(30000, 3, 4)), -3, false],
    [curveOf(PK(30000, 3, 4)), -3.5, false],
    [curveOf(PK(30000, 3, 4), PK(30000, -3, 4)), -3, false],
  ];
  const freqHz = fc.oneof(
    fc
      .double({ min: Math.log(20), max: Math.log(32000), noNaN: true })
      .map((x) => Math.min(32000, Math.exp(x))),
    fc.constantFrom(1000, 16001, 20000, 25000, 30000),
  );
  const band = fc.oneof(
    { weight: 5, arbitrary: fc.constant(OFF) },
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constantFrom('PK', 'LS', 'HS'),
        freqHz,
        gainDb: fc.double({ min: -12, max: 9, noNaN: true }),
        qFactor: fc.double({ min: 0.3, max: 6, noNaN: true }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constantFrom('LP', 'HP'),
        freqHz,
        qFactor: fc.double({ min: 0.3, max: 3, noNaN: true }),
      }),
    },
  );
  const preampDb = fc.oneof(
    fc.integer({ min: -250, max: -5 }).map((tenths) => tenths / 10),
    fc.constantFrom(-30, -26, -25.5, -12.6, -3.5, -0.48, 0),
  );
  const seen = { standard: 0, yolo: 0, rejected: 0, shortcut: 0 };
  /** Asserts the classification of one curve; returns its class. */
  const check = (bands, preamp, experimental) => {
    const mine = classifyCurve(bands, preamp, { experimental });
    const reference = bothProfiles(bands, preamp, experimental);
    assert.equal(mine.class, reference.class);
    assert.deepEqual(mine.waived, reference.waived);
    if (mine.class !== 'rejected') {
      assert.deepEqual(mine.reasons, []);
    } else if (reference.shortcut) {
      // Without the YOLO run, only the YOLO-only codes are missing.
      const expected = reference.blocking.filter((code) => !YOLO_ONLY.has(code));
      assert.deepEqual([...mine.reasons].sort(), [...expected].sort());
    } else {
      assert.deepEqual(mine.reasons, reference.blocking);
    }
    // The injected-gate core is the same function.
    assert.deepEqual(classifyWith(gateForWrite, bands, preamp, experimental), mine);
    seen[mine.class]++;
    if (reference.shortcut) seen.shortcut++;
    return mine.class;
  };
  const knownClasses = new Set(known.map((args) => check(...args)));
  assert.deepEqual([...knownClasses].sort(), ['rejected', 'standard', 'yolo']);
  fc.assert(
    fc.property(
      fc.array(band, { minLength: 10, maxLength: 10 }),
      preampDb,
      fc.boolean(),
      (bands, preamp, experimental) => {
        check(bands, preamp, experimental);
      },
    ),
    { numRuns: 150, seed: 20261018 },
  );
  assert.ok(seen.shortcut > 0 && seen.rejected > seen.shortcut, JSON.stringify(seen));
  t.diagnostic(`classes: ${JSON.stringify(seen)}`);
});

test('options: only an own experimental data property equal to true; getters never run', () => {
  let calls = 0;
  const coercible = {
    valueOf() {
      calls++;
      return true;
    },
    toString() {
      calls++;
      return 'true';
    },
    [Symbol.toPrimitive]() {
      calls++;
      return true;
    },
  };
  const getter = Object.defineProperty({}, 'experimental', {
    enumerable: true,
    get() {
      calls++;
      return true;
    },
  });
  const throwingTrap = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw coercible;
      },
    },
  );
  const rejected = { class: 'rejected', waived: [], reasons: ['k:kind-not-allowed'] };
  for (const options of [
    getter,
    Object.create({ experimental: true }),
    { experimental: 1 },
    { experimental: 'true' },
    { experimental: Object(true) },
    { experimental: coercible },
    { experimental: [true] },
    throwingTrap,
    null,
    undefined,
    true,
    'experimental',
    () => true,
  ]) {
    assert.deepEqual(classifyCurve(HS_CUT, -1, options), rejected);
  }
  assert.equal(calls, 0);
  assert.deepEqual(classifyCurve(HS_CUT, -1, Object.freeze({ experimental: true })), STANDARD);
  // No profile option, and always the full grid: every other option is ignored.
  const { bands, preampDb } = LIMITES_40;
  const yolo = classifyCurve(bands, preampDb);
  for (const options of [
    { profile: 'yolo' },
    { profile: 'standard' },
    { grid: 'drag' },
    { profile: 'yolo', grid: 'drag', storable: true },
  ]) {
    assert.deepEqual(classifyCurve(bands, preampDb, options), yolo);
    assert.deepEqual(classifyCurve(HS_CUT, -1, options), rejected);
  }
});

test('bands: each field read once; the YOLO run judges that snapshot', () => {
  let reads = 0;
  // +12 dB on the first read (c:section-peak only), a −1 dB cut afterwards.
  const band = {
    kind: 'PK',
    freqHz: 1000,
    qFactor: 4,
    get gainDb() {
      reads++;
      return reads === 1 ? 12 : -1;
    },
  };
  assert.deepEqual(classifyCurve(curveOf(band), -12.6), {
    class: 'yolo',
    waived: ['c:section-peak'],
    reasons: [],
  });
  assert.equal(reads, 1);
  // A throwing getter is a codec refusal, never an exception.
  const throwing = {
    kind: 'PK',
    freqHz: 1000,
    qFactor: 1,
    get gainDb() {
      throw new Error('boom');
    },
  };
  assert.deepEqual(classifyCurve(curveOf(throwing), -1), {
    class: 'rejected',
    waived: [],
    reasons: ['f:codec'],
  });
});

test('classifyCurve is pure: inputs untouched, same answer, fresh results', () => {
  const cases = [
    [presets[0][1].eqBands, presets[0][1].preampDb, undefined],
    [LIMITES_40.bands, LIMITES_40.preampDb, undefined],
    [HS_CUT, -1, { experimental: true }],
    [HS_CUT, -1, { experimental: false }],
    [curveOf(PK(30000, 3, 4)), -3, undefined],
  ];
  for (const [bands, preampDb, options] of cases) {
    const before = structuredClone({ bands, options });
    const first = classifyCurve(bands, preampDb, options);
    const second = classifyCurve(bands, preampDb, options);
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first.waived, second.waived);
    assert.notEqual(first.reasons, second.reasons);
    assert.deepEqual(Object.keys(first), ['class', 'waived', 'reasons']);
    assert.deepEqual({ bands, options }, before);
    // Changing a result changes nothing for the next call.
    first.waived.push('x:changed');
    first.reasons.push('x:changed');
    assert.deepEqual(classifyCurve(bands, preampDb, options), second);
    // Frozen inputs are fine: nothing is written to them.
    const frozen = Object.freeze(bands.map((b) => Object.freeze({ ...b })));
    assert.deepEqual(classifyCurve(frozen, preampDb, options), second);
  }
});

test('classifierVersionInput: stable JSON of THRESHOLDS, YOLO_THRESHOLDS and the waivable list', () => {
  const text = classifierVersionInput();
  assert.equal(typeof text, 'string');
  assert.equal(classifierVersionInput(), text);
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ['thresholds', 'waivable', 'yoloThresholds']);
  assert.deepEqual(parsed.thresholds, JSON.parse(JSON.stringify(THRESHOLDS)));
  assert.deepEqual(parsed.yoloThresholds, JSON.parse(JSON.stringify(YOLO_THRESHOLDS)));
  assert.deepEqual(parsed.waivable, CLASS_WAIVABLE);
  assert.ok(!parsed.waivable.includes('k:kind-not-allowed'));
  for (const code of parsed.waivable) assert.ok(isWaivable(code), code);
  // Keys sorted at every level, no whitespace: the text depends on the data only.
  /** @param {unknown} value */
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  assert.equal(text, canonical(parsed));
  assert.ok(text.startsWith('{"thresholds":{"coefficientAbs":['), text.slice(0, 40));
  assert.ok(text.includes(`"internalExtendedDb":${YOLO_THRESHOLDS.internalExtendedDb}`));
  assert.ok(text.includes(`"outputExtendedDb":${YOLO_THRESHOLDS.outputExtendedDb}`));
});
