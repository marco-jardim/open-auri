import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIVE_DEBOUNCE_MS,
  LIVE_MAX_WAIT_MS,
  LIVE_MIN_INTERVAL_MS,
  LIVE_MAX_PENDING,
  nextApplyDelay,
  coalesce,
  liveHold,
} from '../../src/policy/live.mjs';
import * as policy from '../../src/policy/index.mjs';

/**
 * @param {Partial<Parameters<typeof nextApplyDelay>[0]>} [overrides]
 * @returns {Parameters<typeof nextApplyDelay>[0]}
 */
function pacing(overrides = {}) {
  return { nowMs: 1000, lastEditMs: 1000, firstPendingEditMs: 1000, ...overrides };
}

test('live pacing constants match the plan and cover one full apply sequence', () => {
  assert.equal(LIVE_DEBOUNCE_MS, 200);
  assert.equal(LIVE_MAX_WAIT_MS, 600);
  assert.equal(LIVE_MIN_INTERVAL_MS, 300);
  assert.equal(LIVE_MAX_PENDING, 1);
  assert.ok(LIVE_MIN_INTERVAL_MS >= 9 * 16 + 150);
  assert.ok(LIVE_DEBOUNCE_MS < LIVE_MAX_WAIT_MS);
});

test('the policy index re-exports the live module', () => {
  assert.equal(policy.nextApplyDelay, nextApplyDelay);
  assert.equal(policy.coalesce, coalesce);
  assert.equal(policy.liveHold, liveHold);
  assert.equal(policy.LIVE_DEBOUNCE_MS, LIVE_DEBOUNCE_MS);
  assert.equal(policy.LIVE_MAX_WAIT_MS, LIVE_MAX_WAIT_MS);
  assert.equal(policy.LIVE_MIN_INTERVAL_MS, LIVE_MIN_INTERVAL_MS);
  assert.equal(policy.LIVE_MAX_PENDING, LIVE_MAX_PENDING);
});

test('a single edit waits the debounce and then applies', () => {
  assert.equal(nextApplyDelay(pacing()), 200);
  assert.equal(nextApplyDelay(pacing({ nowMs: 1150 })), 50);
  assert.equal(nextApplyDelay(pacing({ nowMs: 1199.5 })), 0.5);
  assert.equal(nextApplyDelay(pacing({ nowMs: 1200 })), 0);
  assert.equal(nextApplyDelay(pacing({ nowMs: 5000 })), 0);
});

test('a newer edit restarts the debounce', () => {
  assert.equal(nextApplyDelay(pacing({ nowMs: 1100, lastEditMs: 1100 })), 200);
  assert.equal(nextApplyDelay(pacing({ nowMs: 1250, lastEditMs: 1100 })), 50);
});

test('continuous edits are capped by max-wait from the first pending edit', () => {
  for (let t = 1000; t <= 1600; t += 50) {
    const delay = nextApplyDelay(pacing({ nowMs: t, lastEditMs: t }));
    assert.equal(delay, Math.min(LIVE_DEBOUNCE_MS, 1600 - t), `edit at ${t}`);
    assert.ok(t + delay <= 1000 + LIVE_MAX_WAIT_MS);
  }
  assert.equal(nextApplyDelay(pacing({ nowMs: 1450, lastEditMs: 1450 })), 150);
  assert.equal(nextApplyDelay(pacing({ nowMs: 1600, lastEditMs: 1600 })), 0);
  assert.equal(nextApplyDelay(pacing({ nowMs: 2000, lastEditMs: 2000 })), 0);
});

test('applies are spaced at least the minimum interval apart, start to start', () => {
  const edit = { lastEditMs: 1050, firstPendingEditMs: 1050, lastApplyStartMs: 1000 };
  assert.equal(nextApplyDelay(pacing({ ...edit, nowMs: 1050 })), 250);
  assert.equal(nextApplyDelay(pacing({ ...edit, nowMs: 1250 })), 50);
  assert.equal(nextApplyDelay(pacing({ ...edit, nowMs: 1300 })), 0);
  // The interval also overrides an expired max-wait.
  assert.equal(
    nextApplyDelay({ nowMs: 1600, lastEditMs: 1600, firstPendingEditMs: 1000, lastApplyStartMs: 1500 }),
    200,
  );
  // An old apply does not delay a debounced edit.
  assert.equal(nextApplyDelay(pacing({ nowMs: 1200, lastApplyStartMs: 0 })), 0);
});

test('no previous apply, null or omitted, imposes no interval', () => {
  for (const lastApplyStartMs of [null, undefined]) {
    assert.equal(nextApplyDelay(pacing({ nowMs: 1200, lastApplyStartMs })), 0);
  }
  assert.equal(nextApplyDelay({ nowMs: 1200, lastEditMs: 1000, firstPendingEditMs: 1000 }), 0);
});

test('anchors later than now restart a bounded wait instead of waiting for the clock', () => {
  assert.equal(nextApplyDelay(pacing({ lastEditMs: 10_000_000 })), 200);
  assert.equal(
    nextApplyDelay(pacing({ lastEditMs: 10_000_000, firstPendingEditMs: 10_000_000 })),
    200,
  );
  assert.equal(nextApplyDelay(pacing({ nowMs: 1200, lastApplyStartMs: 10_000_000 })), 300);
});

