import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DAILY_NOTICE_THRESHOLD,
  FLASH_NOTICE_TEXT,
  FLASH_STORAGE_KEYS,
  MIN_INTERVAL_MS,
  canWriteNow,
  dailyNotice,
  localDateKey,
  observeFlashState,
  parseFlashState,
  recordWrite,
  serializeFlashState,
} from '../../src/policy/flash.mjs';

function rawState(overrides = {}) {
  return {
    day: '{"date":"2026-10-16","count":49}',
    total: '100',
    lastWriteAt: '10000',
    session: '2',
    ...overrides,
  };
}

const today = () => '2026-10-16';

test('flash constants document storage scopes, interval, threshold and exact UI text', () => {
  assert.deepEqual(FLASH_STORAGE_KEYS, {
    day: 'oa.flash.day',
    total: 'oa.flash.total',
    lastWriteAt: 'oa.flash.lastWriteAt',
    session: 'oa.flash.session',
  });
  assert.ok(Object.isFrozen(FLASH_STORAGE_KEYS));
  assert.equal(MIN_INTERVAL_MS, 2000);
  assert.equal(DAILY_NOTICE_THRESHOLD, 50);
  assert.equal(
    FLASH_NOTICE_TEXT,
    'A memória do cabo tem vida útil desconhecida; memórias desse tipo costumam aguentar de 10 mil a 1 milhão de gravações.',
  );
});

test('valid raw storage round trips exactly without touching the supplied state', () => {
  const state = parseFlashState(rawState());
  assert.deepEqual(state, {
    day: { date: '2026-10-16', count: 49 },
    total: 100,
    lastWriteAt: 10000,
    session: 2,
  });
  Object.freeze(state.day);
  Object.freeze(state);
  assert.deepEqual(serializeFlashState(state), rawState());
  assert.deepEqual(parseFlashState(serializeFlashState(state)), state);
  assert.deepEqual(parseFlashState(rawState(), 12000), state);
});

test('missing storage counters reset but a missing timestamp forces a recoverable wait', () => {
  const raw = { day: null, total: null, lastWriteAt: null, session: null };
  const unknown = parseFlashState(raw);
  assert.deepEqual(unknown, {
    day: { date: null, count: 0 },
    total: 0,
    lastWriteAt: null,
    session: 0,
  });
  assert.deepEqual(canWriteNow(unknown, 1000000), { ok: false, waitMs: 2000 });
  assert.deepEqual(parseFlashState(serializeFlashState(unknown)), unknown);
  const anchored = parseFlashState(raw, 1000000);
  assert.equal(anchored.lastWriteAt, 1000000);
  assert.deepEqual(canWriteNow(anchored, 1001999), { ok: false, waitMs: 1 });
  assert.deepEqual(canWriteNow(anchored, 1002000), { ok: true, waitMs: 0 });
});

test('corruption in every storage key is isolated and cannot bypass the cooldown', () => {
  const corruptValues = [
    '',
    'broken',
    '{',
    'null',
    'true',
    '[]',
    '{}',
    '"12"',
    '-1',
    '1.5',
    'NaN',
    'Infinity',
    '1e999',
    '9007199254740992',
  ];
  for (const value of corruptValues) {
    for (const key of ['day', 'total', 'session', 'lastWriteAt']) {
      const state = parseFlashState(rawState({ [key]: value }));
      if (key === 'day') assert.deepEqual(state.day, { date: null, count: 0 }, value);
      else if (key === 'lastWriteAt') {
        assert.equal(state.lastWriteAt, null, value);
        assert.deepEqual(canWriteNow(state, 5000000), { ok: false, waitMs: 2000 }, value);
        const observed = observeFlashState(state, 5000000);
        assert.deepEqual(canWriteNow(observed, 5002000), { ok: true, waitMs: 0 }, value);
      } else assert.equal(state[key], 0, `${key}: ${value}`);
      if (key !== 'total') assert.equal(state.total, 100);
      if (key !== 'session') assert.equal(state.session, 2);
      if (key !== 'lastWriteAt') assert.equal(state.lastWriteAt, 10000);
    }
  }
  assert.equal(parseFlashState(rawState({ lastWriteAt: '8640000000000001' })).lastWriteAt, null);
});

