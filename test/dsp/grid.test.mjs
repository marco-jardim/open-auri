import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID, GRID_MAX_HZ, GRID_MIN_HZ, GRID_POINTS, logGrid } from '../../src/dsp/grid.mjs';

test('canonical grid has 481 log-spaced points with exact ends', () => {
  assert.equal(GRID.length, GRID_POINTS);
  assert.equal(GRID[0], GRID_MIN_HZ);
  assert.equal(GRID[GRID.length - 1], GRID_MAX_HZ);
  assert.ok(Object.isFrozen(GRID));
  const step = Math.log(GRID[1] / GRID[0]);
  for (let i = 1; i < GRID.length; i++) {
    assert.ok(GRID[i] > GRID[i - 1]);
    assert.ok(Math.abs(Math.log(GRID[i] / GRID[i - 1]) - step) < 1e-12);
  }
});

test('logGrid accepts custom ranges', () => {
  const grid = logGrid(3, 10, 1000);
  assert.equal(grid.length, 3);
  assert.equal(grid[0], 10);
  assert.equal(grid[2], 1000);
  assert.ok(Math.abs(grid[1] - 100) < 1e-9);
});

test('logGrid rejects invalid arguments', () => {
  assert.throws(() => logGrid(1), RangeError);
  assert.throws(() => logGrid(2.5), RangeError);
  assert.throws(() => logGrid(10, 0, 100), RangeError);
  assert.throws(() => logGrid(10, 100, 100), RangeError);
  assert.throws(() => logGrid(10, 10, Infinity), RangeError);
  assert.throws(() => logGrid(10, Number.NaN, 100), RangeError);
});
