/**
 * Loading a journal entry into the editor (Cabo). Editor-only, but never ungated:
 * - an entry written in Modo YOLO (`profile: 'yolo'`) loads only while YOLO is on in this tab,
 *   and only if the YOLO gate (class 1 and `d:prefix-peak-full`) still accepts it;
 * - any other entry loads only if the standard gate accepts it.
 * Interrupted and simulated entries follow the same rules.
 */
import { gateForWrite, isExperimentalKind } from 'open-auri/safety';
import type { JournalEntry } from '#lib/cable/types.ts';

export type LoadDecision =
	| { load: true; profile: 'standard' | 'yolo' }
	| { load: false; reason: 'yolo-off' | 'gate' };

export function loadDecision(
	entry: Pick<JournalEntry, 'bands' | 'preampDb' | 'profile'>,
	yoloEnabled: boolean
): LoadDecision {
	const experimental = entry.bands.some((band) => isExperimentalKind(band.kind));
	if (entry.profile === 'yolo') {
		if (!yoloEnabled) return { load: false, reason: 'yolo-off' };
		const verdict = gateForWrite(entry.bands, entry.preampDb, { experimental, profile: 'yolo' });
		return verdict.ok ? { load: true, profile: 'yolo' } : { load: false, reason: 'gate' };
	}
	const verdict = gateForWrite(entry.bands, entry.preampDb, { experimental });
	return verdict.ok ? { load: true, profile: 'standard' } : { load: false, reason: 'gate' };
}
