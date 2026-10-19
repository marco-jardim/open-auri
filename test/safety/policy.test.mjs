import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  ABS_RANGES,
  AUDIBLE_MAX_HZ,
  boundarySearch,
  clampToAbs,
  EXPERIMENTAL_KINDS,
  freqMaxFor,
  GRID_STEPS,
  interpolateBand,
  interpolateLinear,
  isExperimentalKind,
  isKindAllowed,
  isUltrasonic,
  LAYER_KINDS,
  roundToGrid,
  snapToGridAccepted,
  SOFT_RANGES,
  ULTRA_CUT_Q_MAX,
  ULTRA_MAX_HZ,
} from '../../src/safety/policy.mjs';
import { gateForWrite } from '../../src/safety/gate.mjs';
import { NEUTRAL_BANDS } from '../../src/dsp/eq0xcb.mjs';

const OFF = Object.freeze({ kind: 'OFF' });

test('ABS_RANGES stays pinned at 20 Hz–20 kHz; the ultrasonic ceiling is separate', () => {
  assert.deepEqual(ABS_RANGES, {
    freqHz: { min: 20, max: 20000 },
    gainDb: { min: -24, max: 9.2 },
    qFactor: { min: 0.1, max: 20 },
    boostQMax: 4,
    pkBoostMaxHz: 16000,
  });
  assert.ok(Object.isFrozen(ABS_RANGES) && Object.isFrozen(ABS_RANGES.freqHz));
  assert.equal(AUDIBLE_MAX_HZ, 20000);
  assert.equal(AUDIBLE_MAX_HZ, ABS_RANGES.freqHz.max);
  assert.equal(ULTRA_MAX_HZ, 32000);
  assert.equal(ULTRA_CUT_Q_MAX, 0.71);
  // clampToAbs keeps clamping to 20 kHz, even a cut Engenharia may place higher.
  const cut = { kind: 'PK', freqHz: 25000, gainDb: -3, qFactor: 1 };
  assert.equal(freqMaxFor(cut, { layer: 'engenharia' }), ULTRA_MAX_HZ);
  assert.equal(clampToAbs(cut).freqHz, 20000);
});

