// T4.9: pure Bradley–Terry (MM iteration). Known answers, ties, the largest strongly connected
// component rule and determinism.
import { describe, expect, it } from 'vitest';
import { bradleyTerry, type BtPair } from '#lib/server/social/s6.ts';

function repeat(a: string, b: string, choice: BtPair['choice'], times: number): BtPair[] {
	return Array.from({ length: times }, () => ({ a, b, choice }));
}

function scores(pairs: BtPair[]): Record<string, number> {
	return Object.fromEntries(bradleyTerry(pairs).items.map((item) => [item.curveId, item.score]));
}

// Hand-computed: with p ∝ (4, 2, 1) the expected wins are integers (A–B 3 games: 2/3 → 2–1,
// B–C 3 games: 2/3 → 2–1, A–C 5 games: 4/5 → 4–1). Observed = expected for every pair, so the MLE
// equations W_i = Σ n_ij p_i/(p_i+p_j) hold and the unique MLE is (4, 2, 1); geometric mean 2 →
// normalized (2, 1, 0.5).
const THREE: BtPair[] = [
	...repeat('a', 'b', 'a', 2),
	...repeat('a', 'b', 'b', 1),
	...repeat('b', 'c', 'a', 2),
	...repeat('b', 'c', 'b', 1),
	...repeat('a', 'c', 'a', 4),
	...repeat('a', 'c', 'b', 1)
];

describe('bradleyTerry', () => {
	it('3-item hand-computed example: (2, 1, 0.5) after geometric-mean normalization', () => {
		const result = bradleyTerry(THREE);
		expect(result.converged).toBe(true);
		expect(result.iterations).toBeLessThan(10_000);
		expect(result.items.map((item) => item.curveId)).toEqual(['a', 'b', 'c']);
		const [a, b, c] = result.items;
		expect(a?.score).toBeCloseTo(2, 8);
		expect(b?.score).toBeCloseTo(1, 8);
		expect(c?.score).toBeCloseTo(0.5, 8);
		expect(result.items.map((item) => item.comparisons)).toEqual([8, 6, 8]);
		expect(result.excluded).toEqual([]);
	});

	it('known answer, two items: p_A/p_B = W_A/W_B → (√3, 1/√3)', () => {
		const result = scores([...repeat('x', 'y', 'a', 3), ...repeat('x', 'y', 'b', 1)]);
		expect(result.x).toBeCloseTo(Math.sqrt(3), 10);
		expect(result.y).toBeCloseTo(1 / Math.sqrt(3), 10);
	});

	it('a balanced cycle scores everyone 1', () => {
		const cycle = [
			...repeat('p', 'q', 'a', 2),
			...repeat('p', 'q', 'b', 1),
			...repeat('q', 'r', 'a', 2),
			...repeat('q', 'r', 'b', 1),
			...repeat('r', 'p', 'a', 2),
			...repeat('r', 'p', 'b', 1)
		];
		for (const value of Object.values(scores(cycle))) expect(value).toBeCloseTo(1, 10);
	});

	it('ties count half a win to each side', () => {
		// x: 1 win + 1 tie = 1.5; y: 0.5 → same ratio 3 as the 3–1 case.
		const result = scores([
			{ a: 'x', b: 'y', choice: 'a' },
			{ a: 'y', b: 'x', choice: 'tie' }
		]);
		expect(result.x).toBeCloseTo(Math.sqrt(3), 10);
		expect(result.y).toBeCloseTo(1 / Math.sqrt(3), 10);
		// Ties alone connect both ways: equal strengths.
		const tied = scores(repeat('m', 'n', 'tie', 3));
		expect(tied).toEqual({ m: 1, n: 1 });
	});

	it('only the largest strongly connected component is scored', () => {
		const result = bradleyTerry([
			// {a, b, c}: strongly connected (cycle).
			{ a: 'a', b: 'b', choice: 'a' },
			{ a: 'b', b: 'c', choice: 'a' },
			{ a: 'c', b: 'a', choice: 'a' },
			// e always beats a: nothing beats e, so e has no finite MLE.
			{ a: 'e', b: 'a', choice: 'a' },
			// d–f: one-sided, not strongly connected.
			{ a: 'd', b: 'f', choice: 'b' },
			// {g, h}: strongly connected but smaller.
			{ a: 'g', b: 'h', choice: 'a' },
			{ a: 'g', b: 'h', choice: 'b' }
		]);
		expect(result.items.map((item) => item.curveId)).toEqual(['a', 'b', 'c']);
		// Comparisons with excluded items are not counted (a has 2 inside, not the one with e).
		expect(result.items.map((item) => item.comparisons)).toEqual([2, 2, 2]);
		expect(result.excluded).toEqual(['d', 'e', 'f', 'g', 'h']);
	});

	it('equal-size components: the one with the smallest id wins; no component → no scores', () => {
		const result = bradleyTerry([
			{ a: 'm', b: 'n', choice: 'tie' },
			{ a: 'b', b: 'c', choice: 'tie' }
		]);
		expect(result.items.map((item) => item.curveId)).toEqual(['b', 'c']);
		expect(result.excluded).toEqual(['m', 'n']);

		const none = bradleyTerry([{ a: 'x', b: 'y', choice: 'a' }]);
		expect(none.items).toEqual([]);
		expect(none.excluded).toEqual(['x', 'y']);
		expect(bradleyTerry([]).items).toEqual([]);
		expect(bradleyTerry([{ a: 'z', b: 'z', choice: 'a' }]).excluded).toEqual([]);
	});

	it('is deterministic: input order and folding (weight) do not change a single bit', () => {
		const reference = bradleyTerry(THREE);
		const reversed = bradleyTerry([...THREE].reverse());
		const even = THREE.filter((_, i) => i % 2 === 0);
		const interleaved = bradleyTerry(even.concat(THREE.filter((_, i) => i % 2 === 1)));
		const folded = bradleyTerry([
			{ a: 'a', b: 'b', choice: 'a', weight: 2 },
			{ a: 'a', b: 'b', choice: 'b' },
			{ a: 'c', b: 'b', choice: 'b', weight: 2 },
			{ a: 'c', b: 'b', choice: 'a' },
			{ a: 'a', b: 'c', choice: 'a', weight: 4 },
			{ a: 'a', b: 'c', choice: 'b' }
		]);
		for (const other of [reversed, interleaved, folded]) expect(other).toEqual(reference);
		// Equal scores are ordered by id.
		expect(bradleyTerry(repeat('zz', 'aa', 'tie', 2)).items.map((i) => i.curveId)).toEqual([
			'aa',
			'zz'
		]);
	});

	it('honours the iteration cap and validates options', () => {
		const capped = bradleyTerry(THREE, { maxIterations: 1 });
		expect(capped.iterations).toBe(1);
		expect(capped.converged).toBe(false);
		expect(() => bradleyTerry(THREE, { tolerance: 0 })).toThrow(RangeError);
		expect(() => bradleyTerry(THREE, { maxIterations: 0 })).toThrow(RangeError);
		expect(() => bradleyTerry([{ a: 'a', b: 'b', choice: 'a', weight: 1.5 }])).toThrow(RangeError);
	});
});
