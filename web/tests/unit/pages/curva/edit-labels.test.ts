// Filter labels follow their bands through a reorder (patch cables, "ordem padrão"); a kind change
// keeps the slot, so it keeps the label.
import { describe, expect, test } from 'vitest';
import {
	changeKind,
	defaultOrder,
	defaultPermutation,
	movePermutation,
	moveSection,
	permuteLabels
} from '#lib/components/pages/curva/edit.ts';
import type { Band } from '#lib/components/pages/curva/model.ts';

const OFF: Band = { kind: 'OFF' };
const band = (freqHz: number, gainDb: number): Band => ({ kind: 'PK', freqHz, gainDb, qFactor: 1 });
const BANDS: Band[] = [
	band(100, 3),
	band(200, -3),
	OFF,
	band(400, 2),
	band(800, -2),
	OFF,
	band(1600, 1),
	band(3200, -1),
	OFF,
	band(6400, -4)
];
const LABELS = ['A', 'B', null, 'D', 'E', null, 'G', 'H', null, 'J'];

describe('reorder permutations move labels with their bands', () => {
	test('movePermutation is moveSection over the wire indexes', () => {
		expect(movePermutation(10, 0, 2)).toEqual([1, 2, 0, 3, 4, 5, 6, 7, 8, 9]);
		expect(movePermutation(10, 9, 0)).toEqual([9, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(movePermutation(10, 3, 3)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(movePermutation(10, -1, 4)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		for (const [from, to] of [
			[0, 9],
			[9, 0],
			[4, 1],
			[2, 7]
		] as const) {
			const order = movePermutation(10, from, to);
			const moved = moveSection(BANDS, from, to);
			const labels = permuteLabels(LABELS, order);
			order.forEach((old, index) => {
				expect(moved[index]).toEqual(BANDS[old]);
				expect(labels?.[index]).toBe(LABELS[old]);
			});
		}
	});

	test('the label of the moved section lands where its band lands', () => {
		const labels = permuteLabels(LABELS, movePermutation(10, 0, 2));
		expect(labels).toEqual(['B', null, 'A', 'D', 'E', null, 'G', 'H', null, 'J']);
		expect(moveSection(BANDS, 0, 2)[2]).toEqual(BANDS[0]);
	});

	test('defaultPermutation is the permutation defaultOrder applies', () => {
		const order = defaultPermutation(BANDS);
		const sorted = defaultOrder(BANDS);
		expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		order.forEach((old, index) => expect(sorted[index]).toEqual(BANDS[old]));
		const labels = permuteLabels(LABELS, order);
		order.forEach((old, index) => expect(labels?.[index]).toBe(LABELS[old]));
		// Cuts first, boosts next, OFF last: "B" (−3 dB) now leads, OFF labels (null) close.
		expect(labels?.[0]).toBe('B');
		expect(labels?.slice(-3)).toEqual([null, null, null]);
	});

	test('no labels stay no labels; the input is never changed', () => {
		expect(permuteLabels(null, movePermutation(10, 0, 2))).toBeNull();
		expect(permuteLabels(undefined, defaultPermutation(BANDS))).toBeNull();
		const before = [...LABELS];
		permuteLabels(LABELS, movePermutation(10, 0, 9));
		expect(LABELS).toEqual(before);
	});

	test('a kind change keeps the slot (and so its label)', () => {
		const result = changeKind({ bands: BANDS, preampDb: -6 }, 3, 'LS');
		if (!result.ok) return;
		expect(result.bands).toHaveLength(10);
		expect(result.bands[3]?.kind).toBe('LS');
		result.bands.forEach((entry, index) => {
			if (index !== 3) expect(entry).toEqual(BANDS[index]);
		});
	});
});
