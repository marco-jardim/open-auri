import { describe, expect, test } from 'vitest';
import { autoPreamp, gateForWrite, THRESHOLDS } from 'open-auri/safety';
import { maxPreamp } from '#lib/components/pages/curva/edit.ts';
import type { Band, Curve } from '#lib/components/pages/curva/model.ts';

const OFF: Band = { kind: 'OFF' };
const curveWith = (bands: Band[], preampDb: number): Curve => ({
	bands: [...bands, ...Array.from({ length: 10 - bands.length }, () => OFF)],
	preampDb
});

describe('"Máximo sem clipping" (highest gate-approved preamp)', () => {
	test('cuts only: the preamp goes to the top of its range and the full gate accepts it', () => {
		const curve = curveWith([{ kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 }], -6);
		const result = maxPreamp(curve);
		expect(result).toMatchObject({ ok: true, preampDb: THRESHOLDS.preampMaxDb, changed: true });
		if (!result.ok) return;
		expect(result.verdict.ok).toBe(true);
		expect(result.verdict.metrics.grid).toBe('full');
	});

	test('a boost gets the highest 0.1 dB preamp that passes; 0.1 dB more would not', () => {
		const curve = curveWith([{ kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 }], -12);
		const result = maxPreamp(curve);
		if (!result.ok) throw new Error('A single +6 dB boost has a safe preamp');
		expect(result.preampDb).toBe(autoPreamp(curve.bands));
		expect(result.preampDb).toBeLessThan(THRESHOLDS.preampMaxDb);
		expect(gateForWrite(curve.bands, result.preampDb).ok).toBe(true);
		const above = Math.round((result.preampDb + 0.1) * 10) / 10;
		expect(gateForWrite(curve.bands, above).ok).toBe(false);
		// Pressing again changes nothing.
		const again = maxPreamp({ bands: curve.bands, preampDb: result.preampDb });
		expect(again).toMatchObject({ ok: true, preampDb: result.preampDb, changed: false });
	});

	test('a curve no preamp can fix is refused with its own reasons', () => {
		// D7: no PK boost above 16 kHz, whatever the preamp.
		const curve = curveWith([{ kind: 'PK', freqHz: 17000, gainDb: 2, qFactor: 1 }], -6);
		const result = maxPreamp(curve);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reasons.map((reason) => reason.code)).toContain('d7:pk-boost-above-16k');
	});
});
