/**
 * `planComparison` (issues #73/#74, slice 1): gated, level-matched comparison sets for the live
 * cable preview. Pure: no service, no cable.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { THRESHOLDS, gateForWrite, levelDb } from 'open-auri/safety';
import { planComparison } from '../../../src/lib/cable/compare.ts';
import type { Band, ComparisonCurve } from '../../../src/lib/cable/types.ts';
import { off } from './harness.ts';

/** Preamps at which the mocked gate refuses (to exercise the re-check of a matched curve). */
const hook = vi.hoisted(() => ({ failAt: null as number | null }));

vi.mock('open-auri/safety', async (importOriginal) => {
	const actual = await importOriginal<typeof import('open-auri/safety')>();
	return {
		...actual,
		gateForWrite(...args: Parameters<typeof actual.gateForWrite>) {
			const verdict = actual.gateForWrite(...args);
			const [bands, preampDb, options] = args;
			if (hook.failAt === null || preampDb !== hook.failAt) return verdict;
			// A real failing verdict's reasons (below the preamp floor).
			const failing = actual.gateForWrite(bands, -30, options);
			return { ...verdict, ok: false, reasons: failing.reasons };
		}
	};
});

afterEach(() => {
	hook.failAt = null;
});

const OFF_BANDS: Band[] = Array.from({ length: 10 }, off);

function offCurve(preampDb: number): ComparisonCurve {
	return { bands: OFF_BANDS, preampDb };
}

function pkCurve(preampDb: number, gainDb = 3, freqHz = 1000): ComparisonCurve {
	return {
		bands: [{ kind: 'PK', freqHz, gainDb, qFactor: 1 }, ...OFF_BANDS.slice(1)],
		preampDb
	};
}

function hsCurve(preampDb: number): ComparisonCurve {
	return {
		bands: [{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }, ...OFF_BANDS.slice(1)],
		preampDb,
		experimental: true
	};
}

function crcOf(curve: ComparisonCurve, experimental = false): number {
	const verdict = gateForWrite(curve.bands, curve.preampDb, { experimental });
	expect(verdict.ok).toBe(true);
	return Number(verdict.metrics.payloadCrc);
}

function levelOf(curve: ComparisonCurve): number {
	return levelDb(curve.bands, curve.preampDb);
}

