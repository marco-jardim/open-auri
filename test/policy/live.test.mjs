import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIVE_DEBOUNCE_MS,
  LIVE_MAX_WAIT_MS,
  LIVE_MIN_INTERVAL_MS,
  LIVE_AFTER_COMMIT_MS,
  LIVE_MAX_PENDING,
  nextApplyDelay,
  coalesce,
  liveHold,
} from '../../src/policy/live.mjs';
import { MIN_INTERVAL_MS } from '../../src/policy/flash.mjs';
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
  // The wait after a commit is the flash policy's own spacing, not a copy of it.
  assert.equal(LIVE_AFTER_COMMIT_MS, MIN_INTERVAL_MS);
  assert.equal(LIVE_AFTER_COMMIT_MS, 2000);
});

test('the policy index re-exports the live module', () => {
  assert.equal(policy.nextApplyDelay, nextApplyDelay);
  assert.equal(policy.coalesce, coalesce);
  assert.equal(policy.liveHold, liveHold);
  assert.equal(policy.LIVE_DEBOUNCE_MS, LIVE_DEBOUNCE_MS);
  assert.equal(policy.LIVE_MAX_WAIT_MS, LIVE_MAX_WAIT_MS);
  assert.equal(policy.LIVE_MIN_INTERVAL_MS, LIVE_MIN_INTERVAL_MS);
  assert.equal(policy.LIVE_AFTER_COMMIT_MS, LIVE_AFTER_COMMIT_MS);
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
    nextApplyDelay({
      nowMs: 1600,
      lastEditMs: 1600,
      firstPendingEditMs: 1000,
      lastApplyStartMs: 1500,
    }),
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
      assert.throws(() => nextApplyDelay(/** @type {any} */ (pacing({ [key]: value }))), {
        name: 'RangeError',
        message: `${key} must be a finite millisecond value`,
      });
    }
  }
  for (const lastApplyStartMs of [NaN, Infinity, -Infinity, '1000']) {
    assert.throws(() => nextApplyDelay(/** @type {any} */ (pacing({ lastApplyStartMs }))), {
      name: 'RangeError',
      message: 'lastApplyStartMs must be a finite millisecond value',
    });
  }
  for (const lastCommitMs of [NaN, Infinity, -Infinity, '1000', 1000n]) {
    assert.throws(() => nextApplyDelay(/** @type {any} */ (pacing({ lastCommitMs }))), {
      name: 'RangeError',
      message: 'lastCommitMs must be a finite millisecond value',
    });
  }
});

test('a missing or non-object input throws RangeError', () => {
  for (const input of [undefined, null, 1000, 'now']) {
    assert.throws(() => nextApplyDelay(/** @type {any} */ (input)), {
      name: 'RangeError',
      message: 'nextApplyDelay needs an input object',
    });
  }
});

test('a last edit earlier than the first pending edit throws RangeError', () => {
  assert.throws(() => nextApplyDelay(pacing({ lastEditMs: 999, firstPendingEditMs: 1000 })), {
    name: 'RangeError',
    message: 'lastEditMs must not be earlier than firstPendingEditMs',
  });
  // Equal is the single-edit case and is valid.
  assert.equal(nextApplyDelay(pacing({ lastEditMs: 1000, firstPendingEditMs: 1000 })), 200);
});

