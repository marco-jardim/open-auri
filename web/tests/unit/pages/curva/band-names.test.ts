// Functional band names (bank strips and scope handles): regions, kinds and gain signs, collision
// suffixes, OFF, custom labels and label length. The copy is read from the BANKNAMES catalogs
// (staging, or the merged files once the staging is merged), so the lengths checked are real.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
	LABEL_MAX,
	REGIONS,
	badgeOf,
	bandNames,
	normalizeLabel,
	regionOf,
	shortHz,
	withLabel,
	type BandWords
} from '#lib/components/pages/curva/band-names.ts';
import type { Band } from '#lib/components/pages/curva/model.ts';

type Locale = 'pt-BR' | 'en-US';

function catalog(locale: Locale): Record<string, string> {
	const staging = new URL(
		`../../../../messages/_staging/BANKNAMES.${locale}.json`,
		import.meta.url
	);
	const merged = new URL(`../../../../messages/${locale}.json`, import.meta.url);
	return JSON.parse(readFileSync(existsSync(staging) ? staging : merged, 'utf8'));
}

function wordsFor(locale: Locale): BandWords {
	const text = catalog(locale);
	const key = (name: string) => {
		const value = text[`curva_bn_${name}`];
		if (typeof value !== 'string') throw new Error(`missing curva_bn_${name} (${locale})`);
		return value;
	};
	return {
		locale,
		regions: {
			sub: key('region_sub'),
			bass: key('region_bass'),
			body: key('region_body'),
			mids: key('region_mids'),
			presence: key('region_presence'),
			brilliance: key('region_brilliance'),
			air: key('region_air')
		},
		free: key('free'),
		cut: (freq) => key('cut').replace('{freq}', freq),
		lowCut: key('low_cut'),
		highCut: key('high_cut')
	};
}

const pt = wordsFor('pt-BR');
const en = wordsFor('en-US');
const MINUS = '\u2212';

const pk = (freqHz: number, gainDb: number): Band => ({ kind: 'PK', freqHz, gainDb, qFactor: 1 });
const ls = (freqHz: number, gainDb: number): Band => ({ kind: 'LS', freqHz, gainDb, qFactor: 0.7 });
const hs = (freqHz: number, gainDb: number): Band => ({ kind: 'HS', freqHz, gainDb, qFactor: 0.7 });
const hp = (freqHz: number): Band => ({ kind: 'HP', freqHz, qFactor: 0.7 });
const lp = (freqHz: number): Band => ({ kind: 'LP', freqHz, qFactor: 0.7 });
const off: Band = { kind: 'OFF' };

const one = (band: Band, words: BandWords = pt) => {
	const [name] = bandNames([band], words);
	if (!name) throw new Error('no name');
	return name;
};
const length = (text: string) => Array.from(text).length;

describe('regions by frequency', () => {
	test('lower bounds are inclusive: 60, 250, 800, 2.5k, 6k, 12k', () => {
		expect(regionOf(20)).toBe('sub');
		expect(regionOf(59.9)).toBe('sub');
		expect(regionOf(60)).toBe('bass');
		expect(regionOf(249)).toBe('bass');
		expect(regionOf(250)).toBe('body');
		expect(regionOf(799)).toBe('body');
		expect(regionOf(800)).toBe('mids');
		expect(regionOf(2499)).toBe('mids');
		expect(regionOf(2500)).toBe('presence');
		expect(regionOf(5999)).toBe('presence');
		expect(regionOf(6000)).toBe('brilliance');
		expect(regionOf(11999)).toBe('brilliance');
		expect(regionOf(12000)).toBe('air');
		expect(regionOf(20000)).toBe('air');
	});

	test('a boosting peak is named after its region in both languages', () => {
		const freqs = [40, 100, 400, 1000, 3000, 8000, 14000];
		expect(freqs.map((hz) => one(pk(hz, 3)).label)).toEqual([
			'Sub +',
			'Grave +',
			'Corpo +',
			'Médio +',
			'Presença +',
			'Brilho +',
			'Ar +'
		]);
		expect(freqs.map((hz) => one(pk(hz, 3), en).label)).toEqual([
			'Sub +',
			'Bass +',
			'Body +',
			'Mids +',
			'Presence +',
			'Brilliance +',
			'Air +'
		]);
	});
});

