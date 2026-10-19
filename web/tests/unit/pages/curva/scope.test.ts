import { describe, expect, test } from 'vitest';
import { curveResponseDb, logGrid } from 'open-auri/dsp';
import {
	ABS_RANGES,
	AUDIBLE_MAX_HZ,
	gateForWrite,
	SOFT_RANGES,
	THRESHOLDS,
	ULTRA_MAX_HZ
} from 'open-auri/safety';
import type { Band, Curve } from '#lib/components/pages/curva/model.ts';
import {
	audibleLength,
	audiblePeak,
	audibleSpansAbove,
	bandResponse,
	dbOf,
	DRAG_GRID,
	editableMaxHz,
	F_MAX,
	F_MIN,
	freqMax,
	freqOf,
	hardZones,
	INTERNAL_LIMIT_DB,
	keyTarget,
	MAJOR_FREQS,
	MINOR_FREQS,
	NYQUIST_HZ,
	OUTPUT_LIMIT_DB,
	pathOf,
	PLOT,
	pointerTarget,
	responsePath,
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

describe('scope geometry (mock plot: 20 Hz to Nyquist, 48 kHz, ±15 dB)', () => {
	test('scales map the plot corners and invert each other', () => {
		expect(xOf(20)).toBeCloseTo(PLOT.left, 9);
		expect(xOf(NYQUIST_HZ)).toBeCloseTo(PLOT.right, 9);
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

	test('section responses are remembered per exact band (a drag frame evaluates one)', () => {
		const core = (band: Band) => curveResponseDb({ bands: [band], preampDb: 0 }, SCOPE_GRID);
		const pk: Band = { kind: 'PK', freqHz: 1234, gainDb: 3.3, qFactor: 1.7 };
		const first = bandResponse({ ...pk });
		// A different object with the same parameters reuses the same frozen response.
		expect(bandResponse({ ...pk })).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(first).toEqual(core(pk));
		// Any parameter change is a different response, exactly core's.
		const moved: Band = { kind: 'PK', freqHz: 1234, gainDb: 3.4, qFactor: 1.7 };
		expect(bandResponse(moved)).not.toBe(first);
		expect(bandResponse(moved)).toEqual(core(moved));
		// −0 and 0 are kept apart; an LP with a gain of 0 is keyed apart from one without.
		const flat: Band = { kind: 'PK', freqHz: 1234, gainDb: 0, qFactor: 1.7 };
		const negative: Band = { kind: 'PK', freqHz: 1234, gainDb: -0, qFactor: 1.7 };
		expect(bandResponse(negative)).not.toBe(bandResponse(flat));
		expect(bandResponse(negative)).toEqual(core(negative));
		const lp: Band = { kind: 'LP', freqHz: 12000, qFactor: 0.7 };
		expect(bandResponse(lp)).toEqual(core(lp));
		expect(bandResponse({ kind: 'LP', freqHz: 12000, gainDb: 0, qFactor: 0.7 })).toEqual(
			bandResponse(lp)
		);
	});

	test('bands core refuses stay without a trace, cached or not', () => {
		const bad: Band = { kind: 'PK', freqHz: 1000, gainDb: Number.NaN, qFactor: 1 };
		expect(bandResponse(bad)).toBeNull();
		expect(bandResponse({ ...bad })).toBeNull();
		// A field that is not a number is never cached, and core still refuses it.
		const typed = JSON.parse('{"kind":"PK","freqHz":"1000","gainDb":1,"qFactor":1}') as Band;
		expect(bandResponse(typed)).toBeNull();
		expect(bandResponse({ kind: 'PK', freqHz: 1000, gainDb: 1, qFactor: 1 })).not.toBeNull();
	});

	test('an unfrozen grid is evaluated afresh every time, with the same values', () => {
		const pk: Band = { kind: 'PK', freqHz: 500, gainDb: -2, qFactor: 0.9 };
		const grid = [...SCOPE_GRID];
		const a = bandResponse(pk, grid);
		const b = bandResponse(pk, grid);
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
		expect(a).toEqual(bandResponse(pk));
	});

	test('paths: the remembered section path and the SCOPE_GRID shortcut draw the same text', () => {
		const t = traces(curve);
		const band = t.bands[1];
		if (!band) throw new Error('band 2 has a trace');
		expect(responsePath(band)).toBe(pathOf(band));
		expect(responsePath(band)).toBe(responsePath(band));
		expect(responsePath(t.eq)).toBe(pathOf(t.eq));
		// SCOPE_GRID's precomputed x text equals computing it on a copy of the grid.
		const copy = [...SCOPE_GRID];
		expect(pathOf(t.output)).toBe(pathOf(t.output, copy));
		expect(segmentPath(t.output, 500, 2000)).toBe(segmentPath(t.output, 500, 2000, copy));
	});

	test('the drag grid keeps every other point and both ends; its traces are still core', () => {
		expect(Object.isFrozen(DRAG_GRID)).toBe(true);
		expect(DRAG_GRID).toHaveLength((SCOPE_GRID.length + 1) / 2);
		expect(DRAG_GRID[0]).toBe(SCOPE_GRID[0]);
		expect(DRAG_GRID[DRAG_GRID.length - 1]).toBe(SCOPE_GRID[SCOPE_GRID.length - 1]);
		DRAG_GRID.forEach((f, i) => expect(f).toBe(SCOPE_GRID[i * 2]));
		const coarse = traces(curve, DRAG_GRID);
		const eq = curveResponseDb({ bands: curve.bands, preampDb: 0 }, DRAG_GRID);
		coarse.eq.forEach((value, i) => expect(value).toBeCloseTo(eq[i] ?? NaN, 9));
		const band = coarse.bands[1];
		const full = traces(curve).bands[1];
		if (!band || !full) throw new Error('band 2 has a trace');
		// Paths are remembered per grid: the coarse and the full trace never mix.
		expect(responsePath(band, DRAG_GRID)).toBe(pathOf(band, DRAG_GRID));
		expect(responsePath(full)).toBe(pathOf(full));
		expect(responsePath(band, DRAG_GRID)).not.toBe(responsePath(full));
		expect(pathOf(coarse.eq, DRAG_GRID)).toBe(pathOf(coarse.eq, [...DRAG_GRID]));
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

describe('the axis runs to Nyquist (48 kHz): exact convergence drawn, audible readouts', () => {
	const last = SCOPE_GRID.length - 1;
	const at20k = SCOPE_GRID.indexOf(F_MAX);
	const within = (value: number | undefined, db: number) =>
		expect(Math.abs((value ?? NaN) - db)).toBeLessThan(0.01);

	test('the grid ends at 48 kHz and keeps the audible grid the readouts always used', () => {
		expect(NYQUIST_HZ).toBe(48000);
		expect(SCOPE_GRID[last]).toBe(48000);
		expect(xOf(F_MAX)).toBeLessThan(PLOT.right);
		expect(SCOPE_GRID.slice(0, at20k + 1)).toEqual(logGrid(193, 20, 20000));
		SCOPE_GRID.forEach((f, i) => {
			if (i > 0) expect(f).toBeGreaterThan(SCOPE_GRID[i - 1] ?? Infinity);
		});
		// The drag decimation keeps both 20 kHz and Nyquist.
		expect(DRAG_GRID[DRAG_GRID.length - 1]).toBe(48000);
		expect(DRAG_GRID).toContain(F_MAX);
		expect(audibleLength(SCOPE_GRID)).toBe(at20k + 1);
		expect(audibleLength(DRAG_GRID)).toBe(DRAG_GRID.indexOf(F_MAX) + 1);
	});

	test('a PK and an LS return to the preamp baseline at 48 kHz (within 0.01 dB)', () => {
		const curve: Curve = {
			bands: pad([
				{ kind: 'PK', freqHz: 10000, gainDb: -4, qFactor: 1.4 },
				{ kind: 'LS', freqHz: 120, gainDb: 3, qFactor: 0.7 }
			]),
			preampDb: -3.5
		};
		const t = traces(curve);
		within(t.output[last], curve.preampDb);
		within(t.eq[last], 0);
		// Core's exact response on the extended grid, not an approximation of it.
		const core = curveResponseDb(curve, SCOPE_GRID);
		t.output.forEach((value, i) => expect(value).toBeCloseTo(core[i] ?? NaN, 9));
	});

	test('an HS keeps its gain at 48 kHz and an LP falls toward −∞, pinned at the floor', () => {
		const hs = bandResponse({ kind: 'HS', freqHz: 8000, gainDb: 4, qFactor: 0.7 });
		within(hs?.[last], 4);
		const lp = bandResponse({ kind: 'LP', freqHz: 12000, qFactor: 0.7 });
		if (!lp) throw new Error('the LP has a trace');
		for (let i = at20k + 1; i <= last; i++) expect(lp[i]).toBeLessThan(lp[i - 1] ?? NaN);
		expect(lp[last]).toBeLessThan((lp[at20k] ?? NaN) - 40);
		// The path keeps every point: the last one clamped below the floor, where the clip crops.
		const d = pathOf(lp);
		expect(d.split('L')).toHaveLength(SCOPE_GRID.length);
		expect(d.endsWith(`L${xOf(NYQUIST_HZ).toFixed(1)} ${yOf(-60).toFixed(1)}`)).toBe(true);
	});

	test('the audible peak and zones ignore the 20 to 48 kHz band', () => {
		// A rising shelf: the output keeps climbing past 20 kHz, up to its full gain at Nyquist.
		const curve: Curve = {
			bands: pad([{ kind: 'HS', freqHz: 10000, gainDb: 5, qFactor: 0.7 }]),
			preampDb: -6
		};
		const t = traces(curve);
		const audible = t.output.slice(0, at20k + 1);
		const audibleMax = Math.max(...audible);
		const fullMax = Math.max(...t.output);
		expect(fullMax).toBeGreaterThan(audibleMax);
		within(t.output[last], curve.preampDb + 5);
		const peak = audiblePeak(t.output);
		expect(peak).toEqual({ db: audibleMax, hz: SCOPE_GRID[audible.indexOf(audibleMax)] });
		expect(peak?.hz).toBeLessThanOrEqual(F_MAX);
		const coarse = traces(curve, DRAG_GRID);
		expect(audiblePeak(coarse.output, DRAG_GRID)?.hz).toBeLessThanOrEqual(F_MAX);
		// A threshold only the inaudible band crosses lights no zone.
		const between = (audibleMax + fullMax) / 2;
		expect(spansAbove(t.output, between).length).toBeGreaterThan(0);
		expect(audibleSpansAbove(t.output, between)).toEqual([]);
		expect(audibleSpansAbove(t.output, OUTPUT_LIMIT_DB).every((s) => s.toHz <= F_MAX)).toBe(true);
		// A spike above 20 kHz is never the peak.
		expect(audiblePeak([0, 1, 9], [1000, 20000, 30000])).toEqual({ db: 1, hz: 20000 });
		expect(audiblePeak([9], [30000])).toBeNull();
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

	test('Engenharia: the gain cap reaches 32 kHz and boosts from 20 to 32 kHz are a hard zone', () => {
		const ls: Band = { kind: 'LS', freqHz: 200, gainDb: 0, qFactor: 0.7 };
		const pk: Band = { kind: 'PK', freqHz: 1000, gainDb: 0, qFactor: 1 };
		const engenharia = hardZones(ls, { layer: 'engenharia' });
		expect(engenharia.map((zone) => zone.kind)).toEqual(['gain-cap', 'ultra-boost']);
		expect(engenharia[0]).toMatchObject({ fMin: F_MIN, fMax: ULTRA_MAX_HZ });
		expect(engenharia[1]).toEqual({
			kind: 'ultra-boost',
			fMin: AUDIBLE_MAX_HZ,
			fMax: ULTRA_MAX_HZ,
			gMin: 0,
			gMax: ABS_RANGES.gainDb.max
		});
		expect(hardZones(pk, { layer: 'engenharia' }).map((zone) => zone.kind)).toEqual([
			'gain-cap',
			'pk-high-boost',
			'ultra-boost'
		]);
		// Modo YOLO: boosts may go to 32 kHz; the gain cap stays.
		const yolo = hardZones(ls, { layer: 'engenharia', yolo: true });
		expect(yolo.map((zone) => zone.kind)).toEqual(['gain-cap']);
		expect(yolo[0]?.fMax).toBe(ULTRA_MAX_HZ);
		// Ouvir and Ajustar stop at 20 kHz, YOLO or not.
		for (const layer of ['ouvir', 'ajustar'] as const) {
			const zones = hardZones(ls, { layer, yolo: true });
			expect(zones.map((zone) => zone.kind)).toEqual(['gain-cap']);
			expect(zones[0]?.fMax).toBe(F_MAX);
		}
		expect(editableMaxHz({ layer: 'engenharia' })).toBe(ULTRA_MAX_HZ);
		expect(editableMaxHz({ layer: 'ajustar', yolo: true })).toBe(AUDIBLE_MAX_HZ);
		expect(editableMaxHz()).toBe(AUDIBLE_MAX_HZ);
	});
});

describe('frequency limits per layer (freqMaxFor)', () => {
	// Core's gain band (PK/LS/HS share one type), so spreads keep a gain.
	const cut: Extract<Band, { kind: 'PK' | 'LS' | 'HS' }> = {
		kind: 'PK',
		freqHz: 1000,
		gainDb: -3,
		qFactor: 1
	};
	const lift: Extract<Band, { kind: 'PK' | 'LS' | 'HS' }> = { ...cut, gainDb: 3 };
	const lp: Band = { kind: 'LP', freqHz: 18000, qFactor: 0.7 };
	const sharp: Band = { kind: 'LP', freqHz: 18000, qFactor: 2 };
	const none = { shiftKey: false, altKey: false };
	const shift = { shiftKey: true, altKey: false };

	test('20 kHz in Ouvir and Ajustar; 32 kHz for cuts in Engenharia; 32 kHz for any in YOLO', () => {
		for (const layer of ['ouvir', 'ajustar'] as const) {
			for (const band of [cut, lift, lp]) {
				expect(freqMax(band, { layer })).toBe(AUDIBLE_MAX_HZ);
				expect(freqMax(band, { layer, yolo: true })).toBe(AUDIBLE_MAX_HZ);
			}
		}
		expect(freqMax(cut, { layer: 'engenharia' })).toBe(ULTRA_MAX_HZ);
		expect(freqMax(lp, { layer: 'engenharia' })).toBe(ULTRA_MAX_HZ);
		expect(freqMax(lift, { layer: 'engenharia' })).toBe(AUDIBLE_MAX_HZ);
		expect(freqMax(sharp, { layer: 'engenharia' })).toBe(AUDIBLE_MAX_HZ);
		for (const band of [cut, lift, lp, sharp]) {
			expect(freqMax(band, { layer: 'engenharia', yolo: true })).toBe(ULTRA_MAX_HZ);
		}
		expect(freqMax(cut)).toBe(AUDIBLE_MAX_HZ);
	});

	test('the pointer clamps per layer, at the gain under the pointer', () => {
		const right = 5000;
		const below = yOf(-6);
		const above = yOf(6);
		expect(pointerTarget(right, below, cut, { layer: 'ajustar' }).freqHz).toBe(AUDIBLE_MAX_HZ);
		expect(pointerTarget(right, below, cut, { layer: 'engenharia' })).toEqual({
			freqHz: ULTRA_MAX_HZ,
			gainDb: -6
		});
		// The same cut lifted above 0 dB is a boost: it stops at 20 kHz outside YOLO.
		expect(pointerTarget(right, above, cut, { layer: 'engenharia' })).toEqual({
			freqHz: AUDIBLE_MAX_HZ,
			gainDb: 6
		});
		expect(pointerTarget(right, above, cut, { layer: 'engenharia', yolo: true })).toEqual({
			freqHz: ULTRA_MAX_HZ,
			gainDb: 6
		});
		// 0 dB never amplifies: Engenharia allows it up to 32 kHz.
		expect(pointerTarget(right, yOf(0), cut, { layer: 'engenharia' }).freqHz).toBe(ULTRA_MAX_HZ);
		expect(pointerTarget(right, above, lp, { layer: 'engenharia' })).toEqual({
			freqHz: ULTRA_MAX_HZ
		});
		expect(pointerTarget(right, above, sharp, { layer: 'engenharia' })).toEqual({
			freqHz: AUDIBLE_MAX_HZ
		});
		// The plot's right edge is Nyquist (48 kHz): never past 32 kHz.
		expect(freqOf(right)).toBeGreaterThan(NYQUIST_HZ);
	});

	test('arrow keys clamp per layer and never pull a band down from where it is', () => {
		const high = { ...cut, freqHz: 19000 };
		expect(keyTarget('ArrowRight', high, shift, { layer: 'ajustar' })).toEqual({
			freqHz: AUDIBLE_MAX_HZ
		});
		expect(keyTarget('ArrowRight', high, shift, { layer: 'engenharia' })).toEqual({
			freqHz: Math.round(19000 * 2 ** (10 / 24))
		});
		const top = { ...cut, freqHz: 31000 };
		expect(keyTarget('ArrowRight', top, shift, { layer: 'engenharia' })).toEqual({
			freqHz: ULTRA_MAX_HZ
		});
		const boost = { ...lift, freqHz: 19500 };
		expect(keyTarget('ArrowRight', boost, shift, { layer: 'engenharia' })).toEqual({
			freqHz: AUDIBLE_MAX_HZ
		});
		expect(keyTarget('ArrowRight', boost, shift, { layer: 'engenharia', yolo: true })).toEqual({
			freqHz: Math.round(19500 * 2 ** (10 / 24))
		});
		// A boost left above 20 kHz (from YOLO) is not pulled down by a step to the right.
		const left = { ...lift, freqHz: 25000 };
		expect(keyTarget('ArrowRight', left, none, { layer: 'engenharia' })).toEqual({
			freqHz: 25000
		});
		expect(keyTarget('ArrowLeft', left, none, { layer: 'engenharia' })).toEqual({
			freqHz: Math.round(25000 * 2 ** (-1 / 24))
		});
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
