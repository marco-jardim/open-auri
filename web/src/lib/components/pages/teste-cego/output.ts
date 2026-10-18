/**
 * The blind test's output choice (Preparo, SAÍDA) from the live cable. It only declares how the
 * listener hears the test: nothing here opens, reads from or writes to the cable, and the cable
 * cannot tell which curve it holds. The only hint about that is this browser's write journal.
 */
import type { CableState, JournalEntry } from '#lib/cable/types.ts';
import type { OutputConfirmation } from './experiment.ts';

/** CRC-16 of Neutro's payload (10 × OFF, preamp −0.5 dB), as the cable service documents it. */
export const NEUTRAL_CRC = 0x4fff;

/** What the output choice reads: the cable's live state and this browser's write journal. */
export interface CableView {
	readonly state: Pick<CableState, 'mode' | 'connection' | 'devices'>;
	/** Oldest entry first, as the journal stores them. */
	readonly journal: readonly Pick<JournalEntry, 'crc' | 'status'>[];
}

/** A real cable (WebHID) is connected now; a simulated cable or no WebHID is not a cable output. */
export function cableConnected(view: CableView | null): boolean {
	return (
		view !== null &&
		view.state.mode === 'real' &&
		view.state.connection === 'connected' &&
		view.state.devices.length > 0
	);
}

/** A known non-Neutral write requires a hand pick; otherwise suggest the connected output. */
export function autoOutput(view: CableView | null): OutputConfirmation | null {
	if (!cableConnected(view)) return 'other';
	return lastWriteNotNeutral(view) ? null : 'neutral';
}

/**
 * True when the last write to a real cable journaled in this browser did not leave Neutro on it:
 * another curve, or an interrupted write. Simulated writes never reached a cable and are skipped;
 * with no real write on record nothing is known, so nothing is claimed.
 */
export function lastWriteNotNeutral(view: CableView | null): boolean {
	const journal = view?.journal ?? [];
	for (let index = journal.length - 1; index >= 0; index--) {
		const entry = journal[index];
		if (!entry || entry.status === 'simulated') continue;
		return entry.status !== 'ok' || entry.crc !== NEUTRAL_CRC;
	}
	return false;
}