describe('kind and gain', () => {
	test('peak: "+" for a boost, a real minus for a cut, the region alone when flat', () => {
		expect(one(pk(3200, -2.5)).label).toBe(`Presença ${MINUS}`);
		expect(one(pk(3200, -2.5)).detail).toBe(`Presença ${MINUS} (PK)`);
		expect(one(pk(1000, 0)).label).toBe('Médio');
		expect(one(pk(1000, 0.04)).label).toBe('Médio');
		expect(one(pk(1000, 0.1)).label).toBe('Médio +');
		expect(one(pk(1000, -0.1)).label).toBe(`Médio ${MINUS}`);
	});

	test('shelves: arrows up or down at the corner region, the shape in the detail', () => {
		expect(one(ls(100, 4)).label).toBe('Grave \u2191');
		expect(one(ls(100, 4)).detail).toBe('Grave \u2191 (LS)');
		expect(one(ls(40, -3)).label).toBe('Sub \u2193');
		expect(one(hs(10000, -3)).label).toBe('Brilho \u2193');
		expect(one(hs(14000, 2)).label).toBe('Ar \u2191');
		expect(one(hs(14000, 2), en).label).toBe('Air \u2191');
		expect(one(hs(8000, 0)).detail).toBe('Brilho (HS)');
	});

	test('passes: "Corte" at the cutoff, the cut side in the detail', () => {
		expect(one(hp(30)).label).toBe('Corte 30 Hz');
		expect(one(hp(30)).detail).toBe('Corte de graves (HP)');
		expect(one(lp(12000)).label).toBe('Corte 12k');
		expect(one(lp(12000)).detail).toBe('Corte de agudos (LP)');
		expect(one(lp(2200)).label).toBe('Corte 2,2k');
		expect(one(lp(2200), en).label).toBe('Cut 2.2k');
		expect(one(hp(30), en).detail).toBe('Low cut (HP)');
		expect(one(lp(12000), en).detail).toBe('High cut (LP)');
	});

	test('short frequencies: whole hertz below 1 kHz, one decimal under 10 kHz', () => {
		expect(shortHz(29.6, 'pt-BR')).toBe('30 Hz');
		expect(shortHz(999.6, 'pt-BR')).toBe('1k');
		expect(shortHz(1000, 'pt-BR')).toBe('1k');
		expect(shortHz(1500, 'pt-BR')).toBe('1,5k');
		expect(shortHz(1500, 'en-US')).toBe('1.5k');
		expect(shortHz(9960, 'en-US')).toBe('10k');
		expect(shortHz(16000, 'en-US')).toBe('16k');
	});
});

describe('OFF', () => {
	test('an OFF band is "Livre" ("Free") and keeps its badge', () => {
		const names = bandNames([pk(1000, 3), off, off], pt);
		expect(names.map((name) => name.label)).toEqual(['Médio +', 'Livre', 'Livre']);
		expect(names.map((name) => name.badge)).toEqual(['A', 'B', 'C']);
		expect(one(off, en).label).toBe('Free');
		expect(one(off).detail).toBe('Livre');
	});
});

describe('collisions', () => {
	test('equal automatic names get "a", "b", "c" in slot order; others stay plain', () => {
		const names = bandNames([pk(100, 3), pk(3000, -2), pk(200, 2), pk(150, 1)], pt);
		expect(names.map((name) => name.label)).toEqual([
			'Grave + a',
			`Presença ${MINUS}`,
			'Grave + b',
			'Grave + c'
		]);
		expect(names[0]?.detail).toBe('Grave + a (PK)');
	});

	test('the sign, the kind and the region all separate names', () => {
		const names = bandNames([pk(100, 3), pk(100, -3), ls(100, 3), pk(300, 3)], pt);
		expect(names.map((name) => name.label)).toEqual([
			'Grave +',
			`Grave ${MINUS}`,
			'Grave \u2191',
			'Corpo +'
		]);
	});

	test('passes at the same cutoff collide too; their detail stays plain', () => {
		const names = bandNames([hp(30), hp(30)], pt);
		expect(names.map((name) => name.label)).toEqual(['Corte 30 Hz a', 'Corte 30 Hz b']);
		expect(names.map((name) => name.detail)).toEqual([
			'Corte de graves (HP)',
			'Corte de graves (HP)'
		]);
	});

	test('OFF bands and custom names take no part in the suffixes', () => {
		const names = bandNames([off, pk(100, 3), off, pk(120, 3)], pt, [null, 'Meu grave']);
		expect(names.map((name) => name.label)).toEqual(['Livre', 'Meu grave', 'Livre', 'Grave +']);
	});
});