test('freqMaxFor: Ouvir/Ajustar 20 kHz; Engenharia 32 kHz for non-amplifying sections; YOLO 32 kHz', () => {
  /** [band, Engenharia maximum without YOLO] */
  const cases = [
    [{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 10 }, ULTRA_MAX_HZ],
    [{ kind: 'PK', freqHz: 1000, gainDb: 0, qFactor: 20 }, ULTRA_MAX_HZ],
    [{ kind: 'PK', freqHz: 1000, gainDb: -0, qFactor: 0.1 }, ULTRA_MAX_HZ],
    [{ kind: 'PK', freqHz: 1000, gainDb: 0.1, qFactor: 1 }, AUDIBLE_MAX_HZ],
    [{ kind: 'LS', freqHz: 1000, gainDb: -3, qFactor: 0.71 }, ULTRA_MAX_HZ],
    [{ kind: 'LS', freqHz: 1000, gainDb: -3, qFactor: 0.72 }, AUDIBLE_MAX_HZ],
    [{ kind: 'LS', freqHz: 1000, gainDb: 1, qFactor: 0.5 }, AUDIBLE_MAX_HZ],
    [{ kind: 'HS', freqHz: 1000, gainDb: 0, qFactor: 0.71 }, ULTRA_MAX_HZ],
    [{ kind: 'HS', freqHz: 1000, gainDb: -6, qFactor: 0.72 }, AUDIBLE_MAX_HZ],
    [{ kind: 'HS', freqHz: 1000, gainDb: 2, qFactor: 0.5 }, AUDIBLE_MAX_HZ],
    [{ kind: 'LP', freqHz: 1000, qFactor: 0.71 }, ULTRA_MAX_HZ],
    [{ kind: 'LP', freqHz: 1000, qFactor: 0.72 }, AUDIBLE_MAX_HZ],
    [{ kind: 'HP', freqHz: 1000, qFactor: 0.5 }, ULTRA_MAX_HZ],
    [{ kind: 'HP', freqHz: 1000, qFactor: 2 }, AUDIBLE_MAX_HZ],
    // NaN-safe: a missing, NaN or non-number gain or Q never qualifies.
    [{ kind: 'PK', freqHz: 1000, gainDb: NaN, qFactor: 1 }, AUDIBLE_MAX_HZ],
    [{ kind: 'PK', freqHz: 1000, qFactor: 1 }, AUDIBLE_MAX_HZ],
    [{ kind: 'LS', freqHz: 1000, gainDb: -3, qFactor: NaN }, AUDIBLE_MAX_HZ],
    [{ kind: 'HS', freqHz: 1000, gainDb: '-3', qFactor: 0.5 }, AUDIBLE_MAX_HZ],
    [{ kind: 'LP', freqHz: 1000, qFactor: '0.5' }, AUDIBLE_MAX_HZ],
    [{ kind: 'HP', freqHz: 1000 }, AUDIBLE_MAX_HZ],
    // Not a section.
    [OFF, AUDIBLE_MAX_HZ],
    [{ kind: 'XX', freqHz: 1000, gainDb: -3, qFactor: 0.5 }, AUDIBLE_MAX_HZ],
    [null, AUDIBLE_MAX_HZ],
    ['PK', AUDIBLE_MAX_HZ],
  ];
  for (const [band, engenharia] of cases) {
    const label = JSON.stringify(band);
    for (const layer of ['ouvir', 'ajustar']) {
      assert.equal(freqMaxFor(band, { layer }), AUDIBLE_MAX_HZ, `${layer} ${label}`);
      // Modo YOLO exists only in Engenharia.
      assert.equal(freqMaxFor(band, { layer, yolo: true }), AUDIBLE_MAX_HZ, `${layer} ${label}`);
    }
    assert.equal(freqMaxFor(band, { layer: 'engenharia' }), engenharia, label);
    assert.equal(freqMaxFor(band, { layer: 'engenharia', yolo: false }), engenharia, label);
    assert.equal(freqMaxFor(band, { layer: 'engenharia', yolo: true }), ULTRA_MAX_HZ, label);
    // Only yolo === true; unknown layers allow nothing above 20 kHz.
    assert.equal(freqMaxFor(band, { layer: 'engenharia', yolo: 1 }), engenharia, label);
    assert.equal(freqMaxFor(band, { layer: 'unknown', yolo: true }), AUDIBLE_MAX_HZ, label);
    assert.equal(freqMaxFor(band, {}), AUDIBLE_MAX_HZ, label);
    assert.equal(freqMaxFor(band), AUDIBLE_MAX_HZ, label);
  }
  // The answer depends on kind, gain and Q only, never on where the band is now.
  for (const freqHz of [20, 20000, 25000, 32000, 40000]) {
    assert.equal(
      freqMaxFor({ kind: 'PK', freqHz, gainDb: -1, qFactor: 1 }, { layer: 'engenharia' }),
      ULTRA_MAX_HZ,
    );
  }
});

test('isUltrasonic: a filter section above 20 kHz; NaN-safe; never OFF or a non-section', () => {
  for (const kind of ['PK', 'LS', 'HS', 'LP', 'HP']) {
    const at = (freqHz) => isUltrasonic({ kind, freqHz, gainDb: -3, qFactor: 0.7 });
    assert.equal(at(1000), false, kind);
    assert.equal(at(20000), false, kind);
    assert.equal(at(20000.5), true, kind);
    assert.equal(at(20001), true, kind);
    assert.equal(at(ULTRA_MAX_HZ), true, kind);
    assert.equal(at(-Infinity), false, kind);
    // Like the gate's D7 checks: a frequency that is not a number <= 20 kHz counts as above.
    for (const freqHz of [NaN, Infinity, undefined, null, '1000', 1000n]) {
      assert.equal(at(freqHz), true, `${kind} ${String(freqHz)}`);
    }
  }
  assert.equal(isUltrasonic({ kind: 'OFF' }), false);
  assert.equal(isUltrasonic({ kind: 'OFF', freqHz: 30000 }), false);
  assert.equal(isUltrasonic({ kind: 'XX', freqHz: 30000 }), false);
  assert.equal(isUltrasonic({ freqHz: 30000 }), false);
  for (const value of [null, undefined, 30000, 'PK', true]) {
    assert.equal(isUltrasonic(value), false, String(value));
  }
  // Pure: nothing is coerced or changed.
  let calls = 0;
  const trap = {
    valueOf() {
      calls++;
      return 1000;
    },
  };
  const band = Object.freeze({ kind: 'PK', freqHz: trap, gainDb: -3, qFactor: 1 });
  assert.equal(isUltrasonic(band), true);
  const trapGain = { kind: 'PK', freqHz: 1000, gainDb: trap, qFactor: 1 };
  assert.equal(freqMaxFor(trapGain, { layer: 'engenharia' }), AUDIBLE_MAX_HZ);
  assert.equal(calls, 0);
});

