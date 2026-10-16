import { describe, expect, test } from 'vitest';
import { NEUTRO, OFFICIAL_PRESETS, presetsByGroup } from 'open-auri/catalog';
import { distance, levelDb } from 'open-auri/dsp';
import { gateForWrite } from 'open-auri/safety';
import { decodeS1, encodeS1, parseEnvelope } from 'open-auri/share';
import type { LibraryItem } from '#lib/state/library.svelte.ts';
import { neutralCurve } from '#lib/state/model.ts';
import {
	ANALYSIS_GRID,
	archiveTapes,
	automaticTags,
	dataReadings,
	envelopeView,
	number,
	referencePack,
	selectTapes,
	type Tag
} from '#lib/components/pages/biblioteca/archive.ts';

const current = neutralCurve();
const local: LibraryItem = {
	...current,
	id: 'my-tape',
	name: 'Minha decisão',
	source: 'custom',
	s1: encodeS1(current),
	favorite: true,
	createdAt: 1760000000000,
	updatedAt: 1760000000000
};
const tagLabels: Record<Tag, string> = {
	bass: 'Graves +',
	bright: 'Brilho +',
	lean: 'Graves −',
	dark: 'Agudos −',
	flat: 'Equilibrada'
};
const options = {
	query: '',
	tag: 'all',
	sort: 'official',
	current,
	locale: 'pt-BR',
	tagLabels
} as const;