test('invalid clock values throw RangeError', () => {
  for (const value of [NaN, Infinity, -Infinity, '1000', undefined, null]) {
    for (const key of ['nowMs', 'lastEditMs', 'firstPendingEditMs']) {
      assert.throws(
        () => nextApplyDelay(/** @type {any} */ (pacing({ [key]: value }))),
        { name: 'RangeError', message: `${key} must be a finite millisecond value` },
      );
    }
  }
  for (const lastApplyStartMs of [NaN, Infinity, -Infinity, '1000']) {
    assert.throws(
      () => nextApplyDelay(/** @type {any} */ (pacing({ lastApplyStartMs }))),
      { name: 'RangeError', message: 'lastApplyStartMs must be a finite millisecond value' },
    );
  }
});

test('coalesce keeps only the newest edit', () => {
  const a = Object.freeze({ id: 'a' });
  const b = Object.freeze({ id: 'b' });
  const c = Object.freeze({ id: 'c' });
  assert.equal(coalesce(null, a), a);
  assert.equal(coalesce(undefined, a), a);
  assert.equal(coalesce(a, b), b);
  assert.equal(coalesce(b, a), a);
  assert.equal(coalesce(5, 0), 0);
  /** @type {{id: string} | null} */
  let pending = null;
  for (const edit of [a, b, c]) pending = coalesce(pending, edit);
  assert.equal(pending, c);
  assert.deepEqual(a, { id: 'a' });
});

/**
 * @param {Partial<Parameters<typeof liveHold>[0]>} [overrides]
 * @returns {Parameters<typeof liveHold>[0]}
 */
function hold(overrides = {}) {
  return { levelDb: 0, ackLevelDb: 0, state: 'known', ...overrides };
}

test('rises of 3 dB or more over the confirmed level hold, with Q23 tolerance', () => {
  assert.equal(liveHold(hold({ levelDb: 3 - 2e-4 })), null);
  for (const deltaDb of [3 - 1e-4, 3 - 5e-5, 2.9999999999999996, 3, 3 + 5e-7, 10]) {
    assert.deepEqual(liveHold(hold({ levelDb: deltaDb })), { reason: 'loudness', deltaDb });
  }
  assert.deepEqual(liveHold(hold({ levelDb: -7, ackLevelDb: -10 })), {
    reason: 'loudness',
    deltaDb: 3,
  });
  assert.equal(liveHold(hold({ levelDb: -7.1, ackLevelDb: -10 })), null);
});

test('small steps cannot creep past the threshold: each is measured from the same ack', () => {
  const ackLevelDb = -20;
  let previous = ackLevelDb;
  /** @type {(ReturnType<typeof liveHold>)[]} */
  const results = [];
  for (let step = 1; step <= 3; step += 1) {
    const levelDb = previous + 2.9;
    // Relative to the previous apply every step is below 3 dB...
    assert.ok(levelDb - previous < 3);
    results.push(liveHold(hold({ levelDb, ackLevelDb })));
    previous = levelDb;
  }
  // ...but the cumulative rise over the confirmed level holds from step 2 on.
  assert.equal(results[0], null);
  assert.equal(results[1]?.reason, 'loudness');
  assert.equal(results[2]?.reason, 'loudness');
  assert.ok(results[1] && 'deltaDb' in results[1] && Math.abs(results[1].deltaDb - 5.8) < 1e-9);

  assert.equal(liveHold(hold({ levelDb: -9, ackLevelDb: -10 })), null);
  assert.equal(liveHold(hold({ levelDb: -8, ackLevelDb: -10 })), null);
  assert.deepEqual(liveHold(hold({ levelDb: -7, ackLevelDb: -10 })), {
    reason: 'loudness',
    deltaDb: 3,
  });
});

test('equal or lower levels never hold when the state is known', () => {
  for (const levelDb of [0, -0.5, -3, -100]) {
    assert.equal(liveHold(hold({ levelDb })), null);
  }
  for (const state of ['known', 'live', 'committed', null, undefined]) {
    assert.equal(liveHold(hold({ state })), null);
  }
  assert.equal(liveHold({ levelDb: -1, ackLevelDb: 0 }), null);
});

test('an unknown state holds regardless of the level, before loudness', () => {
  for (const levelDb of [-100, 0, 10]) {
    assert.deepEqual(liveHold(hold({ levelDb, state: 'unknown' })), { reason: 'unknown-state' });
  }
});

test('missing or non-finite levels and overflowed differences hold as unknown-state', () => {
  for (const ackLevelDb of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.deepEqual(liveHold(hold({ ackLevelDb })), { reason: 'unknown-state' });
  }
  assert.deepEqual(liveHold({ levelDb: 0 }), { reason: 'unknown-state' });
  for (const levelDb of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(liveHold(hold({ levelDb })), { reason: 'unknown-state' });
  }
  assert.deepEqual(
    liveHold(hold({ levelDb: Number.MAX_VALUE, ackLevelDb: -Number.MAX_VALUE })),
    { reason: 'unknown-state' },
  );
});

test('inputs remain untouched', () => {
  const input = Object.freeze(hold({ levelDb: 5 }));
  assert.deepEqual(liveHold(input), { reason: 'loudness', deltaDb: 5 });
  assert.deepEqual(input, { levelDb: 5, ackLevelDb: 0, state: 'known' });
  const timing = Object.freeze(pacing({ lastApplyStartMs: 900 }));
  assert.equal(nextApplyDelay(timing), 200);
  assert.deepEqual(timing, { nowMs: 1000, lastEditMs: 1000, firstPendingEditMs: 1000, lastApplyStartMs: 900 });
});
