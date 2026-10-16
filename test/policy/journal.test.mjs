import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JOURNAL_MAX,
  JOURNAL_STORAGE_KEY,
  appendEntry,
  lastEntry,
  parseJournal,
  serializeJournal,
  validateEntry,
} from '../../src/policy/journal.mjs';

function entry(overrides = {}) {
  return {
    schema: 1,
    at: 1792108800000,
    name: 'Neutral',
    crc: 0x4fff,
    preampDb: -0.5,
    bands: Array.from({ length: 10 }, () => ({ kind: 'OFF' })),
    status: 'ok',
    device: null,
    ...overrides,
  };
}

function activeBands(overrides = {}) {
  return Array.from({ length: 10 }, () => ({
    kind: 'PK',
    freqHz: 1000,
    gainDb: -2,
    qFactor: 1,
    ...overrides,
  }));
}

test('journal constants document localStorage and the 500-entry FIFO limit', () => {
  assert.equal(JOURNAL_STORAGE_KEY, 'oa.journal');
  assert.equal(JOURNAL_MAX, 500);
});

test('all supported kinds and statuses validate without imposing the safety gate', () => {
  assert.deepEqual(validateEntry(entry()), { ok: true, errors: [] });
  for (const kind of ['PK', 'LS', 'HS', 'LP', 'HP']) {
    for (const status of ['ok', 'interrupted', 'simulated']) {
      assert.deepEqual(validateEntry(entry({ bands: activeBands({ kind }), status })), {
        ok: true,
        errors: [],
      });
    }
  }
  assert.equal(validateEntry(entry({ bands: activeBands({ gainDb: 100, qFactor: 25 }) })).ok, true);
});

test('schema boundaries for time, text, CRC and device are inclusive', () => {
  assert.equal(validateEntry(entry({ at: 0, crc: 0, name: '', device: '', preampDb: 0 })).ok, true);
  assert.equal(
    validateEntry(
      entry({ at: 8640000000000000, crc: 65535, name: 'n'.repeat(48), device: 'd'.repeat(64) }),
    ).ok,
    true,
  );
});

test('invalid top-level entries and every invalid scalar are rejected with diagnostics', () => {
  for (const value of [null, undefined, 1, 'entry', [], true]) {
    assert.deepEqual(validateEntry(value), { ok: false, errors: ['entry must be an object'] });
  }
  const invalidFields = {
    schema: [undefined, null, 0, 2, '1'],
    at: [undefined, null, '2026-10-16T00:00:00Z', NaN, Infinity, -1, 0.5, 8640000000000001],
    name: [undefined, null, 10, 'n'.repeat(49)],
    crc: [undefined, null, '10', NaN, Infinity, -1, 1.5, 65536],
    preampDb: [undefined, null, '0', NaN, Infinity, -Infinity],
    status: [undefined, null, 0, 'unknown', 'OK'],
    device: [undefined, 10, {}, 'd'.repeat(65)],
  };
  for (const [key, values] of Object.entries(invalidFields)) {
    for (const value of values) {
      const result = validateEntry(entry({ [key]: value }));
      assert.equal(result.ok, false, `${key}: ${String(value)}`);
      assert.ok(
        result.errors.some((error) => error.startsWith(key)),
        key,
      );
    }
  }
  const result = validateEntry({});
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 8);
});

