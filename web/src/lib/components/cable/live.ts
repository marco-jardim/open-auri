/**
 * Presentation helpers of the live (no-flash) cable preview ("Ouvir no cabo", issue #69):
 * whether a session runs, whether the cable plays something other than the saved curve (the
 * amber "No cabo: prévia não salva" chip, on the Curva page and in the top bar) and the copy of
 * a refused live action. Pure reads of `CableState.live`; no cable I/O here.
 */
import { m } from '#lib/paraglide/messages.js';
import type { LiveRefusalReason, LiveState } from '#lib/cable/types.ts';

/** A curve as the editor and the cable see it (bands in wire order, preamp). */
export interface LiveCurveView {
	readonly bands: readonly object[];
	readonly preampDb: number;
}

/** A session is running (not ended): edits follow, holds and confirmations apply. */
export function liveActive(live: LiveState | null | undefined): live is LiveState {
	return live !== null && live !== undefined && live.status !== 'ended';
}

function field(band: object, key: string): unknown {
	return (band as Record<string, unknown>)[key];
}

/** Same curve as the cable reads it: kind, frequency, Q, gain and preamp (key order ignored). */
export function sameCurve(a: LiveCurveView, b: LiveCurveView): boolean {
	if (a.preampDb !== b.preampDb || a.bands.length !== b.bands.length) return false;
	return a.bands.every((band, index) => {
		const other = b.bands[index];
		if (other === undefined) return false;
		if (field(band, 'kind') !== field(other, 'kind')) return false;
		if (field(band, 'kind') === 'OFF') return true;
		return ['freqHz', 'qFactor', 'gainDb'].every((key) => field(band, key) === field(other, key));
	});
}

/**
 * The cable plays a live curve that is not the saved one: a session whose applied curve differs
 * from `saved` (or whose state is unknown), or an ended session the cable still plays (`stopped`:
 * kept until unplugged; `forgotten`: the page let go of a cable that is still plugged in). An
 * unplugged or reverted cable is back on its saved curve. `saved` null: nothing to compare
 * against, so any applied live curve counts as unsaved.
 */
export function liveUnsaved(
	live: LiveState | null | undefined,
	saved: LiveCurveView | null | undefined
): boolean {
	if (live === null || live === undefined) return false;
	if (live.status === 'ended') {
		if (live.endedReason !== 'stopped' && live.endedReason !== 'forgotten') return false;
	} else if (live.status === 'unknown') {
		return true;
	}
	const applied = live.applied;
	if (applied === null) return false;
	return saved === null || saved === undefined || !sameCurve(applied, saved);
}

/** Copy of a refused live action (`LiveRefusalReason`). */
export const liveRefusalText: Record<LiveRefusalReason, () => string> = {
	gesture: () => m.cable_live_refused_gesture(),
	busy: () => m.cable_live_refused_busy(),
	'no-device': () => m.cable_live_refused_no_device(),
	checklist: () => m.cable_live_refused_checklist(),
	unavailable: () => m.cable_live_refused_unavailable(),
	'no-session': () => m.cable_live_refused_no_session(),
	'no-hold': () => m.cable_live_refused_no_hold(),
	gate: () => m.cable_live_refused_gate(),
	'no-saved-curve': () => m.cable_live_refused_no_saved_curve(),
	'revert-failed': () => m.cable_live_refused_revert_failed(),
	'live-elsewhere': () => m.cable_live_refused_live_elsewhere(),
	error: () => m.cable_live_refused_error()
};