test('soft ranges match the plan (§3.3)', () => {
  const r = (min, max) => ({ min, max });
  assert.deepEqual(SOFT_RANGES, {
    'PK-main': { kind: 'PK', freqHz: r(150, 20000), gainDb: r(-24, 6), qFactor: r(1, 2) },
    'PK-narrow': { kind: 'PK', freqHz: r(300, 20000), gainDb: r(-24, 9), qFactor: r(2, 4) },
    LS: { kind: 'LS', freqHz: r(80, 1000), gainDb: r(-24, 6), qFactor: r(0.5, 0.7) },
    'HS-cut': { kind: 'HS', freqHz: r(80, 20000), gainDb: r(-24, 0), qFactor: r(0.5, 0.7) },
    'HS-boost': { kind: 'HS', freqHz: r(8000, 20000), gainDb: r(-24, 2), qFactor: r(0.5, 0.7) },
    LP: { kind: 'LP', freqHz: r(30, 20000), qFactor: r(0.5, 0.7) },
    HP: { kind: 'HP', freqHz: r(50, 20000), qFactor: r(0.5, 0.7) },
  });
  assert.ok(Object.isFrozen(SOFT_RANGES) && Object.isFrozen(SOFT_RANGES.LS.freqHz));
  assert.deepEqual(ABS_RANGES, {
    freqHz: r(20, 20000),
    gainDb: r(-24, 9.2),
    qFactor: r(0.1, 20),
    boostQMax: 4,
    pkBoostMaxHz: 16000,
  });
  assert.deepEqual(GRID_STEPS, { gainDb: 0.1, freqHz: 1, qFactor: 0.01 });
});

test('soft-range corners pass the gate with a single section (experimental kinds included)', () => {
  for (const [id, box] of Object.entries(SOFT_RANGES)) {
    const gains = box.gainDb ? [box.gainDb.min, box.gainDb.max] : [undefined];
    for (const freqHz of [box.freqHz.min, box.freqHz.max]) {
      for (const qFactor of [box.qFactor.min, box.qFactor.max]) {
        for (const gainDb of gains) {
          // PK boosts above 16 kHz are D7 violations even inside the box.
          if (box.kind === 'PK' && gainDb > 0 && freqHz > 16000) continue;
          const gain = gainDb === undefined ? {} : { gainDb };
          const band = { kind: box.kind, freqHz, qFactor, ...gain };
          const bands = [band, ...NEUTRAL_BANDS.slice(1)];
          const result = gateForWrite(bands, -12, { experimental: true });
          assert.ok(result.ok, `${id} ${JSON.stringify(band)} ${JSON.stringify(result.reasons)}`);
        }
      }
    }
  }
});

test('layer kinds', () => {
  for (const layer of ['ouvir', 'ajustar']) {
    assert.deepEqual([...LAYER_KINDS[layer]], ['PK', 'LS', 'OFF']);
    for (const kind of ['PK', 'LS', 'OFF']) assert.ok(isKindAllowed(kind, layer));
    for (const kind of ['HS', 'LP', 'HP', 'XX', undefined]) assert.ok(!isKindAllowed(kind, layer));
  }
  for (const kind of ['PK', 'LS', 'OFF', 'HS', 'LP', 'HP']) {
    assert.ok(isKindAllowed(kind, 'engenharia'));
  }
  assert.ok(!isKindAllowed('XX', 'engenharia'));
  assert.ok(!isKindAllowed('PK', 'toString'));
  assert.ok(!isKindAllowed('PK', 'unknown'));
  assert.deepEqual([...EXPERIMENTAL_KINDS], ['HS', 'LP', 'HP']);
  for (const kind of ['HS', 'LP', 'HP']) assert.ok(isExperimentalKind(kind));
  for (const kind of ['PK', 'LS', 'OFF', 'XX', null]) assert.ok(!isExperimentalKind(kind));
});

