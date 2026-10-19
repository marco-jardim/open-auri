/**
 * The client's curve classes (`curveClassification`, gate-verdicts.ts). They follow the core's
 * `classifyCurve` rules with every gate pass read from the shared verdict cache (the core's
 * `classifyWith` is not exported), and are kept in their own LRU (`CLASSIFICATIONS_KEPT`).
 * - A second classification of a curve runs no gate; a standard pass the editor or the preview
 *   already made is reused.
 * - Equivalence with the core (class, waived codes, blocking codes, in order) on the official
 *   presets and on random curves, sections above 20 kHz and YOLO-only curves included: any drift
 *   of the copy from the core (thresholds, waivable codes, the YOLO extended checks) fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { NEUTRO, OFFICIAL_PRESETS } from 'open-auri/catalog';
import { classifyCurve, gateForWrite, isExperimentalKind } from 'open-auri/safety';
import {
	CLASSIFICATIONS_KEPT,
	clearGateVerdicts,
	curveClassification,
	gateVerdict,
	knownClassification,
	rememberClassification
} from '#lib/gate-verdicts.ts';
import type { Band } from '#lib/audio/engine.ts';

vi.mock('open-auri/safety', async (importOriginal) => {
	const actual = await importOriginal<typeof import('open-auri/safety')>();
	return { ...actual, gateForWrite: vi.fn(actual.gateForWrite) };
});

/** Full-grid gate runs of the client cache since the last reset (the core's own are not seen). */
const runs = () => vi.mocked(gateForWrite).mock.calls.length;
const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
/** Refused by the standard gate on waivable reasons only: YOLO (HP 30 Hz). */
const YOLO_ONLY = { bands: pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]), preampDb: -0.5 };
/** Complementary −6 dB shelves at −0,3 dB: YOLO (HS, g:preamp waived above the floor). */
const SHELVES = {
	bands: pad([
		{ kind: 'LS', freqHz: 1000, gainDb: -6, qFactor: 0.7 },
		{ kind: 'HS', freqHz: 1000, gainDb: -6, qFactor: 0.7 }
	]),
	preampDb: -0.3
};
const boost: Band = { kind: 'PK', freqHz: 1000, gainDb: 9, qFactor: 1 };
const REJECTED = { bands: pad([boost, boost, boost, boost]), preampDb: -0.5 };
/** An official preset: standard by construction. */
const STANDARD = { bands: NEUTRO.bands.slice(), preampDb: NEUTRO.preampDb };

/** The core's class of a curve, with `experimental` derived from it as the client does. */
function core(curve: { bands: readonly Band[]; preampDb: number }) {
	const experimental = curve.bands.some((band) => isExperimentalKind(band.kind));
	return classifyCurve(curve.bands, curve.preampDb, { experimental });
}

beforeEach(() => {
	clearGateVerdicts();
	vi.mocked(gateForWrite).mockClear();
});
afterEach(() => clearGateVerdicts());

describe('classes run their gate passes through the shared cache', () => {
	it('a second classification of the same curve runs no gate', () => {
		const first = curveClassification(YOLO_ONLY.bands, YOLO_ONLY.preampDb);
		expect(first.class).toBe('yolo');
		// The standard pass and the YOLO pass, once each.
		expect(runs()).toBe(2);
		vi.mocked(gateForWrite).mockClear();
		expect(curveClassification([...YOLO_ONLY.bands], YOLO_ONLY.preampDb)).toBe(first);
		expect(runs()).toBe(0);
		expect(knownClassification(YOLO_ONLY.bands, YOLO_ONLY.preampDb)).toBe(first);
	});

	it('a standard pass the editor or the preview already made is reused', () => {
		gateVerdict(STANDARD.bands, STANDARD.preampDb);
		vi.mocked(gateForWrite).mockClear();
		expect(curveClassification(STANDARD.bands, STANDARD.preampDb).class).toBe('standard');
		expect(runs()).toBe(0);
		// A YOLO curve whose two passes are cached (Curva in Modo YOLO) costs nothing either.
		gateVerdict(SHELVES.bands, SHELVES.preampDb);
		gateVerdict(SHELVES.bands, SHELVES.preampDb, { profile: 'yolo' });
		vi.mocked(gateForWrite).mockClear();
		expect(curveClassification(SHELVES.bands, SHELVES.preampDb).class).toBe('yolo');
		expect(runs()).toBe(0);
	});

	it('a rejected curve too: at most both passes once, then nothing', () => {
		const first = curveClassification(REJECTED.bands, REJECTED.preampDb);
		expect(first.class).toBe('rejected');
		expect(runs()).toBeLessThanOrEqual(2);
		vi.mocked(gateForWrite).mockClear();
		expect(curveClassification(REJECTED.bands, REJECTED.preampDb)).toBe(first);
		expect(runs()).toBe(0);
	});

	it('keeps a whole library and takes classes computed off the main thread', () => {
		expect(CLASSIFICATIONS_KEPT).toBeGreaterThanOrEqual(256);
		expect(knownClassification(STANDARD.bands, STANDARD.preampDb)).toBeNull();
		const answer = core(STANDARD);
		rememberClassification(STANDARD.bands, STANDARD.preampDb, answer);
		expect(curveClassification(STANDARD.bands, STANDARD.preampDb)).toBe(answer);
		expect(runs()).toBe(0);
	});
});

