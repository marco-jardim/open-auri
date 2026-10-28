/**
 * Presentation helpers of the live (no-flash) cable preview ("Ouvir no cabo", issue #69):
 * whether a session runs, whether the cable plays something other than the saved curve (the
 * amber "No cabo: prévia não salva" chip, on the Curva page and in the top bar), whether the
 * browser preview must play flat, and the copy of holds, refusals and failed reverts. Pure reads
 * of `CableState`; no cable I/O here.
 */
import { m } from '#lib/paraglide/messages.js';
import { formatNumber } from './i18n.ts';
import type {
	CableState,
	LiveHoldState,
	LiveOutcome,
	LiveRefusalReason,
	LiveRevertFailure,
	LiveState
} from '#lib/cable/types.ts';

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

/** An ended session whose curve the cable still plays (kept until unplugged). */
function keptAfterEnd(live: LiveState): boolean {
	return live.endedReason === 'stopped' || live.endedReason === 'forgotten';
}

/**
 * The applied curve is the saved one. When the service knows the session cable's own saved curve
 * (`live.savedCrc`), that decides: a save to another cable (the page's `saved`) never counts.
 * Otherwise: equal to `saved`, or the curve an accepted revert left on the cable (`savedCrc`, for a
 * revert to the service's own saved curve).
 */
function playsSaved(
	live: LiveState,
	saved: LiveCurveView | null | undefined,
	savedCrc: number | null | undefined
): boolean {
	const applied = live.applied;
	if (applied === null) return false;
	const own = live.savedCrc;
	if (typeof own === 'number') return applied.crc === own;
	if (savedCrc !== null && savedCrc !== undefined && applied.crc === savedCrc) return true;
	return saved !== null && saved !== undefined && sameCurve(applied, saved);
}

/** The orphan preview's cable is connected (`deviceLabels` absent: unknown, taken as connected). */
function orphanConnected(
	cable: Pick<CableState, 'liveOrphan'> & Partial<Pick<CableState, 'deviceLabels'>>
): boolean {
	const orphan = cable.liveOrphan ?? null;
	if (orphan === null) return false;
	const labels = cable.deviceLabels;
	if (labels === undefined) return true;
	// The marker keeps at most 64 code points of the label.
	return labels.some(
		(label) => label === orphan.deviceLabel || [...label].slice(0, 64).join('') === orphan.deviceLabel
	);
}

/**
 * "Salvar a curva que está tocando" applies: a running session, or an ended one whose curve the
 * cable kept (`stopped`, `forgotten`) while that cable is still connected and is the write target
 * (a save goes to the target, so it must be the cable that plays the curve).
 */
export function liveSavable(
	cable: Pick<CableState, 'live' | 'deviceLabel'> | null | undefined
): boolean {
	const live = cable?.live ?? null;
	if (cable === null || cable === undefined || live === null) return false;
	if (live.status !== 'ended') return true;
	return keptAfterEnd(live) && cable.deviceLabel !== null && cable.deviceLabel === live.deviceLabel;
}

/**
 * The cable plays a live curve that is not the saved one: a session whose applied curve differs
 * from `saved` (or whose state is unknown), or an ended session the cable still plays (`stopped`:
 * kept until unplugged; `forgotten`: the page let go of a cable that is still plugged in). An
 * unplugged or reverted cable is back on its saved curve. `saved` null: nothing to compare
 * against, so any applied live curve counts as unsaved (unless an accepted revert left
 * `savedCrc` on the cable).
 */
export function liveUnsaved(
	live: LiveState | null | undefined,
	saved: LiveCurveView | null | undefined,
	savedCrc?: number | null
): boolean {
	if (live === null || live === undefined) return false;
	if (live.status === 'ended') {
		if (!keptAfterEnd(live)) return false;
	} else if (live.status === 'unknown') {
		return true;
	}
	if (live.applied === null) return false;
	return !playsSaved(live, saved, savedCrc);
}

/**
 * The top bar's chip: this tab's live preview is not the saved curve, or another tab (or this
 * one before a reload) left an orphan preview on a cable.
 */
export function cableLiveUnsaved(
	cable: Pick<CableState, 'live' | 'liveOrphan'> | null | undefined,
	saved: LiveCurveView | null | undefined
): boolean {
	if (cable === null || cable === undefined) return false;
	return (cable.liveOrphan ?? null) !== null || liveUnsaved(cable.live, saved);
}

/**
 * The browser A/B chains must play flat (no EQ): the cable already applies a curve other than
 * the saved one, so a browser EQ on top would sound twice. Flat only once the cable is known to
 * play the live curve (`applied` set, state known): while a session starts, or after a first apply
 * that failed, the cable still plays its saved curve and the EQ'd chains keep the level. After the
 * session: a curve kept on the cable (stopped, forgotten) that differs from the saved one. And an
 * orphan preview of another tab or of this one before a reload, while its cable is connected
 * (`deviceLabels`; when absent, taken as connected).
 */
