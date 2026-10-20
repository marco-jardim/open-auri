import { GRID, curveResponseDb, distance, levelDb, snapshotBands } from 'open-auri/dsp';
import { OFFICIAL_PRESETS, NEUTRO } from 'open-auri/catalog';
import { matchGains, type PreviewCurve } from '#lib/audio/engine.ts';
import type { CurveData } from '#lib/state/model.ts';
import { isHidden, type HiddenList } from '#lib/social/hidden.ts';

export type NamedCurve = CurveData;

/** Older saved community curves retain a source id even without transient author provenance. */
export function communityHidden(
	curve: { source?: string; community?: NamedCurve['community'] },
	hidden: HiddenList
): boolean {
	const lineageId =
		curve.community?.lineageId ??
		(curve.source?.startsWith('community:') ? curve.source.slice(10) : null);
	return !!lineageId && isHidden(hidden, lineageId, curve.community?.author);
}

export interface Track {
	id: number;
	curve: NamedCurve;
	armed: boolean;
	mute: boolean;
	solo: boolean;
	color: string;
}

export const TRACK_COLORS = [
	'#f2b33d',
	'#72c6b2',
	'#d99bce',
	'#8ab9ea',
	'#e69e77',
	'#c1c87a',
	'#ac9de0',
	'#e1cba1'
];

export function snapshotCurve(curve: NamedCurve): NamedCurve {
	return { ...curve, bands: snapshotBands(curve.bands) };
}

export function initialTracks(): Track[] {
	const curves = [NEUTRO, ...OFFICIAL_PRESETS.slice(0, 7)];
	return curves.map((curve, index) => ({
		id: index + 1,
		curve: snapshotCurve({ ...curve, name: curve.label, source: `preset:${curve.id}` }),
		armed: index < 4,
		mute: false,
		solo: false,
		color: TRACK_COLORS[index] ?? TRACK_COLORS[0]
	}));
}

export function visibleTracks(tracks: readonly Track[]): Track[] {
	const solo = tracks.some((track) => track.armed && track.solo && !track.mute);
	return tracks.filter((track) => track.armed && !track.mute && (!solo || track.solo));
}

/** The same attenuation-only trims drive the graph, S4, patch bay and audible A/B. */
export function compareCurves(
	a: PreviewCurve,
	b: PreviewCurve,
	matched: boolean,
	thresholdDb: number
) {
	return compareResponses(
		curveResponseDb(a),
		curveResponseDb(b),
		[levelDb(a.bands, a.preampDb), levelDb(b.bands, b.preampDb)],
		matched,
		thresholdDb
	);
}

function compareResponses(
	a: readonly number[],
	b: readonly number[],
	levels: readonly number[],
	matched: boolean,
	thresholdDb: number
) {
	const trims = matched ? matchGains(levels) : [0, 0];
	const left = a.map((value) => value + trims[0]);
	const right = b.map((value) => value + trims[1]);
	return {
		left,
		right,
		delta: right.map((value, index) => value - left[index]),
		trims,
		...distance(left, right, { levelMatch: false, thresholdDb })
	};
}

export function patchBay(tracks: readonly Track[], matched: boolean, thresholdDb: number) {
	const armed = tracks.filter((track) => track.armed);
	const responses = armed.map((track) => curveResponseDb(track.curve));
	const levels = armed.map((track) => levelDb(track.curve.bands, track.curve.preampDb));
	const matrix = armed.map(() => armed.map(() => 0));
	// Evaluate each curve once, and each pair once; threshold changes do not redesign N² curves.
	for (let i = 0; i < armed.length; i++) {
		for (let j = i + 1; j < armed.length; j++) {
			const result = compareResponses(
				responses[i],
				responses[j],
				[levels[i], levels[j]],
				matched,
				thresholdDb
			);
			matrix[i][j] = result.rmsDb;
			matrix[j][i] = result.rmsDb;
		}
	}
	return matrix;
}

/** C3 adds a fraction of B − A in dB, not a crossfade of two audio signals. */
export function blendTarget(base: PreviewCurve, a: PreviewCurve, b: PreviewCurve, percent: number) {
	if (!Number.isFinite(percent) || percent < 0 || percent > 150) {
		throw new RangeError('Blend must be between 0 and 150 percent');
	}
	const before = curveResponseDb(a);
	const after = curveResponseDb(b);
	return curveResponseDb(base).map(
		(value, index) => value + (percent / 100) * (after[index] - before[index])
	);
}

export { GRID };