describe('planComparison', () => {
	test('matching never makes a candidate louder; residual ≤ 0.1 dB; ack = max', () => {
		const curves = [pkCurve(-6, 3), offCurve(-9), pkCurve(-7.3, 2, 2000), offCurve(-8.05)];
		const plan = planComparison(curves, { match: true });
		expect(plan.refusal).toBeUndefined();
		expect(plan.items).toHaveLength(4);
		const target = Math.min(...curves.map(levelOf));
		expect(plan.targetLevelDb).toBeCloseTo(target, 9);
		for (const item of plan.items) {
			const original = curves[item.index] as ComparisonCurve;
			expect(item.preampDb).toBeLessThanOrEqual(original.preampDb);
			expect(item.levelDb).toBeLessThanOrEqual(levelOf(original) + 1e-9);
			// The Q23 preamp is not exactly linear in dB: a few µdB of slack.
			expect(item.levelDb).toBeLessThanOrEqual(target + 1e-3);
			expect(Math.abs(item.residualDb)).toBeLessThanOrEqual(0.1 + 1e-9);
			expect(item.residualDb).toBeCloseTo(item.levelDb - target, 9);
			expect(item.levelDb).toBeCloseTo(levelDb(item.bands, item.preampDb), 9);
			// Lowered ones sit on the 0.1 dB grid.
			if (item.matched) expect(Math.round(item.preampDb * 10) / 10).toBe(item.preampDb);
		}
		expect(plan.ackLevelDb).toBe(Math.max(...plan.items.map((item) => item.levelDb)));
	});

	test('random sets: never louder, residual ≤ 0.1 dB', () => {
		let seed = 7;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		for (let round = 0; round < 40; round++) {
			const curves = Array.from({ length: 2 + Math.floor(random() * 3) }, () =>
				random() < 0.5
					? offCurve(-Math.round(10 + random() * 150) / 10)
					: pkCurve(-Math.round(60 + random() * 100) / 10, Math.round(random() * 40) / 10)
			);
			const plan = planComparison(curves, { match: true });
			expect(plan.refusal).toBeUndefined();
			for (const item of plan.items) {
				const original = curves[item.index] as ComparisonCurve;
				expect(item.levelDb).toBeLessThanOrEqual(levelOf(original) + 1e-9);
				expect(Math.abs(item.residualDb)).toBeLessThanOrEqual(0.1 + 1e-9);
			}
		}
	});

	test('the quietest candidate keeps its preamp and CRC', () => {
		const plan = planComparison([offCurve(-6), offCurve(-12)], { match: true });
		const quiet = plan.items[1];
		expect(quiet?.matched).toBe(false);
		expect(quiet?.preampDb).toBe(-12);
		expect(quiet?.crc).toBe(crcOf(offCurve(-12)));
		const loud = plan.items[0];
		expect(loud?.matched).toBe(true);
		expect(loud?.preampDb).toBe(-12);
	});

	test('a matched curve has a new CRC (that of the lowered preamp)', () => {
		const curves = [pkCurve(-6, 3), offCurve(-10)];
		const plan = planComparison(curves, { match: true });
		const item = plan.items[0];
		if (item === undefined) throw new Error('expected an item');
		expect(item.matched).toBe(true);
		expect(item.crc).not.toBe(crcOf(curves[0] as ComparisonCurve));
		expect(item.crc).toBe(crcOf({ bands: item.bands, preampDb: item.preampDb }));
		expect(item.original.crc).toBe(crcOf(curves[0] as ComparisonCurve));
		expect(item.verdict.ok).toBe(true);
		expect(Number(item.verdict.metrics.payloadCrc)).toBe(item.crc);
	});

	test('below the −25.5 dB floor the set is refused (the quiet one is never boosted)', () => {
		const plan = planComparison([pkCurve(-6, 3), offCurve(THRESHOLDS.preampMinDb)], {
			match: true
		});
		expect(plan.items).toEqual([]);
		expect(plan.ackLevelDb).toBeNull();
		expect(plan.refusal).toMatchObject({ reason: 'level-range', index: 0 });
		expect(plan.refusal?.preampDb).toBeLessThan(THRESHOLDS.preampMinDb);
	});

	test('the matched curve is gated again: a failure refuses the set', () => {
		const curves = [offCurve(-6), offCurve(-11.95)];
		expect(planComparison(curves, { match: true }).refusal).toBeUndefined();
		// −11.95 itself passes; −6 lowered to −12.0 (floor of −11.95) fails the mocked gate.
		hook.failAt = -12;
		const refused = planComparison(curves, { match: true });
		expect(refused.refusal).toMatchObject({ reason: 'gate', index: 0, matched: true });
		expect(refused.refusal?.gateReasons?.length).toBeGreaterThan(0);
		expect(refused.items).toEqual([]);
	});

	test('a candidate failing the gate as given refuses the set with its index', () => {
		const plan = planComparison([offCurve(-6), offCurve(0.5)], { match: true });
		expect(plan.refusal).toMatchObject({ reason: 'gate', index: 1 });
		expect(plan.refusal?.matched).toBeUndefined();
	});

	test('originals are untouched and kept', () => {
		const curves = [pkCurve(-6, 3), offCurve(-10)];
		const before = structuredClone(curves);
		const plan = planComparison(curves, { match: true });
		expect(curves).toEqual(before);
		plan.items.forEach((item, index) => {
			const original = before[index] as ComparisonCurve;
			expect(item.original.bands).toEqual(original.bands);
			expect(item.original.preampDb).toBe(original.preampDb);
			expect(item.original.levelDb).toBeCloseTo(levelOf(original), 9);
		});
		// Copies: changing the plan never reaches the caller's curves.
		const first = plan.items[0];
		if (first === undefined) throw new Error('expected an item');
		first.original.bands[0] = off();
		first.bands[0] = off();
		expect(curves).toEqual(before);
	});

	test('match off: curves as given, ack = max original level', () => {
		const curves = [pkCurve(-6, 3), offCurve(-10)];
		const plan = planComparison(curves, { match: false });
		expect(plan.refusal).toBeUndefined();
		plan.items.forEach((item, index) => {
			const original = curves[index] as ComparisonCurve;
			expect(item.matched).toBe(false);
			expect(item.preampDb).toBe(original.preampDb);
			expect(item.crc).toBe(crcOf(original));
		});
		expect(plan.ackLevelDb).toBeCloseTo(Math.max(...curves.map(levelOf)), 9);
	});

	test('experimental is the OR of the candidates', () => {
		const plan = planComparison([offCurve(-12), hsCurve(-12)], { match: true });
		expect(plan.refusal).toBeUndefined();
		expect(plan.experimental).toBe(true);
		expect(plan.experimentalRequired).toBe(true);
		expect(plan.items.map((item) => item.experimentalRequired)).toEqual([false, true]);
		const plain = planComparison([offCurve(-12), offCurve(-13)], { match: true });
		expect(plain.experimental).toBe(false);
		expect(plain.experimentalRequired).toBe(false);
	});

	test('standard profile only; at least two candidates', () => {
		expect(
			planComparison([offCurve(-12), offCurve(-13)], { match: true, profile: 'yolo' }).refusal
		).toMatchObject({ reason: 'yolo-unsupported' });
		expect(
			planComparison([offCurve(-12), { ...offCurve(-13), profile: 'yolo' }], { match: true })
				.refusal
		).toMatchObject({ reason: 'yolo-unsupported', index: 1 });
		expect(planComparison([offCurve(-12)], { match: true }).refusal).toMatchObject({
			reason: 'too-few'
		});
	});
});
