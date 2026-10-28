import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { formatNumber } from '#lib/components/cable/i18n.ts';
import {
	browserFlat,
	cableLiveUnsaved,
	liveActive,
	liveHoldAction,
	liveHoldText,
	liveOutcomeText,
	livePlaying,
	liveRevertFailureText,
	liveSavable,
	liveSaveLabel,
	liveUnsaved,
	sameCurve
} from '#lib/components/cable/live.ts';
import type {
	Band,
	CableState,
	GateReason,
	LiveHoldState,
	LiveState
} from '#lib/cable/types.ts';

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

test('liveUnsaved: the curve an accepted revert left (savedCrc) is the saved one', () => {
	expect(liveUnsaved(state(), null, 1)).toBe(false);
	expect(liveUnsaved(state(), null, 2)).toBe(true);
});

test('browserFlat: flat only once the cable is known to play a curve other than the saved one', () => {
	const saved = { bands: [PK, OFF], preampDb: -3 };
	const other = { bands: [OFF, OFF], preampDb: -3 };
	const cable = (live: LiveState | null, liveOrphan: CableState['liveOrphan'] = null) => ({
		live,
		liveOrphan
	});
	expect(browserFlat(null, saved)).toBe(false);
	expect(browserFlat(cable(null), saved)).toBe(false);
	// Starting, or a first apply that failed: the cable still plays the saved curve (EQ'd chains).
	expect(browserFlat(cable(state({ status: 'starting', applied: null })), other)).toBe(false);
	expect(browserFlat(cable(state({ status: 'live', applied: null })), other)).toBe(false);
	// Unknown: neither flat nor a jump (the EQ'd chains stay).
	expect(browserFlat(cable(state({ status: 'unknown' })), other)).toBe(false);
	expect(browserFlat(cable(state()), other)).toBe(true);
	expect(browserFlat(cable(state({ status: 'applying' })), other)).toBe(true);
	expect(browserFlat(cable(state({ status: 'held' })), other)).toBe(true);
	// Ended: a curve kept on the cable (stopped, forgotten) that is not the saved one.
	for (const endedReason of ['stopped', 'forgotten'] as const) {
		expect(browserFlat(cable(state({ status: 'ended', endedReason })), other)).toBe(true);
		expect(browserFlat(cable(state({ status: 'ended', endedReason })), saved)).toBe(false);
		expect(browserFlat(cable(state({ status: 'ended', endedReason })), null)).toBe(true);
		expect(browserFlat(cable(state({ status: 'ended', endedReason })), null, 1)).toBe(false);
	}
	for (const endedReason of ['reverted', 'disconnected'] as const) {
		expect(browserFlat(cable(state({ status: 'ended', endedReason })), other)).toBe(false);
	}
	// An orphan preview (another tab, or before a reload).
	expect(browserFlat(cable(null, { crc: 9, at: 0, deviceLabel: 'Cabo' }), saved)).toBe(true);
});

test('browserFlat: an orphan preview only while its cable is connected', () => {
	const orphan = { crc: 9, at: 0, deviceLabel: 'Cabo' };
	const at = (deviceLabels: string[]) => ({ live: null, liveOrphan: orphan, deviceLabels });
	expect(browserFlat(at([]), null)).toBe(false);
	expect(browserFlat(at(['Outro']), null)).toBe(false);
	expect(browserFlat(at(['Cabo']), null)).toBe(true);
	// The marker keeps the first 64 code points of a longer label.
	const long = 'C'.repeat(70);
	const cut = { ...orphan, deviceLabel: 'C'.repeat(64) };
	expect(browserFlat({ live: null, liveOrphan: cut, deviceLabels: [long] }, null)).toBe(true);
});

test("the service's savedCrc of the session cable decides what the saved curve is", () => {
	const applied = state().applied;
	if (applied === null) throw new Error('state() applies a curve');
	// The page's `saved` equals the applied curve, but it was saved to another cable.
	const sameAsApplied = { bands: applied.bands, preampDb: applied.preampDb };
	expect(liveUnsaved(state({ savedCrc: 2 }), sameAsApplied)).toBe(true);
	expect(liveUnsaved(state({ savedCrc: 1 }), { bands: [OFF], preampDb: 0 })).toBe(false);
	expect(liveUnsaved(state({ savedCrc: null }), sameAsApplied)).toBe(false);
	const kept = state({ status: 'ended', endedReason: 'stopped', savedCrc: 2 });
	expect(browserFlat({ live: kept, liveOrphan: null }, sameAsApplied)).toBe(true);
	const editor = { bands: [OFF], preampDb: 0 };
	expect(livePlaying(state({ savedCrc: 1 }), null, editor)).toBe('saved');
});

test('liveSavable: a running session, or a kept curve on the connected write target', () => {
	const at = (live: LiveState | null, deviceLabel: string | null) => ({ live, deviceLabel });
	expect(liveSavable(null)).toBe(false);
	expect(liveSavable(at(null, 'Cabo'))).toBe(false);
	expect(liveSavable(at(state(), null))).toBe(true);
	for (const endedReason of ['stopped', 'forgotten'] as const) {
		const ended = state({ status: 'ended', endedReason });
		expect(liveSavable(at(ended, 'Cabo'))).toBe(true);
		expect(liveSavable(at(ended, 'Outro'))).toBe(false);
		expect(liveSavable(at(ended, null))).toBe(false);
	}
	for (const endedReason of ['reverted', 'disconnected'] as const) {
		expect(liveSavable(at(state({ status: 'ended', endedReason }), 'Cabo'))).toBe(false);
	}
});