test('a live apply never starts sooner than LIVE_AFTER_COMMIT_MS after the last commit', () => {
  // Debounce long expired, no apply in flight: only the commit holds it back.
  const base = { lastEditMs: 0, firstPendingEditMs: 0, lastCommitMs: 1000 };
  assert.equal(nextApplyDelay({ ...base, nowMs: 1000 }), LIVE_AFTER_COMMIT_MS);
  assert.equal(nextApplyDelay({ ...base, nowMs: 1500 }), 1500);
  assert.equal(nextApplyDelay({ ...base, nowMs: 2999 }), 1);
  assert.equal(nextApplyDelay({ ...base, nowMs: 3000 }), 0);
  // It wins over the debounce, the max-wait and the apply interval.
  assert.equal(
    nextApplyDelay({
      nowMs: 1100,
      lastEditMs: 1100,
      firstPendingEditMs: 1100,
      lastApplyStartMs: 1000,
      lastCommitMs: 1000,
    }),
    1900,
  );
  // An old commit does not delay anything.
  assert.equal(nextApplyDelay(pacing({ nowMs: 1200, lastCommitMs: -800 })), 0);
  assert.equal(nextApplyDelay(pacing({ nowMs: 1200, lastCommitMs: 0 })), 800);
  // Null or omitted: no commit to wait for.
  for (const lastCommitMs of [null, undefined]) {
    assert.equal(nextApplyDelay(pacing({ nowMs: 1200, lastCommitMs })), 0);
  }
  // A commit stamped in the future restarts a bounded full wait.
  assert.equal(nextApplyDelay(pacing({ nowMs: 1200, lastCommitMs: 10_000_000 })), 2000);
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
    // Relative to the previous apply every step is 2.9 dB, below 3 dB...
    const levelDb = previous + 2.9;
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
  assert.equal(liveHold(hold({ state: 'known' })), null);
});

test('fail safe: only the known state sends; anything else holds as unknown-state', () => {
  const states = ['unknown', 'live', 'committed', 'Known', 'known ', 'knwon', '', null, undefined];
  for (const state of states) {
    for (const levelDb of [-100, 0, 10]) {
      assert.deepEqual(
        liveHold(hold({ levelDb, state })),
        { reason: 'unknown-state' },
        `${String(state)} at ${levelDb}`,
      );
    }
  }
  // Omitted state.
  assert.deepEqual(liveHold({ levelDb: -1, ackLevelDb: 0 }), { reason: 'unknown-state' });
  // Non-string states are never compared loosely.
  for (const state of [0, 1, true, {}, ['known'], { toString: () => 'known' }]) {
    assert.deepEqual(liveHold(hold(/** @type {any} */ ({ state }))), { reason: 'unknown-state' });
  }
  // A missing or non-object input holds instead of throwing.
  for (const input of [undefined, null, 0, 'known']) {
    assert.deepEqual(liveHold(/** @type {any} */ (input)), { reason: 'unknown-state' });
  }
});

test('levels are type-checked before any arithmetic: no BigInt, no valueOf', () => {
  let valueOfCalls = 0;
  const sneaky = {
    valueOf() {
      valueOfCalls += 1;
      return 0;
    },
  };
  for (const bad of [1n, 0n, sneaky, '0', true, [0]]) {
    for (const key of ['levelDb', 'ackLevelDb']) {
      assert.deepEqual(liveHold(hold(/** @type {any} */ ({ [key]: bad }))), {
        reason: 'unknown-state',
      });
    }
  }
  // Both BigInts would subtract without throwing; they must hold all the same.
  assert.deepEqual(liveHold(hold(/** @type {any} */ ({ levelDb: 10n, ackLevelDb: 0n }))), {
    reason: 'unknown-state',
  });
  assert.equal(valueOfCalls, 0);
});

test('missing or non-finite levels and overflowed differences hold as unknown-state', () => {
  for (const ackLevelDb of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.deepEqual(liveHold(hold({ ackLevelDb })), { reason: 'unknown-state' });
  }
  assert.deepEqual(liveHold({ levelDb: 0 }), { reason: 'unknown-state' });
  for (const levelDb of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(liveHold(hold({ levelDb })), { reason: 'unknown-state' });
  }
  assert.deepEqual(liveHold(hold({ levelDb: Number.MAX_VALUE, ackLevelDb: -Number.MAX_VALUE })), {
    reason: 'unknown-state',
  });
});

test('inputs remain untouched', () => {
  const input = Object.freeze(hold({ levelDb: 5 }));
  assert.deepEqual(liveHold(input), { reason: 'loudness', deltaDb: 5 });
  assert.deepEqual(input, { levelDb: 5, ackLevelDb: 0, state: 'known' });
  const timing = Object.freeze(pacing({ lastApplyStartMs: 900 }));
  assert.equal(nextApplyDelay(timing), 200);
  assert.deepEqual(timing, {
    nowMs: 1000,
    lastEditMs: 1000,
    firstPendingEditMs: 1000,
    lastApplyStartMs: 900,
  });
});