test('invalid day dates reset the day and invalid day counts reset only its count', () => {
  for (const date of [
    null,
    20261016,
    '2026-1-01',
    '2026-00-10',
    '2026-13-01',
    '2026-01-00',
    '2026-04-31',
    '2026-02-29',
    '1900-02-29',
    '2026-10-16T00:00:00Z',
  ]) {
    const state = parseFlashState(rawState({ day: JSON.stringify({ date, count: 60 }) }));
    assert.deepEqual(state.day, { date: null, count: 0 });
    assert.equal(dailyNotice(state, 10000, today), false);
  }
  for (const date of ['2000-02-29', '2024-02-29', '2026-12-31']) {
    assert.deepEqual(parseFlashState(rawState({ day: JSON.stringify({ date, count: 4 }) })).day, {
      date,
      count: 4,
    });
  }
  for (const count of [null, -1, 1.25, '50', true, Number.MAX_SAFE_INTEGER + 1]) {
    const state = parseFlashState(rawState({ day: JSON.stringify({ date: '2026-10-16', count }) }));
    assert.deepEqual(state.day, { date: '2026-10-16', count: 0 });
  }
  assert.deepEqual(parseFlashState(rawState({ day: '{"count":50}' })).day, {
    date: null,
    count: 0,
  });
  assert.deepEqual(parseFlashState(rawState({ day: '{"date":"2026-10-16"}' })).day, {
    date: '2026-10-16',
    count: 0,
  });
});

test('the cooldown includes the exact 2000 ms boundary, including epoch zero', () => {
  const state = parseFlashState(rawState());
  for (const elapsed of [0, 1, 999, 1999, 2000, 2001, 100000]) {
    assert.deepEqual(canWriteNow(state, 10000 + elapsed), {
      ok: elapsed >= 2000,
      waitMs: Math.max(0, 2000 - elapsed),
    });
  }
  const zero = parseFlashState(rawState({ lastWriteAt: '0', total: '0', session: '0' }));
  assert.equal(zero.lastWriteAt, 0);
  assert.equal(zero.total, 0);
  assert.equal(zero.session, 0);
  assert.deepEqual(canWriteNow(zero, 0), { ok: false, waitMs: 2000 });
  assert.deepEqual(canWriteNow(zero, 2000), { ok: true, waitMs: 0 });
});

test('backwards time waits from the observation, not until an old future timestamp', () => {
  const state = parseFlashState(rawState({ lastWriteAt: '1000000000000' }));
  Object.freeze(state.day);
  Object.freeze(state);
  assert.deepEqual(canWriteNow(state, 1000), { ok: false, waitMs: 2000 });
  const observed = observeFlashState(state, 1000);
  assert.notEqual(observed, state);
  assert.notEqual(observed.day, state.day);
  assert.equal(state.lastWriteAt, 1000000000000);
  assert.equal(observed.lastWriteAt, 1000);
  assert.deepEqual(canWriteNow(observed, 2999), { ok: false, waitMs: 1 });
  assert.deepEqual(canWriteNow(observed, 3000), { ok: true, waitMs: 0 });
  const written = recordWrite(observed, 3000, today);
  assert.deepEqual(canWriteNow(written, 4999), { ok: false, waitMs: 1 });
  assert.deepEqual(canWriteNow(written, 5000), { ok: true, waitMs: 0 });
  const anotherJump = observeFlashState(observed, 500);
  assert.deepEqual(canWriteNow(anotherJump, 2500), { ok: true, waitMs: 0 });
  assert.equal(parseFlashState(rawState({ lastWriteAt: '1000000000000' }), 1000).lastWriteAt, 1000);
});

