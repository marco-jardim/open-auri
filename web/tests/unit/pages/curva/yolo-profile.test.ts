/**
 * M2: in Modo YOLO every discrete edit (manual preamp, "Máximo sem clipping", reorder, default
 * order, kinds, parked points, macros) judges the curve with the YOLO profile, like the dial and
 * the drags, and the preamp never goes below −25,5 dB (the S1 floor), even though the YOLO gate
 * itself would go down to the codec floor.
 */
import { describe, expect, test } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { autoPreamp, CODEC_PREAMP_FLOOR_DB, THRESHOLDS } from 'open-auri/safety';
import {
	changeKind,
	EDITOR_PREAMP_FLOOR_DB,
	editorPreampMaxDb,
	editorVerdict,
	maxPreamp,
	reorderSections
} from '#lib/components/pages/curva/edit.ts';
import { proposeMacro, ZERO_MACROS } from '#lib/components/pages/curva/macros.ts';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import { codecAccepts } from '#lib/workers/gate-handler.ts';

const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
const codes = (reasons: readonly { code: string }[]) => reasons.map((reason) => reason.code);
const cut: Curve = {
	bands: pad([{ kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 }]),
	preampDb: -1
};
/** Refused by the standard gate (class 2 only), accepted by YOLO: "subsônica". */
const yoloOnly: Curve = {
	bands: pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]),
	preampDb: -0.5
};
/** Four +9 dB boosts on one frequency: YOLO's own floor would allow its −36 dB preamp. */
const boost: Band = { kind: 'PK', freqHz: 1000, gainDb: 9, qFactor: 1 };
const loud: Curve = { bands: pad([boost, boost, boost, boost]), preampDb: -0.5 };

test('the fixtures are what they claim', () => {
	expect(verdictFor(cut).ok).toBe(true);
	expect(verdictFor(yoloOnly).ok).toBe(false);
	expect(verdictFor(yoloOnly, 'yolo').ok).toBe(true);
	const yoloAuto = autoPreamp(loud.bands, { profile: 'yolo' });
	expect(yoloAuto).not.toBeNull();
	expect(yoloAuto ?? 0).toBeLessThan(EDITOR_PREAMP_FLOOR_DB);
	expect(yoloAuto ?? 0).toBeGreaterThan(CODEC_PREAMP_FLOOR_DB);
});

test('the editor preamp range: −25,5 dB floor in every profile, 0 dB ceiling in YOLO', () => {
	expect(EDITOR_PREAMP_FLOOR_DB).toBe(THRESHOLDS.preampMinDb);
	expect(EDITOR_PREAMP_FLOOR_DB).toBe(-25.5);
	expect(editorPreampMaxDb()).toBe(THRESHOLDS.preampMaxDb);
	expect(editorPreampMaxDb('standard')).toBe(-0.5);
	expect(editorPreampMaxDb('yolo')).toBe(0);
});

describe('editorVerdict', () => {
	test('is verdictFor, plus the floor in YOLO (where the gate waives g:preamp)', () => {
		const deep: Curve = { bands: cut.bands, preampDb: -30 };
		expect(codes(editorVerdict(deep).reasons)).toContain('g:preamp');
		expect(verdictFor(deep, 'yolo').ok).toBe(true);
		const yolo = editorVerdict(deep, 'yolo');
		expect(yolo.ok).toBe(false);
		expect(yolo.reasons).toEqual([{ code: 'g:preamp', value: -30, limit: -25.5 }]);
		expect(editorVerdict({ bands: cut.bands, preampDb: -25.5 }, 'yolo').ok).toBe(true);
		expect(editorVerdict(yoloOnly).ok).toBe(false);
		expect(editorVerdict(yoloOnly, 'yolo').ok).toBe(true);
	});
});

describe('Máximo sem clipping', () => {
	test('uses the YOLO gate in YOLO', () => {
		expect(maxPreamp(yoloOnly).ok).toBe(false);
		const yolo = maxPreamp(yoloOnly, 'yolo');
		expect(yolo).toMatchObject({
			ok: true,
			preampDb: autoPreamp(yoloOnly.bands, { experimental: true, profile: 'yolo' })
		});
	});

	test('refuses with the preamp reason a curve that would need less than −25,5 dB', () => {
		const result = maxPreamp(loud, 'yolo');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(codes(result.reasons)).toEqual(['g:preamp']);
		expect(result.reasons[0]).toMatchObject({ limit: -25.5 });
		expect(maxPreamp(loud).ok).toBe(false);
	});
});

test('reorder and kinds use the profile they are given', () => {
	expect(reorderSections(yoloOnly, 0, 1).ok).toBe(false);
	const moved = reorderSections(yoloOnly, 0, 1, 'yolo');
	expect(moved.ok).toBe(true);
	if (moved.ok) expect(moved.bands[1]).toEqual(yoloOnly.bands[0]);
	expect(changeKind(yoloOnly, 1, 'PK').ok).toBe(false);
	expect(changeKind(yoloOnly, 1, 'PK', 'yolo').ok).toBe(true);
});

