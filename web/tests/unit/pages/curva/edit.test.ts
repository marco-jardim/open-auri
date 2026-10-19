import { describe, expect, test } from 'vitest';
import { freqMaxFor, gateForWrite, ULTRA_CUT_Q_MAX, ULTRA_MAX_HZ } from 'open-auri/safety';
import {
	bandOfKind,
	changeKind,
	defaultOrder,
	moveSection,
	reorderSections
} from '#lib/components/pages/curva/edit.ts';
import { hasGain, type Band, type Curve } from '#lib/components/pages/curva/model.ts';

const OFF: Band = { kind: 'OFF' };
const CUT: Band = { kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 };
const BOOST: Band = { kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 };
const pad = (bands: Band[]): Band[] => [
	...bands,
	...Array.from({ length: 10 - bands.length }, () => OFF)
];

describe('section reorder (patch cables)', () => {
	test('moveSection keeps the relative order of the others', () => {
		const bands = pad([CUT, BOOST, { kind: 'LS', freqHz: 100, gainDb: -2, qFactor: 0.7 }]);
		const moved = moveSection(bands, 2, 0);
		expect(moved.slice(0, 3)).toEqual([bands[2], CUT, BOOST]);
		expect(moveSection(bands, 0, 0)).toEqual(bands);
		expect(moveSection(bands, -1, 3)).toEqual(bands);
	});

	test('the gate judges the real order: boost before cut is refused and nothing changes', () => {
		// Cut then boost (D1) cancels inside the chain; boost first clips after stage 1.
		const curve: Curve = { bands: pad([CUT, BOOST]), preampDb: -0.5 };
		expect(gateForWrite(curve.bands, curve.preampDb).ok).toBe(true);
		const refused = reorderSections(curve, 1, 0);
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.reasons.map((reason) => reason.code)).toContain('d:prefix-peak');
		expect(curve.bands.slice(0, 2)).toEqual([CUT, BOOST]);
	});

	test('an accepted reorder returns the new bands and a passing verdict', () => {
		const curve: Curve = { bands: pad([CUT, BOOST]), preampDb: -0.5 };
		const accepted = reorderSections(curve, 1, 5);
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expect(accepted.bands[0]).toEqual(CUT);
		expect(accepted.bands[5]).toEqual(BOOST);
		expect(accepted.verdict.ok).toBe(true);
	});

	test('default order puts cuts before boosts and OFF last', () => {
		const ordered = defaultOrder([OFF, BOOST, OFF, CUT, ...pad([]).slice(4)]);
		expect(ordered.slice(0, 2)).toEqual([CUT, BOOST]);
		expect(ordered.slice(2).every((band) => band.kind === 'OFF')).toBe(true);
	});
});

describe('kind changes', () => {
	test('new kinds land inside their soft box', () => {
		expect(bandOfKind(OFF, 'PK')).toMatchObject({ kind: 'PK', freqHz: 1000, gainDb: 0 });
		const lp = bandOfKind(CUT, 'LP');
		expect(lp).toEqual({ kind: 'LP', freqHz: 1000, qFactor: 0.7 });
		expect(bandOfKind(CUT, 'OFF')).toEqual(OFF);
	});

	test('changeKind is validated by the gate', () => {
		const curve: Curve = { bands: pad([CUT]), preampDb: -1 };
		const result = changeKind(curve, 0, 'LS');
		expect(result.ok).toBe(true);
		if (result.ok) expect(gateForWrite(result.bands, -1).ok).toBe(true);
	});
});