test('roundToGrid: gain 0.1 dB, f 1 Hz, Q 0.01; OFF unchanged; pure', () => {
  const band = { kind: 'PK', freqHz: 1234.56, gainDb: -3.04999, qFactor: 0.7071 };
  assert.deepEqual(roundToGrid(band), { kind: 'PK', freqHz: 1235, gainDb: -3, qFactor: 0.71 });
  assert.deepEqual(band, { kind: 'PK', freqHz: 1234.56, gainDb: -3.04999, qFactor: 0.7071 });
  assert.equal(roundToGrid(OFF), OFF);
  assert.equal(roundToGrid(null), null);
  assert.deepEqual(roundToGrid({ kind: 'LP', freqHz: 99.5, qFactor: 0.555 }), {
    kind: 'LP',
    freqHz: 100,
    qFactor: 0.56,
  });
  assert.ok(Object.is(roundToGrid({ kind: 'PK', freqHz: 1, gainDb: -0.04, qFactor: 1 }).gainDb, 0));
  assert.ok(Number.isNaN(roundToGrid({ kind: 'PK', freqHz: NaN, gainDb: 0, qFactor: 1 }).freqHz));
  assert.equal(roundToGrid({ kind: 'PK', freqHz: 100, gainDb: 0.3, qFactor: 1 }).gainDb, 0.3);
});

test('clampToAbs: absolute ranges and D7', () => {
  assert.deepEqual(clampToAbs({ kind: 'PK', freqHz: 10, gainDb: -30, qFactor: 0.01 }), {
    kind: 'PK',
    freqHz: 20,
    gainDb: -24,
    qFactor: 0.1,
  });
  assert.deepEqual(clampToAbs({ kind: 'PK', freqHz: 19000, gainDb: 12, qFactor: 10 }), {
    kind: 'PK',
    freqHz: 16000,
    gainDb: 9.2,
    qFactor: 4,
  });
  assert.deepEqual(clampToAbs({ kind: 'LS', freqHz: 19000, gainDb: 3, qFactor: 10 }), {
    kind: 'LS',
    freqHz: 19000,
    gainDb: 3,
    qFactor: 4,
  });
  assert.deepEqual(clampToAbs({ kind: 'PK', freqHz: 30000, gainDb: -3, qFactor: 30 }), {
    kind: 'PK',
    freqHz: 20000,
    gainDb: -3,
    qFactor: 20,
  });
  assert.deepEqual(clampToAbs({ kind: 'HP', freqHz: 5, qFactor: 50 }), {
    kind: 'HP',
    freqHz: 20,
    qFactor: 20,
  });
  const inRange = { kind: 'PK', freqHz: 1000, gainDb: 3, qFactor: 2 };
  assert.deepEqual(clampToAbs(inRange), inRange);
  assert.notEqual(clampToAbs(inRange), inRange);
  assert.equal(clampToAbs(OFF), OFF);
  assert.equal(clampToAbs(null), null);
  const weird = clampToAbs({ kind: 'PK', freqHz: Infinity, gainDb: NaN, qFactor: -Infinity });
  assert.equal(weird.freqHz, Infinity);
  assert.ok(Number.isNaN(weird.gainDb));
  assert.equal(weird.qFactor, -Infinity);
  assert.ok(Object.is(clampToAbs({ kind: 'PK', freqHz: 100, gainDb: -0, qFactor: 1 }).gainDb, 0));
  const tinyBoost = clampToAbs({ kind: 'PK', freqHz: 100, gainDb: 5e-324, qFactor: 9 });
  assert.equal(tinyBoost.qFactor, 4);
});

test('interpolation helpers', () => {
  assert.equal(interpolateLinear(0, 10, 0.25), 2.5);
  const mixed = interpolateLinear([0, 'a', { x: 2 }], [4, 'b', { x: 4 }], 0.5);
  assert.deepEqual(mixed, [2, 'a', { x: 3 }]);
  assert.equal(interpolateLinear('a', 'b', 0.5), 'a');
  assert.equal(interpolateLinear(null, { x: 1 }, 0.5), null);
  const band = interpolateBand(
    { kind: 'PK', freqHz: 100, gainDb: 0, qFactor: 1 },
    { kind: 'PK', freqHz: 10000, gainDb: 6, qFactor: 4 },
    0.5,
  );
  assert.equal(band.kind, 'PK');
  assert.equal(band.gainDb, 3);
  assert.ok(Math.abs(band.freqHz - 1000) < 1e-9);
  assert.ok(Math.abs(band.qFactor - 2) < 1e-12);
  const linear = interpolateBand(
    { kind: 'PK', freqHz: 0, gainDb: 0, qFactor: 1 },
    { kind: 'PK', freqHz: 100, gainDb: 0, qFactor: 1 },
    0.5,
  );
  assert.equal(linear.freqHz, 50);
});