test('local midnight rollover uses the injected calendar and never resets total or session', () => {
  const midnight = 100000;
  const dates = (nowMs) => (nowMs < midnight ? '2026-10-16' : '2026-10-17');
  const initial = parseFlashState(rawState());
  Object.freeze(initial.day);
  Object.freeze(initial);
  assert.equal(dailyNotice(initial, midnight - 1, dates), false);
  const before = recordWrite(initial, midnight - 1, dates);
  assert.deepEqual(before.day, { date: '2026-10-16', count: 50 });
  assert.equal(before.total, 101);
  assert.equal(before.session, 3);
  assert.equal(dailyNotice(before, midnight - 1, dates), true);
  assert.equal(dailyNotice(before, midnight, dates), false);
  const after = recordWrite(before, midnight + 2000, dates);
  assert.deepEqual(after.day, { date: '2026-10-17', count: 1 });
  assert.equal(after.total, 102);
  assert.equal(after.session, 4);
  assert.deepEqual(initial.day, { date: '2026-10-16', count: 49 });
});

test('notices remain advisory and monotonic writes can continue beyond 50 in a day', () => {
  let state = parseFlashState(rawState());
  for (let index = 0; index < 100; index += 1) {
    const nowMs = 12000 + index * 2000;
    state = observeFlashState(state, nowMs);
    assert.deepEqual(canWriteNow(state, nowMs), { ok: true, waitMs: 0 });
    state = recordWrite(state, nowMs, today);
    assert.equal(dailyNotice(state, nowMs, today), true);
    assert.deepEqual(canWriteNow(state, nowMs + 1999), { ok: false, waitMs: 1 });
  }
  assert.equal(state.day.count, 149);
  assert.equal(state.total, 200);
  assert.equal(state.session, 102);
});

test('local default calendar handles padding and midnight instead of using UTC dates', () => {
  const midnight = new Date(2026, 0, 2, 0, 0, 0, 0).getTime();
  assert.equal(localDateKey(midnight - 1), '2026-01-01');
  assert.equal(localDateKey(midnight), '2026-01-02');
  const state = parseFlashState(rawState());
  const written = recordWrite(state, midnight);
  assert.deepEqual(written.day, { date: '2026-01-02', count: 1 });
  assert.equal(dailyNotice({ ...written, day: { ...written.day, count: 50 } }, midnight), true);
  assert.throws(() => localDateKey(8640000000000000), RangeError);
});

test('invalid injected clocks and date keys are rejected without changing state', () => {
  const state = parseFlashState(rawState());
  for (const nowMs of [NaN, Infinity, -Infinity, -1, 1.5, 8640000000000001]) {
    assert.throws(() => canWriteNow(state, nowMs), RangeError);
    assert.throws(() => observeFlashState(state, nowMs), RangeError);
    assert.throws(() => recordWrite(state, nowMs, today), RangeError);
    assert.throws(() => dailyNotice(state, nowMs, today), RangeError);
    assert.throws(() => parseFlashState(rawState(), nowMs), RangeError);
  }
  for (const date of ['2026-02-30', 'bad']) {
    assert.throws(() => recordWrite(state, 12000, () => date), RangeError);
    assert.throws(() => dailyNotice(state, 12000, () => date), RangeError);
  }
  assert.deepEqual(state, parseFlashState(rawState()));
});

test('large counters remain safe integers without imposing a hard write limit', () => {
  const count = Number.MAX_SAFE_INTEGER;
  const state = {
    day: { date: '2026-10-16', count },
    total: count,
    lastWriteAt: 10000,
    session: count,
  };
  const next = recordWrite(state, 12000, today);
  assert.equal(next.day.count, count);
  assert.equal(next.total, count);
  assert.equal(next.session, count);
  assert.equal(dailyNotice(next, 14000, today), true);
  assert.deepEqual(canWriteNow(next, 14000), { ok: true, waitMs: 0 });
});
