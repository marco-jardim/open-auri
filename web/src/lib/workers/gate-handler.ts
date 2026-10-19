import { designSection, encodePayload } from 'open-auri/dsp';
import {
	boundarySearch,
	gate,
	gateForWrite,
	interpolateBand,
	snapToGridAccepted
} from 'open-auri/safety';
import { curveClassification, type CurveClassification } from '../gate-verdicts.ts';

export type Band = Parameters<typeof designSection>[0];
export type GateVerdict = ReturnType<typeof gate>;
export type DragParam = 'freqHz' | 'gainDb' | 'qFactor';

/**
 * Editor gate profile.
 * - `'standard'` (default): the standard gate.
 * - `'yolo'`: Modo YOLO, the core's YOLO gate profile (class 2 waived; class 1 and
 *   `d:prefix-peak-full` still snap the handles).
 * - `'codec'`: "Prévia sem limites" (a YOLO sub-mode): drags accept any curve the codec
 *   accepts (`codecAccepts`). For listening only, behind the preview limiter: commits still
 *   return the YOLO verdict, and writing is disabled while this mode is on. A curve only the
 *   codec accepts comes back `previewOnly`: the editor keeps it in a memory-only draft and never
 *   stores it (`oa.current`, undo, other tabs).
 */
export type EditorProfile = 'standard' | 'yolo' | 'codec';

export interface CurveInput {
	bands: readonly Band[];
	preampDb: number;
	experimental?: boolean;
	profile?: EditorProfile;
}

export interface DragInput extends CurveInput {
	type: 'drag';
	bandIndex: number;
	param: DragParam;
	from: number;
	to: number;
}

export interface CommitInput extends CurveInput {
	type: 'commit';
}

/**
 * The class of a curve (core `classifyCurve`): standard, YOLO or rejected. `experimental` and
 * `profile` are ignored: the classifier derives `experimental` from the curve (HS, LP or HP), as
 * `verdictFor` and the server do, and runs both profiles itself.
 */
export interface ClassifyInput extends CurveInput {
	type: 'classify';
}

export type GateInput = DragInput | CommitInput | ClassifyInput;
export type GateRequest = GateInput & { id: number };

export interface DragResult {
	type: 'drag';
	id: number;
	value: number;
	bands: readonly Band[];
	verdict: GateVerdict;
	/** Advisory only. Call commit before accepting a completed edit for writing. */
	requiresCommit: true;
	firstRefused: { value: number; reasons: GateVerdict['reasons'] } | null;
	reasons: GateVerdict['reasons'];
}

export interface CommitResult {
	type: 'commit';
	id: number;
	verdict: GateVerdict;
	/**
	 * Whether the editor may keep the curve: `verdict.ok`, except in the free preview (`'codec'`),
	 * where the codec alone decides. Editor only: a write always re-gates (service, transport).
	 */
	accepted?: boolean;
	/**
	 * Free preview only: the codec accepts the curve but the YOLO gate refuses it. Such a curve
	 * may only be heard, behind the preview protection, from a memory-only draft: never stored,
	 * never in the undo history, never written.
	 */
	previewOnly?: true;
}

export interface ClassifyResult {
	type: 'classify';
	id: number;
	classification: CurveClassification;
}

export type GateResponse = DragResult | CommitResult | ClassifyResult;

/**
 * Codec-only predicate of the free preview ("Prévia sem limites"): the codec can encode the
 * curve (known kinds, finite values, 0 < f < 48 kHz, Q > 0, int32 Q27 words, quantized poles
 * strictly inside the unit circle, preamp <= 0). Nothing else is checked: never use it to write.
 */
export function codecAccepts(bands: readonly Band[], preampDb: number): boolean {
	try {
		encodePayload(bands, preampDb);
		return true;
	} catch {
		return false;
	}
}

/** Gate options of a profile: YOLO for both YOLO modes, never a coerced value. */
function gateOptions(profile: EditorProfile | undefined, experimental: boolean | undefined) {
	return profile === 'yolo' || profile === 'codec'
		? { experimental, profile: 'yolo' as const }
		: { experimental };
}

/** Pure entry point shared by the worker, SSR fallback and unit tests. */
export function handleGateRequest(request: DragInput & { id: number }): DragResult;
export function handleGateRequest(request: CommitInput & { id: number }): CommitResult;
export function handleGateRequest(request: ClassifyInput & { id: number }): ClassifyResult;
export function handleGateRequest(request: GateRequest): GateResponse;
export function handleGateRequest(request: GateRequest): GateResponse {
	const { id, bands, preampDb, experimental, profile } = request;
	if (request.type === 'classify') {
		// Cached by signature (gate-verdicts.ts), shared with the page's synchronous exits.
		return { type: 'classify', id, classification: curveClassification(bands, preampDb) };
	}
	const options = gateOptions(profile, experimental);
	if (request.type === 'commit') {
		const verdict = gateForWrite(bands, preampDb, options);
		if (profile !== 'codec') return { type: 'commit', id, verdict, accepted: verdict.ok };
		const accepted = codecAccepts(bands, preampDb);
		// C1: what only the codec accepts is a free-preview draft, never an editor curve.
		return accepted && !verdict.ok
			? { type: 'commit', id, verdict, accepted, previewOnly: true }
			: { type: 'commit', id, verdict, accepted };
	}
	const { bandIndex, param, from, to } = request;
	const original = bands[bandIndex];
	if (!Number.isInteger(bandIndex) || !original || original.kind === 'OFF') {
		throw new RangeError('Drag requires an active band index');
	}
	if (param === 'gainDb' && (original.kind === 'LP' || original.kind === 'HP')) {
		throw new RangeError('Pass filters have no gain control');
	}
	if (!Number.isFinite(from) || !Number.isFinite(to)) {
		throw new RangeError('Drag endpoints must be finite');
	}
	const start: Band = { ...original, [param]: from };
	const target: Band = { ...original, [param]: to };
	const withBand = (band: Band) => bands.map((current, i) => (i === bandIndex ? band : current));
	const evaluate = (band: Band) => gate(withBand(band), preampDb, { ...options, grid: 'drag' });
	// Free preview: the codec decides alone; the verdict is still the YOLO one (for display).
	const acceptedBy = (band: Band, verdict: GateVerdict) =>
		profile === 'codec' ? codecAccepts(withBand(band), preampDb) : verdict.ok;
	if (!acceptedBy(start, evaluate(start))) {
		throw new RangeError('Drag must start at an accepted point');
	}

	const refused: NonNullable<DragResult['firstRefused']>[] = [];
	const accepted = (band: Band) => {
		const verdict = evaluate(band);
		const ok = acceptedBy(band, verdict);
		if (!ok && refused.length === 0 && band.kind !== 'OFF') {
			refused.push({ value: band[param] ?? 0, reasons: verdict.reasons });
		}
		return ok;
	};
	const boundary = boundarySearch(start, target, accepted, { interpolate: interpolateBand });
	const snapped = snapToGridAccepted(boundary, start, accepted);
	const verdict = evaluate(snapped);
	if (snapped.kind === 'OFF' || !acceptedBy(snapped, verdict)) {
		throw new Error('Accepted drag invariant failed');
	}
	const firstRefused = refused[0] ?? null;
	return {
		type: 'drag',
		id,
		value: snapped[param] ?? 0,
		bands: withBand(snapped),
		verdict,
		requiresCommit: true,
		firstRefused,
		reasons: firstRefused?.reasons ?? []
	};
}