test('boundarySearch: precondition, endpoints, result always accepted', () => {
  assert.throws(() => boundarySearch(5, 0, (x) => x < 1), RangeError);
  assert.equal(
    boundarySearch(0, 5, () => true),
    5,
  );
  assert.equal(
    boundarySearch(0, 1, (x) => x === 0),
    0,
  );
  const result = boundarySearch(0, 1, (x) => x <= 0.3);
  assert.ok(result <= 0.3 && 0.3 - result <= 2 ** -24);
  const custom = boundarySearch(1, 2, (x) => x <= 1.5, {
    iterations: 4,
    interpolate: (a, b, t) => a + (b - a) * t * t,
  });
  assert.ok(custom <= 1.5 && custom >= 1.4);
});

test('property: boundarySearch is monotone and its result is always accepted', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.integer({ min: 0, max: 30 }),
      (a, b, iterations) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        const lowResult = boundarySearch(0, 1, (x) => x <= low, { iterations });
        const highResult = boundarySearch(0, 1, (x) => x <= high, { iterations });
        assert.ok(lowResult <= low && highResult <= high);
        assert.ok(lowResult <= highResult);
        if (low < 1) assert.ok(low - lowResult <= 2 ** -iterations);
        const more = boundarySearch(0, 1, (x) => x <= low, { iterations: iterations + 1 });
        assert.ok(more >= lowResult);
      },
    ),
    { numRuns: 300, seed: 1 },
  );
});

test('property: boundarySearch on a gate predicate stops on an accepted band', () => {
  const from = { kind: 'PK', freqHz: 1000, gainDb: 3, qFactor: 2 };
  const curve = (band) => [band, ...NEUTRAL_BANDS.slice(1)];
  const accepted = (band) => gateForWrite(curve(band), -10).ok;
  fc.assert(
    fc.property(
      fc.record({
        freqHz: fc.double({ min: Math.log(20), max: Math.log(20000), noNaN: true }).map(Math.exp),
        gainDb: fc.double({ min: -24, max: 15, noNaN: true }),
        qFactor: fc.double({ min: Math.log(0.1), max: Math.log(20), noNaN: true }).map(Math.exp),
      }),
      (target) => {
        const to = { kind: 'PK', ...target };
        const options = { iterations: 12, interpolate: interpolateBand };
        const edge = boundarySearch(from, to, accepted, options);
        assert.ok(accepted(edge));
        const snapped = snapToGridAccepted(edge, from, accepted);
        assert.ok(accepted(snapped));
      },
    ),
    { numRuns: 25, seed: 3 },
  );
});

test('snapToGridAccepted: rounds, then steps back toward the accepted state', () => {
  const from = { kind: 'PK', freqHz: 1000, gainDb: 0, qFactor: 1 };
  // Accepted iff gain <= 2.04: rounding 2.04 up to 2.0 is fine.
  assert.deepEqual(
    snapToGridAccepted({ ...from, gainDb: 2.04 }, from, (b) => b.gainDb <= 2.04),
    { ...from, gainDb: 2 },
  );
  // Accepted iff gain <= 2.06: 2.06 rounds to 2.1 (refused), one step back is 2.0.
  assert.deepEqual(
    snapToGridAccepted({ ...from, gainDb: 2.06, freqHz: 1000.4 }, from, (b) => b.gainDb <= 2.06),
    { ...from, gainDb: 2 },
  );
  // Several parameters step together toward `from`.
  const stepped = snapToGridAccepted(
    { kind: 'PK', freqHz: 1010, gainDb: 1, qFactor: 1.5 },
    from,
    (b) => b.freqHz <= 1007,
  );
  assert.deepEqual(stepped, { kind: 'PK', freqHz: 1007, gainDb: 0.7, qFactor: 1.47 });
  // Nothing on the way is accepted: falls back to `from`.
  const strict = (b) => b === from;
  assert.equal(snapToGridAccepted({ ...from, gainDb: 0.5 }, from, strict), from);
  // Bounded loop.
  let calls = 0;
  const never = () => {
    calls++;
    return false;
  };
  assert.equal(snapToGridAccepted({ ...from, freqHz: 20000 }, from, never, { maxSteps: 5 }), from);
  assert.equal(calls, 6);
  // Non-finite parameters are not stepped.
  assert.equal(
    snapToGridAccepted({ ...from, gainDb: NaN }, from, (b) => b === from),
    from,
  );
});
