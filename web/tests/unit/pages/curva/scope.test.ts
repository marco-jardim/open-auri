import { describe, expect, test } from 'vitest';
import { curveResponseDb } from 'open-auri/dsp';
import { ABS_RANGES, gateForWrite, SOFT_RANGES, THRESHOLDS } from 'open-auri/safety';
import type { Band, Curve } from '#lib/components/pages/curva/model.ts';
import {
	bandResponse,
	dbOf,
	freqOf,
	hardZones,
	INTERNAL_LIMIT_DB,
	keyTarget,
	MAJOR_FREQS,
	MINOR_FREQS,
	OUTPUT_LIMIT_DB,
	pathOf,
	PLOT,
	pointerTarget,
	SCOPE_GRID,
	segmentPath,
	softBox,
	spansAbove,
	stepQ,
	traces,
	xOf,
	yOf
} from '#lib/components/pages/curva/scope.ts';

const OFF: Band = { kind: 'OFF' };
const pad = (bands: Band[]): Band[] => [
	...bands,
	...Array.from({ length: 10 - bands.length }, () => OFF)
];
const nearest = (freqHz: number) =>
	SCOPE_GRID.reduce(
		(best, f, i) =>
			Math.abs(Math.log(f / freqHz)) < Math.abs(Math.log((SCOPE_GRID[best] ?? 1) / freqHz))
				? i
				: best,
		0
	);

describe('scope geometry (mock plot: 20 Hz to 20 kHz, ±15 dB)', () => {
	test('scales map the plot corners and invert each other', () => {
		expect(xOf(20)).toBeCloseTo(PLOT.left, 9);
		expect(xOf(20000)).toBeCloseTo(PLOT.right, 9);
		expect(yOf(15)).toBeCloseTo(PLOT.top, 9);
		expect(yOf(-15)).toBeCloseTo(PLOT.bottom, 9);
		expect(freqOf(xOf(1234))).toBeCloseTo(1234, 6);
		expect(dbOf(yOf(-3.3))).toBeCloseTo(-3.3, 9);
		expect(THRESHOLDS.outputAudibleDb).toBe(OUTPUT_LIMIT_DB);
		expect(THRESHOLDS.internalAudibleDb).toBe(INTERNAL_LIMIT_DB);
	});

	test('the graticule has labelled majors and unlabelled minors that never overlap', () => {
		expect(MINOR_FREQS).toContain(30);
		expect(MINOR_FREQS).toContain(3000);
		for (const f of MAJOR_FREQS) expect(MINOR_FREQS).not.toContain(f);
		for (const f of MINOR_FREQS) expect(f > 20 && f < 20000).toBe(true);
	});
});

describe('scope traces come from core responses', () => {
	const curve: Curve = {
		bands: pad([
			{ kind: 'PK', freqHz: 100, gainDb: -1, qFactor: 1 },
			{ kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 },
			{ kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 }
		]),
		preampDb: -0.5
	};

	test('per-section sums equal the core cascade response, with and without preamp', () => {
		const t = traces(curve);
		const core = curveResponseDb(curve, SCOPE_GRID);
		const eq = curveResponseDb({ bands: curve.bands, preampDb: 0 }, SCOPE_GRID);
		t.output.forEach((value, i) => expect(value).toBeCloseTo(core[i] ?? NaN, 9));
		t.eq.forEach((value, i) => expect(value).toBeCloseTo(eq[i] ?? NaN, 9));
		expect(t.bands.slice(3).every((response) => response === null)).toBe(true);
		expect(bandResponse(OFF)).toBeNull();
		expect(pathOf(t.eq).startsWith('M')).toBe(true);
	});

	test('the internal level is the highest prefix, and names the first band over the limit', () => {
		const t = traces(curve);
		t.internal.forEach((value, i) => {
			expect(value).toBeGreaterThanOrEqual((t.output[i] ?? Infinity) - 1e-9);
			expect(value).toBeGreaterThanOrEqual(curve.preampDb - 1e-9);
		});
		const at1k = nearest(1000);
		// Band 1 (a cut) keeps the prefix under the limit; band 2 (+6 dB) is the first over it,
		// which is also the stage the gate reports.
		expect(t.internalStage[at1k]).toBe(2);
		const gateStage = gateForWrite(curve.bands, curve.preampDb).reasons.find(
			(reason) => reason.code === 'd:prefix-peak'
		)?.stage;
		expect(gateStage).toBe(2);
		const spans = spansAbove(t.internal, INTERNAL_LIMIT_DB);
		expect(spans.some((s) => s.fromHz < 1000 && s.toHz > 1000)).toBe(true);
	});

	test('spansAbove finds each run over the threshold, with its peak', () => {
		expect(spansAbove([0, 1, 2, 1, 0], 0.5, [10, 20, 30, 40, 50])).toEqual([
			{ fromHz: 10, toHz: 50, peakDb: 2, peakHz: 30 }
		]);
		expect(spansAbove([1, 0, 1], 0.5, [10, 20, 30])).toHaveLength(2);
		expect(spansAbove([0, 0], 0.5, [10, 20])).toEqual([]);
		expect(segmentPath([0, 1, 2], 15, 30, [10, 20, 30]).split('L')).toHaveLength(2);
	});
});