test('cableLiveUnsaved: the session differs from the saved curve, or an orphan preview', () => {
	const saved = { bands: [PK, OFF], preampDb: -3 };
	expect(cableLiveUnsaved(null, saved)).toBe(false);
	expect(cableLiveUnsaved({ live: state(), liveOrphan: null }, saved)).toBe(false);
	expect(cableLiveUnsaved({ live: state() }, { bands: [OFF, OFF], preampDb: -3 })).toBe(true);
	expect(
		cableLiveUnsaved({ live: null, liveOrphan: { crc: 9, at: 0, deviceLabel: 'Cabo' } }, saved)
	).toBe(true);
});

test('livePlaying: the saved curve (A), the editor (B) or another one', () => {
	const saved = { bands: [PK, OFF], preampDb: -3 };
	const editor = { bands: [OFF, OFF], preampDb: -6 };
	expect(livePlaying(state({ applied: null }), saved, editor)).toBeNull();
	expect(livePlaying(state(), saved, editor)).toBe('saved');
	expect(livePlaying(state(), null, editor, { savedCrc: 1 })).toBe('saved');
	expect(livePlaying(state(), null, saved)).toBe('editor');
	expect(livePlaying(state(), { bands: [OFF], preampDb: 0 }, editor)).toBe('other');
	// Saved and editor are the same curve: the side the user chose.
	expect(livePlaying(state(), saved, saved, { prefer: 'saved' })).toBe('saved');
	expect(livePlaying(state(), saved, saved)).toBe('editor');
});

test('liveSaveLabel says which curve a save writes', () => {
	expect(liveSaveLabel('editor')).toBe(m.cable_live_save());
	expect(liveSaveLabel(null)).toBe(m.cable_live_save());
	expect(liveSaveLabel('saved')).toBe(m.cable_live_save_playing_saved());
	expect(liveSaveLabel('other')).toBe(m.cable_live_save_playing_other());
});

test('liveHoldText / liveHoldAction cover every hold reason, for the curve it held', () => {
	const loud: LiveHoldState = { reason: 'loudness', deltaDb: 4 };
	const delta = formatNumber(4, 1);
	expect(liveHoldText(loud, 'editor')).toBe(m.cable_live_hold_loudness({ delta }));
	expect(liveHoldText(loud, 'saved')).toBe(m.cable_live_hold_loudness_saved({ delta }));
	expect(liveHoldText(loud, 'saved')).not.toBe(liveHoldText(loud, 'editor'));
	expect(liveHoldAction(loud)).toBe('loudness');
	const unknown: LiveHoldState = { reason: 'unknown-state' };
	expect(liveHoldText(unknown, 'editor')).toBe(m.cable_live_hold_unknown());
	expect(liveHoldAction(unknown)).toBe('reapply');
	const experimental: LiveHoldState = { reason: 'experimental' };
	expect(liveHoldText(experimental, 'editor')).toBe(m.cable_live_hold_experimental());
	expect(liveHoldText(experimental, 'saved')).toBe(m.cable_live_hold_experimental_saved());
	expect(liveHoldAction(experimental)).toBe('experimental');
	const reason = { code: 'f:codec' } as unknown as GateReason;
	const gate: LiveHoldState = { reason: 'gate', gateReasons: [reason] };
	expect(liveHoldText(gate, 'editor')).toBe(m.cable_live_hold_gate());
	expect(liveHoldText(gate, 'saved')).toBe(m.cable_live_hold_gate_saved());
	expect(liveHoldAction(gate)).toBeNull();
	// The send-time refusal without reasons (e.g. Modo YOLO turned off): its own text.
	expect(liveHoldText({ reason: 'gate', gateReasons: [] }, 'editor')).toBe(
		m.cable_live_hold_gate_send()
	);
	expect(liveHoldText({ reason: 'gate' }, 'saved')).toBe(m.cable_live_hold_gate_send());
});

test('a failed revert is never reported as a success, and says why', () => {
	expect(liveRevertFailureText('held')).toBe(m.cable_live_revert_failed_held());
	for (const failure of ['unknown', 'error', 'busy'] as const) {
		expect(liveRevertFailureText(failure)).toBe(m.cable_live_revert_failed_retry());
	}
	expect(liveRevertFailureText('ended')).toBe(m.cable_live_refused_no_session());
	expect(liveRevertFailureText(undefined)).toBe(m.cable_live_refused_revert_failed());
	expect(liveOutcomeText({ status: 'accepted', live: state() })).toBeNull();
	expect(
		liveOutcomeText({ status: 'refused', reason: 'revert-failed', revertFailure: 'unknown' })
	).toBe(m.cable_live_revert_failed_retry());
	expect(liveOutcomeText({ status: 'refused', reason: 'live-elsewhere' })).toBe(
		m.cable_live_refused_live_elsewhere()
	);
	// "Reaplicar" turned into a loudness hold: says why nothing was sent.
	expect(liveOutcomeText({ status: 'refused', reason: 'loudness' })).toBe(
		m.cable_live_refused_loudness()
	);
});

test('the top bar chip is wired to the cable state and the saved curve (layout)', () => {
	const layout = readFileSync(new URL('../../../src/routes/+layout.svelte', import.meta.url), 'utf8');
	expect(layout).toMatch(
		/liveUnsaved=\{app \? cableLiveUnsaved\(app\.cableState, app\.state\.curve\.lastWritten\) : false\}/
	);
});
