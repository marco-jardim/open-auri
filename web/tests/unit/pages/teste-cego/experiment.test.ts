import { afterEach, describe, expect, test, vi } from 'vitest';
import { NEUTRO, OFFICIAL_PRESETS } from 'open-auri/catalog';
import { gate } from 'open-auri/safety';
import {
	bracketStage,
	candidate,
	confidence95,
	cryptoWord,
	estimatedWrites,
	nextSpread,
	officialCandidates,
	preferencePreview,
	randomIndex,
	recordRound,
	shuffle,
	startSession,
	variations,
	type Session
} from '#lib/components/pages/teste-cego/experiment.ts';

function seeded(seed: number) {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

const a = candidate('a', 'A', NEUTRO);
const b = candidate('b', 'B', NEUTRO);
const c = candidate('c', 'C', NEUTRO);
afterEach(() => vi.restoreAllMocks());

describe('unbiased order', () => {
	test('chi-square over all six permutations, 120,000 seeded shuffles', () => {
		const source = seeded(0x5eeda11);
		const counts = new Map<string, number>();
		for (let i = 0; i < 120000; i++) {
			const key = shuffle([1, 2, 3], source).join('');
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		expect(counts.size).toBe(6);
		const chiSquare = [...counts.values()].reduce(
			(sum, count) => sum + (count - 20000) ** 2 / 20000,
			0
		);
		// df=5, alpha=.001 critical value 20.515. Fixed seed means no flaky statistical test.
		expect(chiSquare).toBeLessThan(20.515);
	});
	test('rejects the biased tail rather than taking uint32 modulo 3', () => {
		const word = vi.fn().mockReturnValueOnce(0xffffffff).mockReturnValueOnce(4);
		expect(randomIndex(3, word)).toBe(1);
		expect(word).toHaveBeenCalledTimes(2);
		expect(() => randomIndex(0)).toThrow(RangeError);
		expect(() => randomIndex(3, () => -1)).toThrow(RangeError);
		expect(() => randomIndex(3, () => 2 ** 32)).toThrow(RangeError);
	});
	test('does not mutate its input and uses Web Crypto by default', () => {
		const values = Object.freeze([1, 2, 3]);
		expect(shuffle(values, () => 0)).toEqual([2, 3, 1]);
		expect(values).toEqual([1, 2, 3]);
		const spy = vi.spyOn(crypto, 'getRandomValues');
		expect(cryptoWord()).toBeGreaterThanOrEqual(0);
		expect(spy).toHaveBeenCalledOnce();
	});
});

describe('Student t 95% confidence intervals', () => {
	test('agrees with hand-computed n=5, df=4 and sample variance 2.5', () => {
		const result = confidence95([1, 2, 3, 4, 5]);
		expect(result.mean).toBe(3);
		expect(result.n).toBe(5);
		expect(result.ci?.[0]).toBeCloseTo(1.0367568385, 8);
		expect(result.ci?.[1]).toBeCloseTo(4.9632431615, 8);
	});
	test('uses t=12.706204736 for n=2, not 1.96, without clipping to rating bounds', () => {
		const result = confidence95([0, 10]);
		expect(result.ci?.[0]).toBeCloseTo(-58.53102368, 8);
		expect(result.ci?.[1]).toBeCloseTo(68.53102368, 8);
	});
	test('uses df=11 for the maximum 12-round session', () => {
		const result = confidence95([4, 6, 4, 6, 4, 6, 4, 6, 4, 6, 4, 6]);
		expect(result.ci?.[1]).toBeCloseTo(5 + 2.20098516 / Math.sqrt(11), 9);
	});
	test('handles empty, one observation, zero variance and invalid values explicitly', () => {
		expect(confidence95([])).toEqual({ n: 0, mean: null, ci: null });
		expect(confidence95([0])).toEqual({ n: 1, mean: 0, ci: null });
		expect(confidence95([5, 5, 5])).toEqual({ n: 3, mean: 5, ci: [5, 5] });
		for (const values of [[-1], [11], [NaN], [Infinity], Array<number>(32).fill(5)]) {
			expect(() => confidence95(values)).toThrow(RangeError);
		}
	});
});

describe('setup, rounds and tournament', () => {
	test('confirmation is mandatory, both outputs work, candidates and rounds are checked', () => {
		expect(() => startSession([a, b], 2, null)).toThrow('confirmation-required');
		for (const output of ['neutral', 'other'] as const) {
			expect(startSession([a, b], 2, output).order).toHaveLength(2);
		}
		expect(() => startSession([a], 2, 'other')).toThrow('candidates-required');
		expect(() => startSession([a, a], 2, 'other')).toThrow('candidates-required');
		expect(() => startSession([a, { ...b, accepted: false }], 2, 'other')).toThrow();
		expect(() => startSession([a, b], 1, 'other')).toThrow(RangeError);
		expect(() => startSession([a, b], 13, 'other')).toThrow(RangeError);
	});
	test('every round is shuffled independently and results map scores to identities, not positions', () => {
		let session = startSession([a, b, c], 3, 'neutral', seeded(123));
		const source = seeded(456);
		for (let i = 0; i < 3; i++) {
			const previous = session;
			session = recordRound(
				session,
				session.order.map((id) => ({ a: 9, b: 2, c: 0 })[id]!),
				source
			);
			expect(previous.completed).toHaveLength(i);
		}
		const stage = bracketStage(session, 2);
		expect(stage.results.map((r) => [r.candidate.id, r.mean])).toEqual([
			['a', 9],
			['b', 2],
			['c', 0]
		]);
		expect(stage.winner.id).toBe('a');
		expect(stage.tied).toBe(false);
		expect(nextSpread(stage)).toBe(1);
		expect(nextSpread({ ...stage, spread: 0.5 })).toBeNull();
		expect(nextSpread({ ...stage, spread: 0.75 })).toBeNull();
		expect(() => recordRound(session, [1, 2, 3])).toThrow('finished');
	});
	test('requires all explicit ratings, but accepts 0; one round cannot resolve a tournament', () => {
		const session = startSession([a, b], 2, 'other', seeded(1));
		for (const invalid of [[null, 1], [0], [0, 11], [0, NaN]]) {
			expect(() => recordRound(session, invalid)).toThrow('ratings-required');
		}
		const stage = bracketStage(recordRound(session, [0, 1]), 2);
		expect(stage.results.some((r) => r.mean === 0)).toBe(true);
		expect(stage.tied).toBe(true);
		expect(nextSpread(stage)).toBeNull();
		expect(() => bracketStage(session, 2)).toThrow('no-results');
	});
	test('overlap and exact ties stop rather than inventing a winner', () => {
		const session: Session = {
			candidates: [a, b],
			planned: 2,
			order: ['a', 'b'],
			completed: [
				{ order: ['a', 'b'], ratings: [5, 4] },
				{ order: ['b', 'a'], ratings: [6, 7] }
			]
		};
		expect(bracketStage(session, 2).tied).toBe(true);
		const tie = {
			...session,
			completed: session.completed.map((r) => ({ ...r, ratings: [5, 5] }))
		};
		expect(bracketStage(tie, 2).tied).toBe(true);
		expect(nextSpread(bracketStage(tie, 2))).toBeNull();
	});
});

test('all official candidates retain the catalog data; variations revalidate without changing the base', () => {
	const official = officialCandidates();
	expect(official).toHaveLength(11);
	for (const [index, item] of official.entries()) {
		expect(item.accepted).toBe(true);
		expect(item.bands).toEqual(OFFICIAL_PRESETS[index]?.bands);
		expect(item.description).toBe(OFFICIAL_PRESETS[index]?.description);
	}
	const base = official[0]!;
	const before = JSON.stringify(base);
	const generated = variations(base, 1, 1);
	expect(generated).toHaveLength(3);
	expect(JSON.stringify(base)).toBe(before);
	for (const item of generated) {
		expect(item.preampDb).toBeLessThanOrEqual(base.preampDb);
		expect(item.accepted).toBe(
			gate(item.bands, item.preampDb, { experimental: item.experimental }).ok
		);
	}
	expect(() => variations(base, 0, 1)).toThrow(RangeError);
});

test('S6 preview is an allowlist without network calls; cable cost only computes a number', () => {
	const fetchSpy = vi.spyOn(globalThis, 'fetch');
	const session = recordRound(startSession([a, b, c], 2, 'other', seeded(1)), [4, 8, 6]);
	const preview = preferencePreview(session);
	expect(preview.pairs).toHaveLength(3);
	expect(Object.keys(preview.pairs[0]!).sort()).toEqual(['a', 'b', 'ratingA', 'ratingB']);
	expect(Object.keys(preview)).toEqual(['schema', 'pairs']);
	expect(preferencePreview(null).pairs).toEqual([]);
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(estimatedWrites(6, 3)).toBe(19);
});

test('a neutral current curve produces meaningful variations using only free OFF slots', () => {
	const base = candidate('current', 'Current', NEUTRO);
	const generated = variations(base, 1, 2);
	for (const item of generated) {
		expect(item.bands.filter((band) => band.kind !== 'OFF')).toHaveLength(3);
		expect(item.accepted).toBe(true);
		expect(item.experimental).toBe(false);
	}
	expect(base.bands.every((band) => band.kind === 'OFF')).toBe(true);
});
