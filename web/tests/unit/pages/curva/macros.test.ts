import { describe, expect, test } from 'vitest';
import { NEUTRO, OFFICIAL_PRESETS, PADRAO_AURI } from 'open-auri/catalog';
import { gateForWrite } from 'open-auri/safety';
import {
	applyMacros,
	macroScope,
	macroTargets,
	MACROS,
	proposeMacro,
	regionOf,
	ZERO_MACROS,
	type MacroValues
} from '#lib/components/pages/curva/macros.ts';
import type { Band } from '#lib/components/pages/curva/model.ts';

const OFF: Band = { kind: 'OFF' };
const tenOff = (): Band[] => Array.from({ length: 10 }, () => OFF);
const withMacro = (index: number, value: number): MacroValues => {
	const values = [0, 0, 0, 0];
	values[index] = value;
	return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0];
};

describe('macro mapping', () => {
	test('regions: Grave < 250 Hz ≤ Corpo < 1 kHz ≤ Presença < 6 kHz ≤ Brilho', () => {
		expect(regionOf(100)).toBe(0);
		expect(regionOf(250)).toBe(1);
		expect(regionOf(999)).toBe(1);
		expect(regionOf(1000)).toBe(2);
		expect(regionOf(6000)).toBe(3);
		expect(regionOf(20000)).toBe(3);
	});

	test('moves only PK/LS bands of its region, never HS/LP/HP', () => {
		const base: Band[] = [
			{ kind: 'LS', freqHz: 105, gainDb: -2, qFactor: 0.7 },
			{ kind: 'PK', freqHz: 3000, gainDb: -3, qFactor: 1.4 },
			{ kind: 'HS', freqHz: 120, gainDb: -2, qFactor: 0.7 },
			{ kind: 'HP', freqHz: 60, qFactor: 0.7 },
			...tenOff().slice(4)
		];
		expect(macroTargets(base, 0)).toEqual([0]);
		const out = applyMacros(base, withMacro(0, 1.5));
		expect(out[0]).toEqual({ kind: 'LS', freqHz: 105, gainDb: -0.5, qFactor: 0.7 });
		expect(out[1]).toEqual(base[1]);
		expect(out[2]).toEqual(base[2]);
		expect(out[3]).toEqual(base[3]);
	});

	test('creates the documented section in a free slot when the region is empty', () => {
		const out = applyMacros(tenOff(), [1, -2, 0.5, -1]);
		expect(out.slice(0, 4)).toEqual([
			{ kind: 'LS', freqHz: 120, qFactor: 0.6, gainDb: 1 },
			{ kind: 'PK', freqHz: 500, qFactor: 1, gainDb: -2 },
			{ kind: 'PK', freqHz: 3000, qFactor: 1.4, gainDb: 0.5 },
			{ kind: 'PK', freqHz: 9000, qFactor: 1.4, gainDb: -1 }
		]);
		expect(macroScope(tenOff(), 1)).toEqual({ type: 'free' });
	});

	test('D7 up front: a PK above 16 kHz can only be cut', () => {
		const base: Band[] = [
			{ kind: 'PK', freqHz: 18000, gainDb: -1, qFactor: 1 },
			...tenOff().slice(1)
		];
		const out = applyMacros(base, withMacro(3, 4));
		expect(out[0]).toMatchObject({ gainDb: 0 });
	});

	test('zero values return the base unchanged', () => {
		expect(applyMacros(PADRAO_AURI.bands, ZERO_MACROS)).toEqual([...PADRAO_AURI.bands]);
	});
});

describe('macro proposals are always gate-valid', () => {
	const presets = [
		NEUTRO,
		PADRAO_AURI,
		...OFFICIAL_PRESETS.filter((p) => p !== PADRAO_AURI).slice(0, 3)
	];
	for (const preset of presets) {
		for (const [index, macro] of MACROS.entries()) {
			for (const target of [6, -6]) {
				test(`${preset.id} · ${macro.id} → ${target} dB`, () => {
					const proposal = proposeMacro({
						base: preset.bands,
						basePreampDb: preset.preampDb,
						values: ZERO_MACROS,
						index,
						target
					});
					if (proposal.ok) {
						expect(
							gateForWrite(proposal.bands, proposal.preampDb, { experimental: false }).ok
						).toBe(true);
						expect(proposal.preampDb).toBeLessThanOrEqual(preset.preampDb);
						expect(Math.abs(proposal.value)).toBeLessThanOrEqual(6);
						expect(Math.round(proposal.value * 10) / 10).toBe(proposal.value);
						if (proposal.stopped) {
							expect(Math.abs(proposal.value)).toBeLessThan(6);
							expect(proposal.reasons.length).toBeGreaterThan(0);
						}
					} else {
						// Nothing changed: the editor keeps the (already valid) base curve.
						expect(proposal.bands).toEqual([...preset.bands]);
						expect(proposal.preampDb).toBe(preset.preampDb);
					}
				}, 60000);
			}
		}
	}

	test('a boost that cannot fit stops at the boundary with a reason', () => {
		// PK 15 kHz Q 1: at +9 dB its b0 (≈1.37) passes the largest b0 of the official presets
		// (1.3124), so Brilho +6 from +3 dB must stop short (no preamp can fix criterion a).
		const base: Band[] = [
			{ kind: 'PK', freqHz: 15000, gainDb: 3, qFactor: 1 },
			...tenOff().slice(1)
		];
		expect(gateForWrite(base, -6).ok).toBe(true);
		const proposal = proposeMacro({
			base,
			basePreampDb: -6,
			values: ZERO_MACROS,
			index: 3,
			target: 6
		});
		expect(proposal.ok).toBe(true);
		expect(gateForWrite(proposal.bands, proposal.preampDb).ok).toBe(true);
		expect(proposal.stopped).toBe(true);
		expect(proposal.reasons.map((reason) => reason.code)).toContain('a:b0');
		expect(proposal.value).toBeGreaterThan(0);
		expect(proposal.value).toBeLessThan(6);
	}, 60000);
});
