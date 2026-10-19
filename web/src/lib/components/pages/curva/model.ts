import type { designSection } from 'open-auri/dsp';
import { gateForWrite, isExperimentalKind, isUltrasonic } from 'open-auri/safety';
import type { GateVerdict } from './reasons.ts';

export type Band = Parameters<typeof designSection>[0];
export type BandKind = Band['kind'];
export interface Curve {
	readonly bands: readonly Band[];
	readonly preampDb: number;
}
export type DragParam = 'freqHz' | 'gainDb' | 'qFactor';

export function hasExperimental(bands: readonly Band[]): boolean {
	return bands.some((band) => isExperimentalKind(band.kind));
}

/**
 * Whether any section of a curve (or of a band list) sits above 20 kHz (core `isUltrasonic`: a
 * filter section whose frequency is not a number at most `AUDIBLE_MAX_HZ`; OFF never does). Such
 * a curve is edited only in Engenharia (`layers.ts`) and asks for the experimental confirmation
 * before a write (`cable/checklist.ts`). The gate's `experimental` flag stays kind-based.
 */
export function hasUltrasonic(source: Curve | readonly Band[]): boolean {
	const bands = 'bands' in source ? source.bands : source;
	return bands.some((band) => isUltrasonic(band));
}

export function hasGain(band: Band): band is Extract<Band, { kind: 'PK' | 'LS' | 'HS' }> {
	return band.kind === 'PK' || band.kind === 'LS' || band.kind === 'HS';
}

export function activeCount(bands: readonly Band[]): number {
	return bands.filter((band) => band.kind !== 'OFF').length;
}

/**
 * Full-grid verdict, the same one a write uses. Experimental kinds pass only with the flag.
 * `'yolo'` (Modo YOLO, also during the free preview): the core's YOLO profile, class 2 waived.
 */
export function verdictFor(curve: Curve, profile: 'standard' | 'yolo' = 'standard'): GateVerdict {
	const experimental = hasExperimental(curve.bands);
	const verdict = gateForWrite(
		curve.bands,
		curve.preampDb,
		profile === 'yolo' ? { experimental, profile: 'yolo' } : { experimental }
	);
	// Core names the first prefix over the limit; older cores sent no stage, so fall back to the
	// stage of the measured maximum. Presentation only: the verdict itself is unchanged.
	const stage = verdict.metrics.internalAudible?.stage;
	if (stage === undefined) return verdict;
	return {
		...verdict,
		reasons: verdict.reasons.map((reason) =>
			reason.code === 'd:prefix-peak' && reason.stage === undefined ? { ...reason, stage } : reason
		)
	};
}

export function replaceBand(bands: readonly Band[], index: number, band: Band): Band[] {
	return bands.map((current, i) => (i === index ? band : current));
}

export function bandValue(band: Band, param: DragParam): number | null {
	if (band.kind === 'OFF') return null;
	if (param === 'gainDb') return hasGain(band) ? band.gainDb : null;
	return band[param];
}
