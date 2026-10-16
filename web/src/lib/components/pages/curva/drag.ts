/**
 * Gate-bounded editing of one band parameter through the gate worker client.
 *
 * Flow (plan §3.3 "Arrastar"): `client.drag` bisects between the last accepted value and the
 * requested one on the advisory drag grid and returns the snapped accepted point plus the first
 * refused candidate's reasons; the band is rounded to the UI grid (gain 0.1 dB, f 1 Hz, Q 0.01)
 * and revalidated with `client.commit` (full grid, the verdict a write uses). A commit refusal
 * keeps the previous curve.
 */
import { roundToGrid } from 'open-auri/safety';
import type {
	CommitInput,
	CommitResult,
	DragInput,
	DragResult
} from '#lib/workers/gate-handler.ts';
import { bandValue, hasGain, replaceBand, type Band, type Curve, type DragParam } from './model.ts';
import type { Reason } from './reasons.ts';

/** The part of `createGateWorker()` this page needs; tests inject a fake. */
export interface GateClient {
	drag(input: Omit<DragInput, 'type'>): Promise<DragResult>;
	commit(input: Omit<CommitInput, 'type'>): Promise<CommitResult>;
}

export interface DragOutcome {
	/** Bands after the move (the original bands when nothing could be accepted). */
	bands: Band[];
	preampDb: number;
	/** Whether the requested value was refused and the band stopped at the boundary. */
	stopped: boolean;
	/** Plain-language reasons come from these gate codes. */
	reasons: Reason[];
	/** Whether the full-grid commit approved the result (always true for `accepted`). */
	committed: boolean;
}

export function isAbortError(error: unknown): boolean {
	if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
		return error.name === 'AbortError';
	}
	return error instanceof Error && error.name === 'AbortError';
}

export interface DragTarget {
	freqHz?: number;
	gainDb?: number;
	qFactor?: number;
}

/**
 * Advisory move (pointer move): one worker drag per changed parameter, frequency first. Stops at
 * the first parameter the gate refuses and returns where it stopped. No commit here.
 */
export async function dragBand(
	client: GateClient,
	curve: Curve,
	bandIndex: number,
	target: DragTarget,
	experimental: boolean
): Promise<DragOutcome> {
	let bands = curve.bands.slice();
	let stopped = false;
	let reasons: Reason[] = [];
	const params: DragParam[] = ['freqHz', 'gainDb', 'qFactor'];
	for (const param of params) {
		const to = target[param];
		const band = bands[bandIndex];
		if (to === undefined || !band) continue;
		if (param === 'gainDb' && !hasGain(band)) continue;
		const from = bandValue(band, param);
		if (from === null || from === to) continue;
		const result = await client.drag({
			bands,
			preampDb: curve.preampDb,
			bandIndex,
			param,
			from,
			to,
			experimental
		});
		bands = result.bands.slice();
		if (result.firstRefused) {
			stopped = true;
			reasons = result.reasons;
			break;
		}
	}
	return { bands, preampDb: curve.preampDb, stopped, reasons, committed: false };
}

/** Rounds the moved band to the UI grid and revalidates the whole curve on the full grid. */
export async function commitBand(
	client: GateClient,
	original: Curve,
	moved: DragOutcome,
	bandIndex: number,
	experimental: boolean
): Promise<DragOutcome> {
	const band = moved.bands[bandIndex];
	if (!band) return { ...moved, bands: original.bands.slice(), committed: false };
	const bands = replaceBand(moved.bands, bandIndex, roundToGrid(band));
	const { verdict } = await client.commit({ bands, preampDb: moved.preampDb, experimental });
	if (verdict.ok) return { ...moved, bands, committed: true };
	return {
		bands: original.bands.slice(),
		preampDb: original.preampDb,
		stopped: true,
		reasons: verdict.reasons,
		committed: false
	};
}

/** Keyboard and typed values: drag to the target, then round and commit in one step. */
export async function moveBand(
	client: GateClient,
	curve: Curve,
	bandIndex: number,
	target: DragTarget,
	experimental: boolean
): Promise<DragOutcome> {
	const moved = await dragBand(client, curve, bandIndex, target, experimental);
	return commitBand(client, curve, moved, bandIndex, experimental);
}
