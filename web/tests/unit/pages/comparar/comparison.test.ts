import { describe, expect, test } from 'vitest';
import { curveResponseDb, distance } from 'open-auri/dsp';
import { numberLabel } from '#lib/charts/scales.ts';
import {
	initialTracks,
	visibleTracks,
	compareCurves,
	patchBay,
	blendTarget,
	snapshotCurve
} from '#lib/components/pages/comparar/comparison.ts';

describe('eight-track comparison', () => {
	test('eight independent curve snapshots, fixed IDs and colors', () => {
		const tracks = initialTracks();
		expect(tracks).toHaveLength(8);
		expect(new Set(tracks.map((track) => track.id)).size).toBe(8);
		expect(new Set(tracks.map((track) => track.color)).size).toBe(8);
		expect(tracks.every((track) => track.curve.bands.length === 10)).toBe(true);
		const snapshot = snapshotCurve(tracks[1].curve);
		expect(snapshot.bands).not.toBe(tracks[1].curve.bands);
		expect(snapshot.bands).toEqual(tracks[1].curve.bands);
	});

	test('ARM, SOLO and MUTE determine only visible curves', () => {
		const tracks = initialTracks();
		expect(visibleTracks(tracks).map((track) => track.id)).toEqual([1, 2, 3, 4]);
		tracks[1].solo = true;
		expect(visibleTracks(tracks).map((track) => track.id)).toEqual([2]);
		tracks[1].mute = true;
		expect(visibleTracks(tracks).map((track) => track.id)).toEqual([1, 3, 4]);
	});

	test('S4 RMS, regions and max use the core distance, and swap changes delta sign', () => {
		const [a, b] = initialTracks();
		const comparison = compareCurves(a.curve, b.curve, false, 1);
		const expected = distance(a.curve, b.curve, { levelMatch: false, thresholdDb: 1 });
		expect(comparison.rmsDb).toBe(expected.rmsDb);
		expect(comparison.maxDb).toBe(expected.maxDb);
		expect(comparison.maxFreqHz).toBe(expected.maxFreqHz);
		expect(comparison.regions).toEqual(expected.regions);
		const swapped = compareCurves(b.curve, a.curve, false, 1);
		expect(swapped.rmsDb).toBe(comparison.rmsDb);
		comparison.delta.forEach((value, index) =>
			expect(swapped.delta[index]).toBeCloseTo(-value, 12)
		);
	});

	test('matching removes a constant offset without boosting either curve', () => {
		const curve = initialTracks()[0].curve;
		const other = { ...curve, preampDb: -7.5 };
		expect(compareCurves(curve, other, false, 1).rmsDb).toBeCloseTo(7, 8);
		const result = compareCurves(curve, other, true, 1);
		expect(result.rmsDb).toBeLessThan(0.00001);
		expect(result.regions).toEqual([]);
		expect(result.trims.every((trim) => trim <= 0)).toBe(true);
	});

	test('patch bay is symmetric with zero diagonal and excludes only unarmed tracks', () => {
		const tracks = initialTracks();
		tracks[0].mute = true;
		const matrix = patchBay(tracks, true, 1);
		expect(matrix).toHaveLength(4);
		matrix.forEach((row, i) =>
			row.forEach((cell, j) => {
				expect(cell).toBeCloseTo(matrix[j][i], 10);
				if (i === j) expect(cell).toBe(0);
			})
		);
		expect(matrix[0][1]).toBe(compareCurves(tracks[0].curve, tracks[1].curve, true, 1).rmsDb);
		expect(
			patchBay(
				tracks.map((track) => ({ ...track, armed: false })),
				true,
				1
			)
		).toEqual([]);
	});

	test('C3 is base plus 0–150% of the dB delta, without mutating inputs', () => {
		const [a, b, base] = initialTracks();
		const before = JSON.stringify([a, b, base]);
		const baseResponse = curveResponseDb(base.curve);
		const beforeResponse = curveResponseDb(a.curve);
		const afterResponse = curveResponseDb(b.curve);
		for (const percent of [0, 50, 100, 150]) {
			const target = blendTarget(base.curve, a.curve, b.curve, percent);
			const expected = baseResponse.map(
				(value, index) => value + (percent / 100) * (afterResponse[index] - beforeResponse[index])
			);
			expect(target).toEqual(expected);
		}
		expect(JSON.stringify([a, b, base])).toBe(before);
		for (const percent of [-1, 151, NaN, Infinity])
			expect(() => blendTarget(base.curve, a.curve, b.curve, percent)).toThrow(RangeError);
	});

	test('numbers use decimal comma/dot and a real minus in both locales', () => {
		expect(numberLabel(-1.25, 'pt-BR', 2)).toBe('−1,25');
		expect(numberLabel(-1.25, 'en-US', 2)).toBe('−1.25');
	});
});
