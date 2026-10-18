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
