/**
 * Loading a journal entry into the editor (Cabo). Editor-only, but never ungated:
 * - an entry below the editor's −25,5 dB preamp floor (`EDITOR_PREAMP_FLOOR_DB`) never loads, in
 *   any profile, and says so (`'preamp-floor'`): the YOLO gate alone waives `g:preamp`, but the
 *   editor could neither keep nor encode such a curve (S1, S5);
 * - an entry written in Modo YOLO (`profile: 'yolo'`) uses the editor's YOLO verdict while YOLO is
 *   on in this tab (`editorVerdict`: the YOLO gate plus that floor); with YOLO off it can still
 *   load if the standard gate accepts it;
 * - any other entry loads only if the standard gate accepts it.
 * Interrupted and simulated entries follow the same rules.
 */
import { gateForWrite, isExperimentalKind } from 'open-auri/safety';
import type { JournalEntry } from '#lib/cable/types.ts';
import { EDITOR_PREAMP_FLOOR_DB, editorVerdict } from '../curva/edit.ts';

export type LoadDecision =
	| { load: true; profile: 'standard' | 'yolo' }
	| { load: false; reason: 'yolo-off' | 'gate' | 'preamp-floor' };

export function loadDecision(
	entry: Pick<JournalEntry, 'bands' | 'preampDb' | 'profile'>,
	yoloEnabled: boolean
): LoadDecision {
	// C1: below the editor floor (or not a number) nothing loads, whatever the gate says.
	if (!(entry.preampDb >= EDITOR_PREAMP_FLOOR_DB)) return { load: false, reason: 'preamp-floor' };
	const experimental = entry.bands.some((band) => isExperimentalKind(band.kind));
	if (entry.profile === 'yolo' && yoloEnabled) {
		const verdict = editorVerdict({ bands: entry.bands, preampDb: entry.preampDb }, 'yolo');
		return verdict.ok ? { load: true, profile: 'yolo' } : { load: false, reason: 'gate' };
	}
	const verdict = gateForWrite(entry.bands, entry.preampDb, { experimental });
	return verdict.ok
		? { load: true, profile: 'standard' }
		: { load: false, reason: entry.profile === 'yolo' ? 'yolo-off' : 'gate' };
}
