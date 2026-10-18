import { designSection, encodePayload } from 'open-auri/dsp';
import {
	boundarySearch,
	gate,
	gateForWrite,
	interpolateBand,
	snapToGridAccepted
} from 'open-auri/safety';

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
 *   return the YOLO verdict, and writing is disabled while this mode is on.
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

export type GateInput = DragInput | CommitInput;
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
}

export type GateResponse = DragResult | CommitResult;

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
export function handleGateRequest(request: GateRequest): GateResponse {
	const { id, bands, preampDb, experimental, profile } = request;
	const options = gateOptions(profile, experimental);
	if (request.type === 'commit') {
		const verdict = gateForWrite(bands, preampDb, options);
		const accepted = profile === 'codec' ? codecAccepts(bands, preampDb) : verdict.ok;
		return { type: 'commit', id, verdict, accepted };
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
