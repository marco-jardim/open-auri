import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  fromWords,
  isIdentitySection,
  levelDb,
  MEAN_FREQUENCIES,
  Q27,
  quantizedPreampDb,
  quantizedSection,
  sectionDb,
  sectionDbFromTerms,
} from '../../src/dsp/level.mjs';
import { NEUTRAL_BANDS, SAMPLE_RATE } from '../../src/dsp/eq0xcb.mjs';
import * as reference from '../../design/analysis/gate.mjs';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);
const presets = Object.entries(fixture.presets);

const EXPECTED_LEVELS = {
  padrao: -3.5468069512111837,
  pref6: -3.6576270855430835,
  emv: -9.05022231105811,
  basshead: -5.115161247916879,
  energico: -3.5976145935536734,
  musical: -3.6604119567480673,
  analitico: -3.6599701213599265,
  referencia: -3.6489124878851666,
  harman: -3.645895965641124,
  vdsf: -3.625452216287962,
  etymotic: -3.6239722723245724,
};

test('MEAN_FREQUENCIES: 93 points of the 280-point grid in 300–3000 Hz, as the reference', () => {
  assert.equal(MEAN_FREQUENCIES.length, 93);
  assert.ok(Object.isFrozen(MEAN_FREQUENCIES));
  assert.deepEqual([...MEAN_FREQUENCIES], [...reference.MEAN_FREQUENCIES]);
  assert.ok(MEAN_FREQUENCIES.every((f) => f >= 300 && f <= 3000));
  for (const f of MEAN_FREQUENCIES) assert.equal(Math.round(f * 100) / 100, f);
});

test('levelDb of the 11 presets and Neutro matches the published matrix (|Δ| ≤ 1e-9)', () => {
  assert.equal(presets.length, 11);
  for (const [id, preset] of presets) {
    const level = levelDb(preset.eqBands, preset.preampDb);
    assert.ok(Math.abs(level - EXPECTED_LEVELS[id]) <= 1e-9, `${id}: ${level}`);
    assert.equal(level, reference.levelDb(preset.eqBands, preset.preampDb), id);
  }
  const neutral = levelDb(NEUTRAL_BANDS, -0.5);
  assert.ok(Math.abs(neutral - -0.49999958245018883) <= 1e-9);
  assert.equal(neutral, quantizedPreampDb(-0.5));
});

test('levelDb accepts any number of bands and throws like the codec on invalid input', () => {
  assert.equal(levelDb([], -3), quantizedPreampDb(-3));
  assert.throws(() => levelDb(NEUTRAL_BANDS, 1), RangeError);
  assert.throws(() => levelDb(NEUTRAL_BANDS, NaN), RangeError);
  const nanBand = { kind: 'PK', freqHz: NaN, gainDb: 0, qFactor: 1 };
  assert.throws(() => levelDb([nanBand], -1), RangeError);
  assert.throws(() => levelDb([{ kind: 'XX' }], -1), TypeError);
});

test('M2: levelDb throws a TypeError for holes and non-objects instead of skipping them', () => {
  const sparse = [...NEUTRAL_BANDS];
  delete sparse[2];
  assert.throws(() => levelDb(sparse, -1), {
    name: 'TypeError',
    message: 'band 2: missing (hole in a sparse array)',
  });
  assert.throws(() => levelDb(new Array(1), -1), TypeError);
  assert.throws(() => levelDb([null], -1), { name: 'TypeError', message: 'band 0: not an object' });
  assert.throws(() => levelDb('PK', -1), TypeError);
});

test('levelDb reads each band field once', () => {
  let reads = 0;
  const flipping = {
    kind: 'PK',
    freqHz: 1000,
    qFactor: 1,
    get gainDb() {
      reads += 1;
      return reads === 1 ? -3 : 9;
    },
  };
  const level = levelDb([flipping], -1);
  assert.equal(reads, 1);
  assert.equal(level, levelDb([{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 }], -1));
});

test('fromWords / quantizedSection / identity', () => {
  assert.equal(Q27, 2 ** 27);
  assert.deepEqual(fromWords([Q27, 0, 0, 0, 0]), { b0: 1, b2: 0, a1: -0, b1: 0, a2: -0 });
  const off = quantizedSection({ kind: 'OFF' });
  assert.ok(isIdentitySection(off));
  assert.equal(sectionDb(off, 1000), 0);
  assert.equal(sectionDbFromTerms(off, 1, 1, 1, 1), 0);
  const pk = quantizedSection({ kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 });
  assert.ok(!isIdentitySection(pk));
  const words = [pk.b0, pk.b2, -pk.a1, pk.b1, -pk.a2].map((c) => c * Q27);
  assert.deepEqual(pk, reference.fromWords(words));
});

test('sectionDb is bit-identical to the reference and to sectionDbFromTerms', () => {
  const s = quantizedSection({ kind: 'LS', freqHz: 105, gainDb: 6.5, qFactor: 0.7 });
  for (const f of [0, 1, 20, 105, 1000, 20000, 48000]) {
    assert.equal(sectionDb(s, f), reference.sectionDb(s, f));
    const w = (2 * Math.PI * f) / SAMPLE_RATE;
    const re = 2 * Math.sin(w / 2) ** 2;
    const im = Math.sin(w);
    assert.equal(sectionDbFromTerms(s, re, im, re * re - im * im, 2 * re * im), sectionDb(s, f));
  }
  // Low-shelf DC gain is gainDb, up to Q27 quantization of near-cancelling sums.
  assert.ok(Math.abs(sectionDb(s, 0) - 6.5) < 0.01);
});