describe('safe boxes and hard zones of the selected section', () => {
	test('soft boxes follow core SOFT_RANGES by kind, Q and boost', () => {
		const pk = (qFactor: number): Band => ({ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor });
		const range = SOFT_RANGES['PK-main'];
		expect(softBox(pk(1))).toEqual({
			fMin: range.freqHz.min,
			fMax: range.freqHz.max,
			gMin: range.gainDb?.min,
			gMax: range.gainDb?.max
		});
		expect(softBox(pk(3))?.gMax).toBe(SOFT_RANGES['PK-narrow'].gainDb?.max);
		expect(softBox({ kind: 'LS', freqHz: 200, gainDb: -3, qFactor: 0.7 })?.fMax).toBe(
			SOFT_RANGES.LS.freqHz.max
		);
		expect(softBox({ kind: 'HS', freqHz: 9000, gainDb: 1, qFactor: 0.7 })?.fMin).toBe(
			SOFT_RANGES['HS-boost'].freqHz.min
		);
		expect(softBox({ kind: 'HS', freqHz: 9000, gainDb: -1, qFactor: 0.7 })?.gMax).toBe(
			SOFT_RANGES['HS-cut'].gainDb?.max
		);
		// LP/HP have no gain: a thin strip around 0 dB.
		expect(softBox({ kind: 'HP', freqHz: 60, qFactor: 0.7 })).toEqual({
			fMin: SOFT_RANGES.HP.freqHz.min,
			fMax: SOFT_RANGES.HP.freqHz.max,
			gMin: -2,
			gMax: 2
		});
		expect(softBox(OFF)).toBeNull();
	});

	test('hard zones: the gain cap for every gain kind, and D7 above 16 kHz for PK only', () => {
		const pkZones = hardZones({ kind: 'PK', freqHz: 1000, gainDb: 0, qFactor: 1 });
		expect(pkZones.map((zone) => zone.kind)).toEqual(['gain-cap', 'pk-high-boost']);
		expect(pkZones[0]?.gMin).toBe(ABS_RANGES.gainDb.max);
		expect(pkZones[1]).toMatchObject({ fMin: ABS_RANGES.pkBoostMaxHz, gMin: 0 });
		expect(hardZones({ kind: 'LS', freqHz: 200, gainDb: 0, qFactor: 0.7 })).toHaveLength(1);
		expect(hardZones({ kind: 'LP', freqHz: 18000, qFactor: 0.7 })).toEqual([]);
		expect(hardZones(OFF)).toEqual([]);
	});
});

describe('pointer, keyboard and wheel targets', () => {
	// Core's gain band (PK/LS/HS share one type), so spreads keep a gain.
	const pk: Extract<Band, { kind: 'PK' | 'LS' | 'HS' }> = {
		kind: 'PK',
		freqHz: 1000,
		gainDb: -3,
		qFactor: 1
	};

	test('the pointer maps to the plot and clamps to the absolute control ranges', () => {
		expect(pointerTarget(xOf(1000), yOf(-3), pk)).toEqual({ freqHz: 1000, gainDb: -3 });
		expect(pointerTarget(xOf(1000), yOf(0), pk)).toEqual({ freqHz: 1000, gainDb: 0 });
		expect(pointerTarget(-500, -500, pk)).toEqual({
			freqHz: 20,
			gainDb: ABS_RANGES.gainDb.max
		});
		expect(pointerTarget(5000, 5000, pk)).toEqual({
			freqHz: 20000,
			gainDb: ABS_RANGES.gainDb.min
		});
		expect(pointerTarget(xOf(80), yOf(6), { kind: 'HP', freqHz: 50, qFactor: 0.7 })).toEqual({
			freqHz: 80
		});
	});

	test('keys follow the mock steps and stay inside the ranges', () => {
		const none = { shiftKey: false, altKey: false };
		expect(keyTarget('ArrowRight', pk, none)).toEqual({ freqHz: 1029 });
		expect(keyTarget('ArrowUp', pk, { shiftKey: true, altKey: false })).toEqual({ gainDb: 7 });
		expect(keyTarget('ArrowUp', { ...pk, gainDb: 9 }, none)).toEqual({
			gainDb: ABS_RANGES.gainDb.max
		});
		expect(keyTarget('ArrowLeft', { ...pk, freqHz: 20 }, none)).toEqual({ freqHz: 20 });
		// A fine step that rounds to the same hertz still moves by one.
		const fine = { shiftKey: false, altKey: true };
		expect(keyTarget('ArrowRight', { ...pk, freqHz: 20 }, fine)).toEqual({ freqHz: 21 });
		expect(keyTarget('ArrowUp', { kind: 'LP', freqHz: 18000, qFactor: 0.7 }, none)).toBeNull();
		expect(keyTarget('Escape', pk, none)).toBeNull();
		expect(keyTarget('ArrowUp', OFF, none)).toBeNull();
	});

	test('Q steps by 0.1 on the 0.01 grid inside the absolute range', () => {
		expect(stepQ(1, 1)).toBe(1.1);
		expect(stepQ(1, -1)).toBe(0.9);
		expect(stepQ(1, 1, 0.1)).toBe(1.01);
		expect(stepQ(0.1, -1)).toBe(ABS_RANGES.qFactor.min);
		expect(stepQ(20, 1, 10)).toBe(ABS_RANGES.qFactor.max);
	});
});