describe('the same class as the core classifyCurve', () => {
	it('the official presets and the reference curves', () => {
		const curves = [
			...[...OFFICIAL_PRESETS, NEUTRO].map((preset) => ({
				bands: preset.bands,
				preampDb: preset.preampDb
			})),
			YOLO_ONLY,
			SHELVES,
			REJECTED,
			STANDARD,
			// Below the storage floor (−25,5 dB): never stored, YOLO included.
			{ ...YOLO_ONLY, preampDb: -26 }
		];
		for (const curve of curves) {
			expect(curveClassification(curve.bands, curve.preampDb)).toEqual(core(curve));
		}
	});

	const tenths = (min: number, max: number) =>
		fc.integer({ min: min * 10, max: max * 10 }).map((value) => value / 10);
	const hundredths = (min: number, max: number) =>
		fc.integer({ min: Math.round(min * 100), max: Math.round(max * 100) }).map((v) => v / 100);
	const gainBand = fc.record({
		kind: fc.constantFrom('PK' as const, 'LS' as const, 'HS' as const),
		// Up to 32 kHz: sections above 20 kHz (Engenharia) included.
		freqHz: fc.integer({ min: 20, max: 32000 }),
		gainDb: tenths(-12, 12),
		qFactor: hundredths(0.3, 6)
	});
	const passBand = fc.record({
		kind: fc.constantFrom('LP' as const, 'HP' as const),
		freqHz: fc.integer({ min: 10, max: 32000 }),
		qFactor: hundredths(0.4, 1.2)
	});
	/** Curves the YOLO profile tends to take: a subsonic HP, a shelf pair, an ultrasonic cut. */
	const yoloish = fc.oneof(
		fc.record({
			kind: fc.constant('HP' as const),
			freqHz: fc.integer({ min: 15, max: 40 }),
			qFactor: hundredths(0.5, 0.71)
		}),
		fc.record({
			kind: fc.constant('HS' as const),
			freqHz: fc.integer({ min: 500, max: 4000 }),
			gainDb: tenths(-8, -3),
			qFactor: hundredths(0.5, 0.9)
		}),
		fc.record({
			kind: fc.constantFrom('LP' as const, 'HP' as const),
			freqHz: fc.integer({ min: 20001, max: 32000 }),
			qFactor: hundredths(0.5, 0.71)
		})
	);
	const curveArb = fc.record({
		active: fc.array(fc.oneof(gainBand, passBand, yoloish), { minLength: 1, maxLength: 4 }),
		preampDb: tenths(-27, 0)
	});

	it('random curves, sections above 20 kHz and YOLO-only ones included', () => {
		fc.assert(
			fc.property(curveArb, ({ active, preampDb }) => {
				clearGateVerdicts();
				const curve = { bands: pad(active), preampDb };
				const expected = core(curve);
				expect(curveClassification(curve.bands, curve.preampDb)).toEqual(expected);
				// The cached answer is the same one.
				expect(curveClassification(curve.bands, curve.preampDb)).toEqual(expected);
			}),
			{ numRuns: 60 }
		);
	}, 120_000);
});