test('bands must be exactly ten supported finite parameter records', () => {
  for (const bands of [undefined, null, {}, [], activeBands().slice(1), [...activeBands(), {}]]) {
    const result = validateEntry(entry({ bands }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes('bands must contain exactly 10 bands'));
  }
  for (const band of [null, undefined, 1, 'OFF', [], {}]) {
    const bands = activeBands();
    bands[4] = band;
    const result = validateEntry(entry({ bands }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.startsWith('bands[4]')));
  }
  const invalidFields = {
    kind: [undefined, null, 10, 'unsupported', 'off'],
    freqHz: [undefined, null, '1000', NaN, Infinity, -1, 0],
    gainDb: [undefined, null, '0', NaN, Infinity, -Infinity],
    qFactor: [undefined, null, '1', NaN, Infinity, -1, 0],
  };
  for (const [key, values] of Object.entries(invalidFields)) {
    for (const value of values) {
      const result = validateEntry(entry({ bands: activeBands({ [key]: value }) }));
      assert.equal(result.ok, false, `${key}: ${String(value)}`);
      assert.ok(result.errors.some((error) => error.startsWith(`bands[0].${key}`)));
    }
  }
  const sparse = new Array(10);
  assert.equal(validateEntry(entry({ bands: sparse })).ok, false);
});

test('append returns new storage-independent records and leaves frozen inputs untouched', () => {
  const first = entry();
  const next = entry({ name: 'Next', bands: activeBands() });
  for (const band of next.bands) Object.freeze(band);
  Object.freeze(next.bands);
  Object.freeze(next);
  const previous = Object.freeze([first]);
  const appended = appendEntry(previous, next);
  assert.notEqual(appended, previous);
  assert.deepEqual(previous, [first]);
  assert.equal(appended[0], first);
  assert.deepEqual(appended[1], next);
  assert.notEqual(appended[1], next);
  assert.notEqual(appended[1].bands, next.bands);
  assert.notEqual(appended[1].bands[0], next.bands[0]);
  assert.throws(() => appendEntry(previous, entry({ crc: -1 })), /Invalid journal entry: crc/);
  assert.deepEqual(previous, [first]);
});

test('FIFO keeps 500 at the boundary and drops precisely the oldest at 501', () => {
  let entries = [];
  for (let index = 0; index < 500; index += 1) {
    entries = appendEntry(entries, entry({ name: String(index), at: index }));
  }
  assert.equal(entries.length, 500);
  assert.equal(entries[0].name, '0');
  assert.equal(lastEntry(entries).name, '499');
  const next = appendEntry(entries, entry({ name: '500', at: 500 }));
  assert.equal(next.length, 500);
  assert.equal(next[0].name, '1');
  assert.equal(lastEntry(next).name, '500');
  assert.equal(entries.length, 500);
  assert.equal(entries[0].name, '0');
  assert.equal(lastEntry([]), null);
  assert.equal(lastEntry(next), next[499]);
});

test('null, corrupt JSON and non-array storage recover without inventing records', () => {
  for (const raw of [null, '', '{', 'undefined', 'NaN', '{}', 'null', '10', 'true', '"array"']) {
    assert.deepEqual(parseJournal(raw), { entries: [], dropped: 0 });
  }
  assert.deepEqual(parseJournal('[]'), { entries: [], dropped: 0 });
});

test('invalid entries are dropped individually and report their exact count', () => {
  const first = entry({ name: 'First' });
  const second = entry({ name: 'Second', status: 'interrupted' });
  const raw = JSON.stringify([
    null,
    first,
    entry({ schema: 2 }),
    {},
    entry({ bands: [] }),
    second,
    entry({ crc: -1 }),
  ]);
  assert.deepEqual(parseJournal(raw), { entries: [first, second], dropped: 5 });
  assert.deepEqual(parseJournal('[null,{},false]'), { entries: [], dropped: 3 });
});

test('parsed FIFO overflow counts discarded entries, independently of invalid records', () => {
  const entries = Array.from({ length: 501 }, (_, at) => entry({ at, name: String(at) }));
  const parsed = parseJournal(JSON.stringify([null, ...entries, {}]));
  assert.equal(parsed.entries.length, 500);
  assert.equal(parsed.entries[0].at, 1);
  assert.equal(lastEntry(parsed.entries).at, 500);
  assert.equal(parsed.dropped, 3);
  const serialized = parseJournal(serializeJournal(entries));
  assert.equal(serialized.entries.length, 500);
  assert.equal(serialized.entries[0].at, 1);
  assert.equal(serialized.dropped, 0);
});

test('serialization round trips all record fields, statuses and supported band kinds', () => {
  const kinds = ['PK', 'LS', 'HS', 'LP', 'HP'];
  const entries = ['ok', 'interrupted', 'simulated'].map((status, index) =>
    entry({
      at: 1792108800000 + index,
      status,
      name: `Curve ${index}`,
      crc: index * 1234,
      preampDb: -2.75,
      device: 'USB DSP Audio',
      bands: [
        ...kinds.map((kind) => ({ kind, freqHz: 1500, gainDb: -2.5, qFactor: 0.7 })),
        ...Array.from({ length: 5 }, () => ({ kind: 'OFF' })),
      ],
    }),
  );
  const raw = serializeJournal(entries);
  assert.deepEqual(parseJournal(raw), { entries, dropped: 0 });
  assert.equal(serializeJournal(parseJournal(raw).entries), raw);
  assert.equal(serializeJournal([]), '[]');
  assert.throws(() => serializeJournal([entry({ preampDb: NaN })]), /preampDb must be finite/);
});

test('unvalidated extra properties cannot leak into persisted records', () => {
  const original = entry({ bands: activeBands({ ignored: { private: true } }), extra: 'discard' });
  original.self = original;
  const canonical = entry({ bands: activeBands() });
  assert.equal(validateEntry(original).ok, true);
  assert.deepEqual(appendEntry([], original), [canonical]);
  assert.deepEqual(parseJournal(serializeJournal([original])), {
    entries: [canonical],
    dropped: 0,
  });
  assert.deepEqual(parseJournal(JSON.stringify([entry({ extra: true })])), {
    entries: [entry()],
    dropped: 0,
  });
});
