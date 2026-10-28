import { expect, test } from 'vitest';
import { liveActive, liveUnsaved, sameCurve } from '#lib/components/cable/live.ts';
import type { Band, LiveState } from '#lib/cable/types.ts';

const OFF: Band = { kind: 'OFF' };
const PK: Band = { kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 };

function state(partial: Partial<LiveState> = {}): LiveState {
	return {
		deviceLabel: 'Cabo',
		status: 'live',
		applied: { crc: 1, bands: [PK, OFF], preampDb: -3, levelDb: -3, at: 0 },
		pending: false,
		ackLevelDb: -3,
		hold: null,
		applies: 1,
		total: 1,
		lastError: null,
		...partial
	};
}

test('sameCurve compares the values the cable reads, not key order', () => {
	const reordered = { qFactor: 1, gainDb: -3, freqHz: 1000, kind: 'PK' } as const;
	expect(sameCurve({ bands: [PK, OFF], preampDb: -3 }, { bands: [reordered, OFF], preampDb: -3 })).toBe(
		true
	);
	expect(sameCurve({ bands: [PK, OFF], preampDb: -3 }, { bands: [PK, OFF], preampDb: -2.5 })).toBe(
		false
	);
	expect(sameCurve({ bands: [PK, OFF], preampDb: -3 }, { bands: [OFF, PK], preampDb: -3 })).toBe(
		false
	);
});

test('liveUnsaved: an applied curve other than the saved one, while the cable still plays it', () => {
	const saved = { bands: [PK, OFF], preampDb: -3 };
	const other = { bands: [OFF, OFF], preampDb: -3 };
	expect(liveUnsaved(null, saved)).toBe(false);
	expect(liveUnsaved(state(), saved)).toBe(false);
	expect(liveUnsaved(state(), other)).toBe(true);
	expect(liveUnsaved(state(), null)).toBe(true);
	expect(liveUnsaved(state({ applied: null, status: 'starting' }), other)).toBe(false);
	expect(liveUnsaved(state({ status: 'unknown' }), saved)).toBe(true);
	// Ended: kept until unplugged (stopped, forgotten), or back on the saved curve.
	expect(liveUnsaved(state({ status: 'ended', endedReason: 'stopped' }), other)).toBe(true);
	expect(liveUnsaved(state({ status: 'ended', endedReason: 'forgotten' }), other)).toBe(true);
	expect(liveUnsaved(state({ status: 'ended', endedReason: 'disconnected' }), other)).toBe(false);
	expect(liveUnsaved(state({ status: 'ended', endedReason: 'reverted' }), other)).toBe(false);
});

test('liveActive: any status but ended', () => {
	expect(liveActive(null)).toBe(false);
	expect(liveActive(state())).toBe(true);
	expect(liveActive(state({ status: 'held' }))).toBe(true);
	expect(liveActive(state({ status: 'ended', endedReason: 'stopped' }))).toBe(false);
});