export function browserFlat(
	cable:
		| (Pick<CableState, 'live' | 'liveOrphan'> & Partial<Pick<CableState, 'deviceLabels'>>)
		| null
		| undefined,
	saved: LiveCurveView | null | undefined,
	savedCrc?: number | null
): boolean {
	if (cable === null || cable === undefined) return false;
	if (orphanConnected(cable)) return true;
	const live = cable.live;
	if (live === null || live === undefined || live.applied === null) return false;
	if (live.status === 'ended') return keptAfterEnd(live) && !playsSaved(live, saved, savedCrc);
	return live.status !== 'unknown';
}

/** Which curve the cable plays, as the A/B lever and "Salvar no cabo" name it. */
export type LivePlaying = 'saved' | 'editor' | 'other';

/**
 * What the applied curve is: the saved one (A), the editor's (B) or another one (a held or failed
 * edit left the previous curve). `null` when nothing is applied yet. When saved and editor are the
 * same curve, `prefer` decides (the side the user chose).
 */
export function livePlaying(
	live: LiveState | null | undefined,
	saved: LiveCurveView | null | undefined,
	editor: LiveCurveView,
	options: { savedCrc?: number | null; prefer?: 'saved' | 'editor' } = {}
): LivePlaying | null {
	if (live === null || live === undefined || live.applied === null) return null;
	const isSaved = playsSaved(live, saved, options.savedCrc);
	const isEditor = sameCurve(live.applied, editor);
	if (isSaved && isEditor) return options.prefer ?? 'editor';
	if (isSaved) return 'saved';
	if (isEditor) return 'editor';
	return 'other';
}

/** The "Salvar no cabo" label: which curve a save writes. */
export function liveSaveLabel(playing: LivePlaying | null): string {
	switch (playing) {
		case 'saved':
			return m.cable_live_save_playing_saved();
		case 'other':
			return m.cable_live_save_playing_other();
		case 'editor':
		case null:
			return m.cable_live_save();
		default:
			return playing satisfies never;
	}
}

/** Whose curve a hold stopped: the saved one (A, a revert) or the editor's (B). */
export type LiveHeldCurve = 'saved' | 'editor';

/** What a hold offers: its confirmation (with a gesture), or nothing (gate: never sent). */
export type LiveHoldAction = 'loudness' | 'reapply' | 'experimental' | null;

/** Copy of a hold banner, for the curve it held. */
export function liveHoldText(hold: LiveHoldState, held: LiveHeldCurve): string {
	const reason = hold.reason;
	switch (reason) {
		case 'loudness': {
			const delta = formatNumber(hold.deltaDb ?? 0, 1);
			return held === 'saved'
				? m.cable_live_hold_loudness_saved({ delta })
				: m.cable_live_hold_loudness({ delta });
		}
		case 'unknown-state':
			return m.cable_live_hold_unknown();
		case 'experimental':
			return held === 'saved'
				? m.cable_live_hold_experimental_saved()
				: m.cable_live_hold_experimental();
		case 'gate':
			// No reasons: the send-time check refused it (e.g. Modo YOLO turned off meanwhile).
			if (hold.gateReasons === undefined || hold.gateReasons.length === 0) {
				return m.cable_live_hold_gate_send();
			}
			return held === 'saved' ? m.cable_live_hold_gate_saved() : m.cable_live_hold_gate();
		default:
			return reason satisfies never;
	}
}

/** The confirmation a hold offers (gate: none, a curve the gate refuses is never sent). */
export function liveHoldAction(hold: LiveHoldState): LiveHoldAction {
	const reason = hold.reason;
	switch (reason) {
		case 'loudness':
			return 'loudness';
		case 'unknown-state':
			return 'reapply';
		case 'experimental':
			return 'experimental';
		case 'gate':
			return null;
		default:
			return reason satisfies never;
	}
}

/** Copy of a revert that did not leave the cable on the saved curve. */
export function liveRevertFailureText(failure: LiveRevertFailure | undefined): string {
	switch (failure) {
		case 'held':
			return m.cable_live_revert_failed_held();
		case 'unknown':
		case 'error':
		case 'busy':
			return m.cable_live_revert_failed_retry();
		case 'ended':
			return m.cable_live_refused_no_session();
		case undefined:
			return m.cable_live_refused_revert_failed();
		default:
			return failure satisfies never;
	}
}

/** Copy of a refused live action; null when it was accepted. */
export function liveOutcomeText(outcome: LiveOutcome): string | null {
	if (outcome.status === 'accepted') return null;
	if (outcome.reason === 'revert-failed') return liveRevertFailureText(outcome.revertFailure);
	return liveRefusalText[outcome.reason]();
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
	loudness: () => m.cable_live_refused_loudness(),
	'no-saved-curve': () => m.cable_live_refused_no_saved_curve(),
	'revert-failed': () => m.cable_live_refused_revert_failed(),
	'live-elsewhere': () => m.cable_live_refused_live_elsewhere(),
	error: () => m.cable_live_refused_error()
};
