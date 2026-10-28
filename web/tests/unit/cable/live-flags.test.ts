/**
 * The service's non-identifying live flags (`playsUnsaved`, `cableEq`) in the presentation
 * helpers: a blind comparison redacts `applied`, so the helpers must not read it to decide
 * whether the cable plays something unsaved or whether the browser must stay flat.
 */
import { expect, test } from 'vitest';
import { browserFlat, liveSavable, liveUnsaved } from '#lib/components/cable/live.ts';
import type { Band, LiveState } from '#lib/cable/types.ts';

const OFF: Band = { kind: 'OFF' };
const PK: Band = { kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 };
const SAVED = { bands: [PK, OFF], preampDb: -3 };

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

/** A blind comparison's view: no `applied`, no `savedCrc`, the flags only. */
function blind(partial: Partial<LiveState> = {}): LiveState {
	return state({
		applied: null,
		ackLevelDb: null,
		comparison: { active: true, blind: true, count: 3, status: 'ready' },
		playsUnsaved: true,
		cableEq: true,
		...partial
	});
}

test('blind: the flags decide (the applied curve is redacted)', () => {
	const live = blind();
	expect(liveUnsaved(live, SAVED)).toBe(true);
	expect(browserFlat({ live, liveOrphan: null }, SAVED)).toBe(true);
	expect(liveSavable({ live, deviceLabel: 'Cabo' })).toBe(true);
	// Unknown state: unsaved, but not known to apply the EQ.
	const unknown = blind({ status: 'unknown', cableEq: false, hold: { reason: 'unknown-state' } });
	expect(liveUnsaved(unknown, SAVED)).toBe(true);
	expect(browserFlat({ live: unknown, liveOrphan: null }, SAVED)).toBe(false);
});

test('blind, ended: kept candidate stays unsaved and flat; a revert is not', () => {
	const kept = blind({
		status: 'ended',
		endedReason: 'stopped',
		comparison: { active: false, blind: true, count: 3, status: 'ready' }
	});
	expect(liveUnsaved(kept, SAVED)).toBe(true);
	expect(browserFlat({ live: kept, liveOrphan: null }, SAVED)).toBe(true);
	expect(liveSavable({ live: kept, deviceLabel: 'Cabo' })).toBe(true);
	const reverted = blind({
		status: 'ended',
		endedReason: 'reverted',
		playsUnsaved: false,
		cableEq: false
	});
	expect(liveUnsaved(reverted, SAVED)).toBe(false);
	expect(browserFlat({ live: reverted, liveOrphan: null }, SAVED)).toBe(false);
	expect(liveSavable({ live: reverted, deviceLabel: 'Cabo' })).toBe(false);
});

test('the service knows the saved curve: its flags win over the page comparison', () => {
	// The page's saved curve equals the applied one, but the cable's own saved CRC differs.
	const live = state({ savedCrc: 2, playsUnsaved: true, cableEq: true });
	expect(liveUnsaved(live, SAVED)).toBe(true);
	const same = state({ savedCrc: 1, playsUnsaved: false, cableEq: true });
	expect(liveUnsaved(same, null)).toBe(false);
	expect(browserFlat({ live: same, liveOrphan: null }, null)).toBe(true);
});

test('saved curve unknown to the service: the page saved curve refines the flag', () => {
	const live = state({ savedCrc: null, playsUnsaved: true, cableEq: true });
	expect(liveUnsaved(live, SAVED)).toBe(false);
	expect(liveUnsaved(live, { bands: [OFF, OFF], preampDb: -3 })).toBe(true);
});

test('an orphan preview still makes the browser flat whatever the flags say', () => {
	const live = blind({ cableEq: false });
	expect(
		browserFlat(
			{ live, liveOrphan: { crc: -1, at: 0, deviceLabel: 'Cabo' }, deviceLabels: ['Cabo'] },
			SAVED
		)
	).toBe(true);
});
