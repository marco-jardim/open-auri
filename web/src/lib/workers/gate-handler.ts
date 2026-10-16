import { designSection } from 'open-auri/dsp';
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

export interface CurveInput {
	bands: readonly Band[];
	preampDb: number;
	experimental?: boolean;
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
}

export type GateResponse = DragResult | CommitResult;

/** Pure entry point shared by the worker, SSR fallback and unit tests. */
export function handleGateRequest(request: GateRequest): GateResponse {
	const { id, bands, preampDb, experimental } = request;
	if (request.type === 'commit') {
		return { type: 'commit', id, verdict: gateForWrite(bands, preampDb, { experimental }) };
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
	const evaluate = (band: Band) => gate(withBand(band), preampDb, { experimental, grid: 'drag' });
	if (!evaluate(start).ok) throw new RangeError('Drag must start at an accepted point');

	const refused: NonNullable<DragResult['firstRefused']>[] = [];
	const accepted = (band: Band) => {
		const verdict = evaluate(band);
		if (!verdict.ok && refused.length === 0 && band.kind !== 'OFF') {
			refused.push({ value: band[param] ?? 0, reasons: verdict.reasons });
		}
		return verdict.ok;
	};
	const boundary = boundarySearch(start, target, accepted, { interpolate: interpolateBand });
	const snapped = snapToGridAccepted(boundary, start, accepted);
	const verdict = evaluate(snapped);
	if (snapped.kind === 'OFF' || !verdict.ok) throw new Error('Accepted drag invariant failed');
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