describe('badges and custom labels', () => {
	test('slots are lettered A to J', () => {
		const bands = Array.from({ length: 10 }, () => off);
		expect(bandNames(bands, pt).map((name) => name.badge)).toEqual([
			'A',
			'B',
			'C',
			'D',
			'E',
			'F',
			'G',
			'H',
			'I',
			'J'
		]);
		expect(badgeOf(0)).toBe('A');
		expect(badgeOf(9)).toBe('J');
	});

	test('a custom label replaces the shown name; the automatic one stays in auto and detail', () => {
		const [name] = bandNames([ls(100, 4)], pt, ['  Peso   do  bumbo ']);
		expect(name?.label).toBe('Peso do bumbo');
		expect(name?.custom).toBe(true);
		expect(name?.auto).toBe('Grave \u2191');
		expect(name?.detail).toBe('Grave \u2191 (LS)');
		expect(bandNames([ls(100, 4)], pt, [''])[0]?.custom).toBe(false);
	});

	test('labels are trimmed, collapsed and cut to 16 characters; empty means automatic', () => {
		expect(LABEL_MAX).toBe(16);
		expect(normalizeLabel('  a  b ')).toBe('a b');
		expect(normalizeLabel('Um nome muito comprido demais')).toBe('Um nome muito co');
		expect(length(normalizeLabel('ÁÉÍÓÚ ãõ ç àèìòù ÂÊÎ') ?? '')).toBeLessThanOrEqual(16);
		expect(normalizeLabel('🎛️🎛️🎛️🎛️🎛️🎛️🎛️🎛️🎛️')).not.toMatch(/[\uD800-\uDBFF]$/);
		expect(normalizeLabel('   ')).toBeNull();
		expect(normalizeLabel(null)).toBeNull();
	});

	test('withLabel sets one slot and leaves the input untouched', () => {
		const before: (string | null)[] = ['x'];
		const after = withLabel(before, 2, ' Ar ');
		expect(after).toEqual(['x', null, 'Ar']);
		expect(before).toEqual(['x']);
		expect(withLabel(after, 0, '')).toEqual([null, null, 'Ar']);
	});
});

describe('label length', () => {
	const signs = [3, -3, 0];
	const regionHz = [40, 100, 400, 1000, 3000, 8000, 14000];
	const cutoffs = [20, 30, 99, 250, 999, 1000, 1550, 2200, 9900, 12000, 20000];

	test.each([
		['pt-BR', pt],
		['en-US', en]
	] as const)('%s: every automatic name fits 12 characters (14 with a suffix)', (locale, words) => {
		const bands: Band[] = [
			...regionHz.flatMap((hz) => signs.flatMap((db) => [pk(hz, db), ls(hz, db), hs(hz, db)])),
			...cutoffs.flatMap((hz) => [hp(hz), lp(hz)]),
			off
		];
		expect(regionHz.map(regionOf)).toEqual([...REGIONS]);
		for (const band of bands) {
			const { label } = one(band, words);
			expect(length(label), `${locale}: ${label}`).toBeLessThanOrEqual(12);
			expect(label, `${locale}: ${label}`).not.toContain('\u2014');
		}
		// The longest region word with a sign, twice: "Brilliance − a".
		const collided = bandNames([pk(8000, -3), pk(9000, -3)], words);
		for (const { label } of collided) {
			expect(length(label), `${locale}: ${label}`).toBeLessThanOrEqual(14);
		}
	});
});
