import { describe, expect, test } from 'vitest';
import { NEUTRO, OFFICIAL_PRESETS } from 'open-auri/catalog';
import { m } from '#lib/paraglide/messages.js';
import { CRITERIA, criteria, criterionName } from '#lib/components/pages/curva/envelope.ts';
import { MINI_GRID, miniPath, miniResponse } from '#lib/components/pages/curva/mini.ts';
import {
	replaceBand,
	verdictFor,
	type Band,
	type Curve
} from '#lib/components/pages/curva/model.ts';
import { isEmptyCurve, PARKED_HZ, parkedBand } from '#lib/components/pages/curva/parked.ts';

const neutral: Curve = { bands: [...NEUTRO.bands], preampDb: NEUTRO.preampDb };
const BOOST: Band = { kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 };

/** The y values of a mini path ("M0.0 10.0L2.1 10.0…"). */
function ys(path: string): number[] {
	return [...path.matchAll(/[ML][\d.]+ ([\d.-]+)/g)].map((match) => Number(match[1]));
}

describe('envelope strip: the gate criteria (a) to (g)', () => {
	test('Neutro passes all seven, with values from the verdict and the payload CRC', () => {
		const rows = criteria(verdictFor(neutral), 'pt-BR');
		expect(rows.map((row) => row.id)).toEqual([...CRITERIA]);
		expect(rows.every((row) => row.pass && row.known)).toBe(true);
		const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
		expect(byId.f?.value).toBe('0x4FFF');
		expect(byId.g?.value).toBe('−0,5 dB');
		expect(byId.g?.limit).toBe('−25,5 dB a −0,5 dB');
		expect(byId.e?.limit).toBe('−0,47 dB');
		expect(byId.a?.value).toMatch(/^\d+,\d %$/);
		expect(byId.b?.value).toMatch(/^\d,\d{5}$/);
	});

	test('a failing criterion is reported by its letter, never invented', () => {
		const rows = criteria(verdictFor({ bands: neutral.bands, preampDb: -0.2 }), 'pt-BR');
		const failed = rows.filter((row) => !row.pass).map((row) => row.id);
		// A preamp above −0,5 dB: the preamp criterion (or the codec, if it refuses first).
		expect(failed.some((id) => id === 'g' || id === 'f')).toBe(true);
		const boosted = criteria(
			verdictFor({ bands: replaceBand(neutral.bands, 0, BOOST), preampDb: -0.5 }),
			'en-US'
		);
		expect(boosted.find((row) => row.id === 'e')?.pass).toBe(false);
		expect(boosted.find((row) => row.id === 'f')?.pass).toBe(true);
	});

	test('criteria have plain-language names in pt-BR, without plan codes', () => {
		for (const id of CRITERIA) {
			const name = criterionName[id]();
			expect(name.length).toBeGreaterThan(0);
			expect(name).not.toMatch(/\b[STF]\d+\b/);
		}
		expect(m.curva_v2_envelope_title()).toBe('Envelope observado');
		expect(m.curva_v2_details()).toBe('Ver detalhes técnicos');
	});
});

describe('mini responses (preset cards and bank strips)', () => {
	test('come from the core response: flat for Neutro, raised by a boost', () => {
		expect(MINI_GRID[0]).toBeCloseTo(20, 6);
		expect(MINI_GRID[MINI_GRID.length - 1]).toBeCloseTo(20000, 3);
		expect(ys(miniPath(neutral.bands)).every((y) => y === 10)).toBe(true);
		const boosted = ys(miniPath([BOOST]));
		expect(boosted).toHaveLength(MINI_GRID.length);
		expect(Math.min(...boosted)).toBeLessThan(10);
		expect(Math.max(...miniResponse([BOOST]))).toBeCloseTo(6, 0);
	});

	test('every official preset has a drawable thumbnail', () => {
		for (const preset of OFFICIAL_PRESETS) {
			const path = miniPath(preset.bands);
			expect(path.startsWith('M0.0 ')).toBe(true);
			expect(ys(path).every((y) => y >= 0 && y <= 20)).toBe(true);
		}
	});
});

describe('Neutro parked points', () => {
	test('ten flat PK points inside the PK safe box, each one gate-approved on Neutro', () => {
		expect(PARKED_HZ).toHaveLength(10);
		// Inside 'PK-main' (150 Hz to 20 kHz), strictly rising, and below the 16 kHz PK-boost stop.
		expect(PARKED_HZ[0]).toBeGreaterThanOrEqual(150);
		expect(PARKED_HZ[PARKED_HZ.length - 1]).toBeLessThan(16000);
		expect(PARKED_HZ.every((hz, i) => i === 0 || hz > (PARKED_HZ[i - 1] ?? 0))).toBe(true);
		expect(isEmptyCurve(neutral.bands)).toBe(true);
		expect(isEmptyCurve([BOOST, ...neutral.bands.slice(1)])).toBe(false);
		PARKED_HZ.forEach((hz, index) => {
			const band = parkedBand(index);
			expect(band).toMatchObject({ kind: 'PK', freqHz: hz, gainDb: 0 });
			const verdict = verdictFor({
				bands: replaceBand(neutral.bands, index, band),
				preampDb: neutral.preampDb
			});
			expect(verdict.ok, `parked point ${index + 1}`).toBe(true);
		});
	});
});
