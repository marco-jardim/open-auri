/**
 * Gate-bounded editing of one band parameter through the gate worker client.
 *
 * Flow (plan §3.3 "Arrastar"): `client.drag` bisects between the last accepted value and the
 * requested one on the advisory drag grid and returns the snapped accepted point plus the first
 * refused candidate's reasons; the band is rounded to the UI grid (gain 0.1 dB, f 1 Hz, Q 0.01)
 * and revalidated with `client.commit` (full grid, the verdict a write uses). A commit refusal
 * keeps the previous curve.
 *
 * The page uses `dragBand` only as an advisory verdict while the pointer moves (the handle follows
 * the pointer freely) and `releaseBand` on release: exact target first, else the last safe point
 * on the way, else the start curve. Nothing here touches the cable.
 */
import { roundToGrid } from 'open-auri/safety';
import type {
	CommitInput,
	CommitResult,
	DragInput,
	DragResult,
	EditorProfile
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
 * Advisory state of the handle being moved: `checking` until the worker answers for the latest
 * position, then `inside` or `outside` the envelope. Never blocks the pointer; only a release
 * (full grid) decides.
 */
export interface DragView {
	index: number;
	status: 'checking' | 'inside' | 'outside';
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
	const { verdict, accepted } = await client.commit({
		bands,
		preampDb: moved.preampDb,
		experimental
	});
	// `accepted` differs from `verdict.ok` only in the free preview (codec-only, never written).
	if (accepted ?? verdict.ok) return { ...moved, bands, committed: true };
	return {
		bands: original.bands.slice(),
		preampDb: original.preampDb,
		stopped: true,
		reasons: verdict.reasons,
		committed: false
	};
}

export type ReleaseOutcome = 'exact' | 'snapped' | 'reverted';

export interface ReleaseResult extends DragOutcome {
	/** `exact`: the target passed; `snapped`: the band stopped at the last safe point on the way;
	 * `reverted`: nothing between the start and the target passed, the start curve is kept. */
	outcome: ReleaseOutcome;
}

/**
 * Release of a free drag (and keyboard/wheel/typed values): the target itself, rounded to the UI
 * grid, is judged on the full grid first. When it is refused, the band is walked back towards the
 * start (worker bisection) and that boundary is committed; when even that fails, the start curve
 * stays. Every accepted result passed `client.commit` (full grid), the verdict a write uses.
 */
export async function releaseBand(
	client: GateClient,
	curve: Curve,
	bandIndex: number,
	target: DragTarget,
	experimental: boolean,
	/** Whether the start curve passes the gate; the walk back needs an accepted start. */
	startAccepted = true
): Promise<ReleaseResult> {
	const band = curve.bands[bandIndex];
	if (!band || band.kind === 'OFF') {
		return {
			bands: curve.bands.slice(),
			preampDb: curve.preampDb,
			stopped: false,
			reasons: [],
			committed: false,
			outcome: 'reverted'
		};
	}
	const moved = withTarget(band, target);
	const exact = await commitBand(
		client,
		curve,
		{
			bands: replaceBand(curve.bands, bandIndex, moved),
			preampDb: curve.preampDb,
			stopped: false,
			reasons: [],
			committed: false
		},
		bandIndex,
		experimental
	);
	if (exact.committed) return { ...exact, outcome: 'exact' };
	const walked = startAccepted
		? await moveBand(client, curve, bandIndex, target, experimental)
		: null;
	if (walked?.committed && !sameBand(walked.bands[bandIndex], band)) {
		// Explain with the reason of the target the user asked for, not of a later candidate.
		return { ...walked, stopped: true, reasons: exact.reasons, outcome: 'snapped' };
	}
	return {
		bands: curve.bands.slice(),
		preampDb: curve.preampDb,
		stopped: true,
		reasons: exact.reasons,
		committed: false,
		outcome: 'reverted'
	};
}

/**
 * The gate client with the editor profile added to every drag and commit, read at call time
 * (Modo YOLO: `'yolo'`, handles may pass class-2 limits while class 1 still snaps; free preview:
 * `'codec'`, codec-only). Standard by default, so a missing profile is never laxer.
 */
export function withProfile(client: GateClient, profile: () => EditorProfile): GateClient {
	return {
		...client,
		drag: (input) => client.drag({ ...input, profile: profile() }),
		commit: (input) => client.commit({ ...input, profile: profile() })
	};
}

/** The band with the target's parameters applied (gain only where the kind has one). */
export function withTarget(band: Band, target: DragTarget): Band {
	if (band.kind === 'OFF') return band;
	const freqHz = target.freqHz ?? band.freqHz;
	const qFactor = target.qFactor ?? band.qFactor;
	if (hasGain(band)) return { ...band, freqHz, qFactor, gainDb: target.gainDb ?? band.gainDb };
	return { ...band, freqHz, qFactor };
}

function sameBand(a: Band | undefined, b: Band): boolean {
	if (!a || a.kind !== b.kind || a.kind === 'OFF' || b.kind === 'OFF') return false;
	const gainA = hasGain(a) ? a.gainDb : 0;
	const gainB = hasGain(b) ? b.gainDb : 0;
	return a.freqHz === b.freqHz && a.qFactor === b.qFactor && gainA === gainB;
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