describe('kind changes above 20 kHz', () => {
	const ULTRA_CUT: Band = { kind: 'PK', freqHz: 25000, gainDb: -6, qFactor: 1 };
	/** A boost left above 20 kHz by Modo YOLO. */
	const ULTRA_BOOST: Band = { kind: 'HS', freqHz: 25000, gainDb: 2, qFactor: 0.7 };
	const SHARP_LP: Band = { kind: 'LP', freqHz: 30000, qFactor: 2 };
	const engenharia = { layer: 'engenharia' } as const;
	const yolo = { layer: 'engenharia', yolo: true } as const;

	test('Engenharia keeps the frequency for kinds allowed there', () => {
		expect(bandOfKind(ULTRA_CUT, 'LP', engenharia)).toEqual({
			kind: 'LP',
			freqHz: 25000,
			qFactor: 0.7
		});
		expect(bandOfKind(ULTRA_CUT, 'HS', engenharia)).toEqual({
			kind: 'HS',
			freqHz: 25000,
			gainDb: -6,
			qFactor: 0.7
		});
		// LS's soft box ends at 1 kHz, but a cut is allowed up to 32 kHz: the frequency stays.
		expect(bandOfKind(ULTRA_CUT, 'LS', engenharia)).toMatchObject({ freqHz: 25000, gainDb: -6 });
		expect(bandOfKind({ kind: 'LP', freqHz: 25000, qFactor: 0.7 }, 'PK', engenharia)).toEqual({
			kind: 'PK',
			freqHz: 25000,
			gainDb: 0,
			qFactor: 1
		});
	});

	test('Engenharia without YOLO clamps the gain to <= 0 and the Q to <= 0.71', () => {
		expect(bandOfKind(ULTRA_BOOST, 'PK', engenharia)).toEqual({
			kind: 'PK',
			freqHz: 25000,
			gainDb: 0,
			qFactor: 1
		});
		expect(bandOfKind(ULTRA_BOOST, 'LS', engenharia)).toMatchObject({
			freqHz: 25000,
			gainDb: 0
		});
		const hp = bandOfKind(SHARP_LP, 'HP', engenharia);
		expect(hp).toMatchObject({ kind: 'HP', freqHz: 30000 });
		expect(hp.kind !== 'OFF' && hp.qFactor <= ULTRA_CUT_Q_MAX).toBe(true);
		const hz = (band: Band) => (band.kind === 'OFF' ? 0 : band.freqHz);
		for (const kind of ['PK', 'LS', 'HS', 'LP', 'HP'] as const) {
			for (const previous of [ULTRA_CUT, ULTRA_BOOST, SHARP_LP]) {
				const band = bandOfKind(previous, kind, engenharia);
				expect(hz(band)).toBe(hz(previous));
				expect(freqMaxFor(band, engenharia)).toBe(ULTRA_MAX_HZ);
				if (hasGain(band)) expect(band.gainDb).toBeLessThanOrEqual(0);
			}
		}
	});

	test('Modo YOLO keeps the frequency and the boost for every kind', () => {
		expect(bandOfKind(ULTRA_BOOST, 'PK', yolo)).toEqual({
			kind: 'PK',
			freqHz: 25000,
			gainDb: 2,
			qFactor: 1
		});
		expect(bandOfKind(ULTRA_BOOST, 'LS', yolo)).toMatchObject({ freqHz: 25000, gainDb: 2 });
	});

	test('outside Engenharia (or without a context) the band comes back to 20 kHz', () => {
		for (const context of [{}, { layer: 'ajustar' }, { layer: 'ajustar', yolo: true }] as const) {
			const lp = bandOfKind(ULTRA_CUT, 'LP', context);
			expect(lp).toEqual({ kind: 'LP', freqHz: 20000, qFactor: 0.7 });
		}
		expect(bandOfKind(ULTRA_CUT, 'LP')).toEqual({ kind: 'LP', freqHz: 20000, qFactor: 0.7 });
	});

	test('changeKind passes the layer and the YOLO profile to bandOfKind', () => {
		const curve: Curve = { bands: pad([ULTRA_CUT]), preampDb: -1 };
		const kept = changeKind(curve, 0, 'HS', 'standard', 'engenharia');
		expect(kept.ok).toBe(true);
		if (kept.ok) expect(kept.bands[0]).toMatchObject({ kind: 'HS', freqHz: 25000, gainDb: -6 });
		const audible = changeKind(curve, 0, 'HS');
		if (audible.ok) expect(audible.bands[0]).toMatchObject({ kind: 'HS', freqHz: 20000 });
		// A YOLO boost stays only in the YOLO profile; the standard gate refuses it there.
		const boosted: Curve = { bands: pad([ULTRA_BOOST]), preampDb: -6 };
		const standard = changeKind(boosted, 0, 'LS', 'standard', 'engenharia');
		if (standard.ok) expect(standard.bands[0]).toMatchObject({ freqHz: 25000, gainDb: 0 });
	});
});
