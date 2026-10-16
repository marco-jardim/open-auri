import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOUDNESS_JUMP_DB,
  LOUDNESS_WARNING_TEXT,
  loudnessWarning,
} from '../../src/policy/loudness.mjs';

function input(overrides = {}) {
  return {
    newLevelDb: 0,
    lastWrittenLevelDb: 0,
    sessionWriteCount: 1,
    lastJournalStatus: 'ok',
    ...overrides,
  };
}

test('loudness constants match the inclusive threshold and exact UI text', () => {
  assert.equal(LOUDNESS_JUMP_DB, 3);
  assert.equal(
    LOUDNESS_WARNING_TEXT,
    'A nova curva pode soar mais alta. Abaixe o volume antes de gravar.',
  );
});

test('the exact injected 3.0 dB threshold warns, just below it does not', () => {
  assert.deepEqual(loudnessWarning(input({ newLevelDb: 2.9999999999999996 })), {
    warn: false,
    reasons: [],
    deltaDb: 2.9999999999999996,
  });
  assert.deepEqual(loudnessWarning(input({ newLevelDb: 3 })), {
    warn: true,
    reasons: ['jump'],
    deltaDb: 3,
  });
  assert.deepEqual(loudnessWarning(input({ newLevelDb: -7, lastWrittenLevelDb: -10 })), {
    warn: true,
    reasons: ['jump'],
    deltaDb: 3,
  });
  assert.deepEqual(loudnessWarning(input({ newLevelDb: 10 })), {
    warn: true,
    reasons: ['jump'],
    deltaDb: 10,
  });
});

test('equal or lower injected levels do not warn when the cable state is known', () => {
  for (const deltaDb of [0, -0.5, -3, -100]) {
    assert.deepEqual(loudnessWarning(input({ newLevelDb: deltaDb })), {
      warn: false,
      reasons: [],
      deltaDb,
    });
  }
});

test('the first session write warns even with a known, quieter previous level', () => {
  assert.deepEqual(loudnessWarning(input({ newLevelDb: -20, sessionWriteCount: 0 })), {
    warn: true,
    reasons: ['unknown-state'],
    deltaDb: -20,
  });
});

test('no previous level, null or omitted, means unknown cable state', () => {
  for (const lastWrittenLevelDb of [null, undefined]) {
    assert.deepEqual(loudnessWarning(input({ lastWrittenLevelDb })), {
      warn: true,
      reasons: ['unknown-state'],
      deltaDb: null,
    });
  }
  assert.equal(loudnessWarning({ newLevelDb: 0, sessionWriteCount: 1 }).warn, true);
});

test('an interrupted last write warns and can combine with a level jump', () => {
  assert.deepEqual(loudnessWarning(input({ lastJournalStatus: 'interrupted' })), {
    warn: true,
    reasons: ['unknown-state'],
    deltaDb: 0,
  });
  assert.deepEqual(
    loudnessWarning(
      input({ newLevelDb: 3, lastJournalStatus: 'interrupted', sessionWriteCount: 0 }),
    ),
    { warn: true, reasons: ['jump', 'unknown-state'], deltaDb: 3 },
  );
});

test('non-finite levels and overflowed differences warn without a misleading delta', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const key of ['newLevelDb', 'lastWrittenLevelDb']) {
      assert.deepEqual(loudnessWarning(input({ [key]: value })), {
        warn: true,
        reasons: ['unknown-state'],
        deltaDb: null,
      });
    }
  }
  assert.deepEqual(
    loudnessWarning(input({ newLevelDb: Number.MAX_VALUE, lastWrittenLevelDb: -Number.MAX_VALUE })),
    { warn: true, reasons: ['unknown-state'], deltaDb: null },
  );
});

test('invalid session counters also warn conservatively', () => {
  for (const sessionWriteCount of [NaN, Infinity, -Infinity, -1, 1.5, 2 ** 53]) {
    assert.deepEqual(loudnessWarning(input({ sessionWriteCount })), {
      warn: true,
      reasons: ['unknown-state'],
      deltaDb: 0,
    });
  }
});

test('known sessions need no journal status and inputs remain untouched', () => {
  for (const lastJournalStatus of [null, undefined, 'simulated', 'ok']) {
    const state = Object.freeze(input({ lastJournalStatus }));
    assert.deepEqual(loudnessWarning(state), { warn: false, reasons: [], deltaDb: 0 });
    assert.equal(state.lastJournalStatus, lastJournalStatus);
  }
});
