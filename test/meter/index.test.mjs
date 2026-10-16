import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as meter from '../../src/meter/index.mjs';
import { FLOOR_DB, amplitudeToDb, flush } from '../../src/meter/common.mjs';

test('meter index re-exports every factory and the shared floor', () => {
  for (const name of [
    'createVuMeter',
    'createPpmMeter',
    'createTruePeakMeter',
    'createLoudnessMeter',
    'createCorrelationMeter',
  ]) {
    assert.equal(typeof meter[name], 'function', name);
  }
  assert.equal(meter.FLOOR_DB, -120);
});

test('shared helpers clamp to the floor and flush subnormal-range values', () => {
  assert.equal(amplitudeToDb(0), FLOOR_DB);
  assert.equal(amplitudeToDb(-1), FLOOR_DB);
  assert.equal(amplitudeToDb(Number.NaN), FLOOR_DB);
  assert.equal(amplitudeToDb(1), 0);
  assert.equal(flush(1e-31), 0);
  assert.equal(flush(-1e-31), 0);
  assert.equal(flush(1e-20), 1e-20);
});