describe('Prévia sem limites: the codec judges every discrete edit (the drags’ check)', () => {
	/** +4 dB out of a −1 dB preamp: the YOLO gate refuses it on output; a preamp would fix it. */
	const loudCut: Curve = {
		bands: pad([{ kind: 'PK', freqHz: 1000, gainDb: 4, qFactor: 1 }]),
		preampDb: -1
	};
	/** A pole radius no preamp fixes (class 1): the YOLO gate refuses it, the codec accepts it. */
	const hardOnly: Curve = {
		bands: pad([{ kind: 'PK', freqHz: 20, gainDb: -12, qFactor: 20 }]),
		preampDb: -1
	};

	test('the fixtures are codec-only', () => {
		for (const curve of [loudCut, hardOnly]) {
			expect(verdictFor(curve, 'yolo').ok).toBe(false);
			expect(editorVerdict(curve, 'yolo').ok).toBe(false);
			expect(codecAccepts(curve.bands, curve.preampDb)).toBe(true);
		}
		expect(autoPreamp(loudCut.bands, { profile: 'yolo' })).not.toBeNull();
		expect(autoPreamp(hardOnly.bands, { profile: 'yolo' })).toBeNull();
	});

	test('editorVerdict: the codec accepts; a refusal names the codec or the editor floor', () => {
		for (const curve of [loudCut, hardOnly]) {
			const free = editorVerdict(curve, 'codec');
			expect(free.ok).toBe(true);
			expect(free.reasons).toEqual([]);
		}
		// A positive preamp does not encode.
		const positive = editorVerdict({ bands: cut.bands, preampDb: 0.5 }, 'codec');
		expect(positive.ok).toBe(false);
		expect(codes(positive.reasons)).toEqual(['f:codec']);
		// The editor floor (−25,5 dB) holds in the free preview too.
		const deep = editorVerdict({ bands: cut.bands, preampDb: -30 }, 'codec');
		expect(deep.ok).toBe(false);
		expect(deep.reasons).toEqual([{ code: 'g:preamp', value: -30, limit: -25.5 }]);
		expect(editorVerdict({ bands: cut.bands, preampDb: -25.5 }, 'codec').ok).toBe(true);
		expect(editorVerdict({ bands: cut.bands, preampDb: 0 }, 'codec').ok).toBe(true);
	});

	test('kinds, parked points and reorders on a codec-only curve', () => {
		for (const curve of [loudCut, hardOnly]) {
			// A kind change (the dial's preflight and its commit) and a parked point (OFF → PK).
			expect(changeKind(curve, 1, 'PK', 'yolo').ok).toBe(false);
			const kind = changeKind(curve, 1, 'PK', 'codec');
			expect(kind.ok).toBe(true);
			if (kind.ok) expect(kind.bands[1]).toMatchObject({ kind: 'PK' });
			// Reorders and the default order.
			expect(reorderSections(curve, 0, 1, 'yolo').ok).toBe(false);
			const moved = reorderSections(curve, 0, 1, 'codec');
			expect(moved.ok).toBe(true);
			if (moved.ok) expect(moved.bands[1]).toEqual(curve.bands[0]);
		}
	});

	test('Máximo sem clipping: the YOLO search, judged by the codec', () => {
		const result = maxPreamp(loudCut, 'codec');
		expect(result).toMatchObject({
			ok: true,
			preampDb: autoPreamp(loudCut.bands, { experimental: false, profile: 'yolo' })
		});
		if (result.ok) expect(result.verdict.ok).toBe(true);
		// No preamp fixes a class-1 reason: nothing to propose, and it says why.
		const none = maxPreamp(hardOnly, 'codec');
		expect(none.ok).toBe(false);
		if (!none.ok) expect(none.reasons.length).toBeGreaterThan(0);
		// Below the editor floor it is refused, as in YOLO.
		const deep = maxPreamp(loud, 'codec');
		expect(deep.ok).toBe(false);
		if (!deep.ok) expect(codes(deep.reasons)).toEqual(['g:preamp']);
	});

	test('macros: the codec accepts where YOLO refuses; the preamp is never raised', () => {
		const input = {
			base: hardOnly.bands,
			basePreampDb: hardOnly.preampDb,
			values: ZERO_MACROS,
			index: 1,
			target: -1
		};
		expect(proposeMacro({ ...input, profile: 'yolo' }).ok).toBe(false);
		const free = proposeMacro({ ...input, profile: 'codec' });
		expect(free.ok).toBe(true);
		expect(free.bands[1]).toMatchObject({ kind: 'PK', freqHz: 500, gainDb: -1 });
		expect(free.preampDb).toBe(hardOnly.preampDb);
		expect(free.verdict?.ok).toBe(true);
		// A curve the YOLO search can attenuate: the codec takes the same lowered preamp.
		const loudInput = { ...input, base: loudCut.bands, basePreampDb: loudCut.preampDb };
		const yolo = proposeMacro({ ...loudInput, profile: 'yolo' });
		const codec = proposeMacro({ ...loudInput, profile: 'codec' });
		expect(codec.ok).toBe(true);
		expect(codec.preampDb).toBeLessThanOrEqual(loudCut.preampDb);
		if (yolo.ok) expect(codec.preampDb).toBe(yolo.preampDb);
	});
});

test('macros use the profile they are given', () => {
	const input = {
		base: yoloOnly.bands,
		basePreampDb: yoloOnly.preampDb,
		values: ZERO_MACROS,
		index: 1,
		target: -1
	};
	const standard = proposeMacro(input);
	expect(standard.ok).toBe(false);
	expect(standard.bands).toEqual(yoloOnly.bands);
	const yolo = proposeMacro({ ...input, profile: 'yolo' });
	expect(yolo.ok).toBe(true);
	expect(yolo.bands[1]).toMatchObject({ kind: 'PK', freqHz: 500, gainDb: -1 });
	expect(yolo.preampDb).toBeGreaterThanOrEqual(EDITOR_PREAMP_FLOOR_DB);
	expect(yolo.verdict?.ok).toBe(true);
});