describe('Biblioteca archive', () => {
	test('preserves official shelf grouping, labels, order and written band order alongside local items', () => {
		const tapes = archiveTapes([local]);
		expect(tapes).toHaveLength(12);
		expect(tapes.slice(0, 11).map((tape) => tape.name)).toEqual(
			OFFICIAL_PRESETS.map((preset) => preset.label)
		);
		for (const group of ['preferencia', 'referencia']) {
			expect(tapes.filter((tape) => tape.group === group).map((tape) => tape.source)).toEqual(
				presetsByGroup(group).map((preset) => `preset:${preset.id}`)
			);
		}
		expect(tapes[0].bands).toBe(OFFICIAL_PRESETS[0].bands);
		expect(tapes[11]).toMatchObject({ id: 'local:my-tape', group: 'local', favorite: true });
		expect(
			selectTapes(tapes, options)
				.filter((tape) => tape.group === 'preferencia')
				.map((tape) => tape.order)
		).toEqual(presetsByGroup('preferencia').map((preset) => preset.order));
	});

	test('searches names, ids, descriptions and localized tags without case or accent sensitivity', () => {
		const tapes = archiveTapes([local]);
		expect(
			selectTapes(tapes, { ...options, query: 'ENERGICO' }).map((tape) => tape.source)
		).toContain('preset:energico');
		expect(
			selectTapes(tapes, { ...options, query: 'local:my-tape' }).map((tape) => tape.name)
		).toEqual([local.name]);
		expect(
			selectTapes(tapes, { ...options, query: 'minha decisao' }).map((tape) => tape.name)
		).toEqual([local.name]);
		expect(
			selectTapes(tapes, { ...options, query: 'equilibrada' }).some(
				(tape) => tape.group === 'local'
			)
		).toBe(true);
		expect(selectTapes(tapes, { ...options, query: 'no such tape' })).toEqual([]);
	});

	test('automatic tags use core response regions, not names or preamp', () => {
		const shelf = (gainDb: number) => ({
			bands: [{ kind: 'LS' as const, freqHz: 200, gainDb, qFactor: 0.7 }]
		});
		expect(automaticTags(shelf(6))).toContain('bass');
		expect(automaticTags(shelf(-6))).toContain('lean');
		expect(
			automaticTags({ bands: [{ kind: 'HS', freqHz: 4000, gainDb: 6, qFactor: 0.7 }] })
		).toContain('bright');
		expect(
			automaticTags({ bands: [{ kind: 'HS', freqHz: 4000, gainDb: -6, qFactor: 0.7 }] })
		).toContain('dark');
		expect(automaticTags(NEUTRO)).toEqual(['flat']);
		expect(automaticTags({ ...NEUTRO, preampDb: -20 })).toEqual(['flat']);
		const tapes = archiveTapes([local]);
		expect(
			selectTapes(tapes, { ...options, tag: 'bass' }).every((tape) => tape.tags.includes('bass'))
		).toBe(true);
	});

	test('sorting is stable, localized and never mutates the shelf or band arrays', () => {
		const tapes = archiveTapes([local]);
		const ids = tapes.map((tape) => tape.id);
		const byPre = selectTapes(tapes, { ...options, sort: 'pre' });
		expect(byPre.map((tape) => tape.preampDb)).toEqual(
			[...tapes].map((tape) => tape.preampDb).sort((a, b) => a - b)
		);
		const byName = selectTapes(tapes, { ...options, sort: 'name', locale: 'en-US' });
		expect(byName[0].name).toBe('Analítico');
		const byDistance = selectTapes(tapes, { ...options, sort: 'distance' });
		expect(byDistance[0].id).toBe('local:my-tape');
		expect(tapes.map((tape) => tape.id)).toEqual(ids);
		expect(tapes[0].bands).toBe(OFFICIAL_PRESETS[0].bands);
	});

	test('DATA values come from levelDb, gate peaks and core S4, including absolute preamp differences', () => {
		const tape = archiveTapes([])[0];
		const verdict = gateForWrite(tape.bands, tape.preampDb);
		const data = dataReadings(tape, current, verdict);
		const comparison = distance(tape, current, { grid: ANALYSIS_GRID, levelMatch: false });
		expect(ANALYSIS_GRID).toHaveLength(601);
		expect(data.levelDb).toBe(levelDb(tape.bands, tape.preampDb));
		expect(data.preampDb).toBe(tape.preampDb);
		expect(data.peakDb).toBe(verdict.metrics.outputAudible?.db);
		expect(data.jumpDb).toBe(data.levelDb - levelDb(current.bands, current.preampDb));
		expect(data.rmsDb).toBe(comparison.rmsDb);
		expect(data.maxDb).toBe(comparison.maxDb);
		expect(dataReadings(current, { ...current, preampDb: -3.5 }, null).rmsDb).toBeCloseTo(3, 9);
		expect(dataReadings(current, current, null)).toMatchObject({
			peakDb: null,
			rmsDb: 0,
			jumpDb: 0
		});
	});

	test('S5 preserves license uncertainty and serializes only explicitly licensed local creations', () => {
		const official = archiveTapes([])[0];
		const draft = envelopeView(official, 'pt-BR', 'CC0-1.0');
		expect(draft.exportable).toBe(false);
		expect(JSON.parse(draft.json)).toMatchObject({
			license: null,
			source: 'preset:padrao',
			createdAt: null
		});
		const tape = archiveTapes([local]).at(-1);
		expect(tape).toBeDefined();
		if (!tape) throw new Error('Missing fixture');
		expect(envelopeView(tape, 'en-US').exportable).toBe(false);
		const result = envelopeView(tape, 'en-US', 'CC0-1.0');
		expect(result.exportable).toBe(true);
		expect(parseEnvelope(result.json).ok).toBe(true);
		expect(JSON.parse(result.json)).toMatchObject({
			source: 'custom',
			license: 'CC0-1.0',
			lang: 'en-US'
		});
		expect(() => envelopeView(tape, 'pt-BR', 'CC-BY-4.0')).toThrow('attribution');
		expect(parseEnvelope(envelopeView(tape, 'pt-BR', 'CC-BY-4.0', 'Autoria').json).ok).toBe(true);
		expect(envelopeView({ ...tape, source: 'preset:padrao' }, 'pt-BR', 'CC0-1.0').exportable).toBe(
			false
		);
	});

	test('S9 contains exactly the reference group, retains its S1 values and does not invent a license', () => {
		const pack: {
			format: string;
			presets: { id: string; code: string; license: null; licenseStatus: string }[];
		} = JSON.parse(referencePack());
		expect(pack.format).toBe('open-auri/pack@1');
		expect(pack.presets.map((preset) => preset.id)).toEqual(
			presetsByGroup('referencia').map((preset) => preset.id)
		);
		pack.presets.forEach((preset, index) => {
			expect(preset.license).toBeNull();
			expect(preset.licenseStatus).toBe('a confirmar');
			expect(decodeS1(preset.code).bands).toEqual(presetsByGroup('referencia')[index].bands);
		});
	});

	test('both locales use their decimal separators and a real minus sign', () => {
		expect(number(-2.8, 'pt-BR')).toBe('−2,8');
		expect(number(-2.8, 'en-US')).toBe('−2.8');
		expect(number(null, 'en-US')).toBe('∅');
		expect(number(undefined, 'en-US')).toBe('∅');
		expect(number(undefined, 'pt-BR')).toBe('∅');
	});
});
