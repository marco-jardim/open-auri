import { describe, expect, test } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import {
	bandOfKind,
	changeKind,
	defaultOrder,
	moveSection,
	reorderSections
} from '#lib/components/pages/curva/edit.ts';
import type { Band, Curve } from '#lib/components/pages/curva/model.ts';

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
