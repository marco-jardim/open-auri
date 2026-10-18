import { expect, test } from 'vitest';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { gateForWrite } from 'open-auri/safety';
import type { JournalEntry } from '#lib/cable/types.ts';
import { loadDecision } from '#lib/components/pages/cabo/load-entry.ts';

test.each([NEUTRO, PADRAO_AURI])(
	'a YOLO journal entry passing the standard gate loads with YOLO off: $id',
	(preset) => {
		const entry = {
			bands: preset.bands.map((band) => ({ ...band })),
			preampDb: preset.preampDb,
			profile: 'yolo' as const
		};
		expect(gateForWrite(entry.bands, entry.preampDb).ok).toBe(true);
		expect(loadDecision(entry, false)).toEqual({ load: true, profile: 'standard' });
	}
);

test('a YOLO journal entry still uses the YOLO gate when enabled', () => {
	const entry = {
		bands: NEUTRO.bands.map((band) => ({ ...band })),
		preampDb: NEUTRO.preampDb,
		profile: 'yolo' as const
	};
	expect(loadDecision(entry, true)).toEqual({ load: true, profile: 'yolo' });
});

test('standard fallback also validates experimental kinds with the correct gate option', () => {
	const entry: Pick<JournalEntry, 'bands' | 'preampDb' | 'profile'> = {
		bands: [{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }, ...NEUTRO.bands.slice(1)],
		preampDb: -3,
		profile: 'yolo'
	};
	expect(gateForWrite(entry.bands, entry.preampDb, { experimental: true }).ok).toBe(true);
	expect(loadDecision(entry, false)).toEqual({ load: true, profile: 'standard' });
});

test('a YOLO entry rejected by the standard gate cannot load with YOLO off', () => {
	const entry = {
		bands: NEUTRO.bands.map((band) => ({ ...band })),
		preampDb: 1,
		profile: 'yolo' as const
	};
	expect(gateForWrite(entry.bands, entry.preampDb).ok).toBe(false);
	expect(loadDecision(entry, false)).toEqual({ load: false, reason: 'yolo-off' });
	expect(loadDecision(entry, true)).toEqual({ load: false, reason: 'gate' });
});

test.each([false, true])('untagged entries always use the standard gate (YOLO %s)', (enabled) => {
	const entry = {
		bands: NEUTRO.bands.map((band) => ({ ...band })),
		preampDb: NEUTRO.preampDb
	};
	expect(loadDecision(entry, enabled)).toEqual({ load: true, profile: 'standard' });
	expect(loadDecision({ ...entry, preampDb: 1 }, enabled)).toEqual({ load: false, reason: 'gate' });
});
