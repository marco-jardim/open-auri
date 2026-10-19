import { describe, expect, test } from 'vitest';
import { NEUTRO, OFFICIAL_PRESETS, PADRAO_AURI } from 'open-auri/catalog';
import {
	exportBin,
	exportS5,
	exportTxt,
	fileName,
	importFileText,
	importS5,
	importTxt,
	linkHash,
	linkUrl,
	NAME_MAX,
	readLinkHash,
	safeName
} from '#lib/components/pages/curva/io.ts';
import type { Band, Curve } from '#lib/components/pages/curva/model.ts';

const OFF: Band = { kind: 'OFF' };
const auri: Curve = { bands: PADRAO_AURI.bands, preampDb: PADRAO_AURI.preampDb };
const experimental: Curve = {
	bands: [
		{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 },
		...Array.from({ length: 9 }, () => OFF)
	],
	preampDb: -1
};
const meta = {
	name: 'Minha curva',
	source: 'custom',
	lang: 'pt-BR' as const,
	now: Date.UTC(2026, 9, 16)
};

function expectSameBands(actual: readonly Band[], expected: readonly Band[]) {
	expect(actual).toHaveLength(expected.length);
	expected.forEach((band, i) => {
		const got = actual[i];
		expect(got?.kind).toBe(band.kind);
		if (band.kind === 'OFF' || !got || got.kind === 'OFF') return;
		expect(got.freqHz).toBeCloseTo(band.freqHz, 9);
		expect(got.qFactor).toBeCloseTo(band.qFactor, 9);
		if ('gainDb' in band && band.gainDb !== undefined) {
			expect('gainDb' in got ? got.gainDb : undefined).toBeCloseTo(band.gainDb, 9);
		}
	});
}

describe('.txt (EqualizerAPO)', () => {
	test.each([NEUTRO, ...OFFICIAL_PRESETS])('round trip of %s', (preset) => {
		const text = exportTxt({ bands: preset.bands, preampDb: preset.preampDb }, 'ouvir');
		expect(text.ok).toBe(true);
		if (!text.ok) return;
		const back = importTxt(text.value, 'ouvir');
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.curve.preampDb).toBeCloseTo(preset.preampDb, 9);
		expectSameBands(back.curve.bands, preset.bands);
	});

	test('HS/LP/HP only in Engenharia, both ways', () => {
		expect(exportTxt(experimental, 'ajustar')).toMatchObject({
			ok: false,
			error: 'experimental-layer'
		});
		const text = exportTxt(experimental, 'engenharia');
		expect(text.ok).toBe(true);
		if (!text.ok) return;
		expect(importTxt(text.value, 'ajustar')).toMatchObject({
			ok: false,
			error: 'experimental-layer'
		});
		const back = importTxt(text.value, 'engenharia');
		expect(back.ok).toBe(true);
		if (back.ok) expectSameBands(back.curve.bands, experimental.bands);
	});

	test('imports must pass the gate', () => {
		const result = importTxt('Preamp: 0 dB\nFilter 1: ON PK Fc 1000 Hz Gain 6 dB Q 1\n', 'ajustar');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe('gate');
		expect(result.reasons.length).toBeGreaterThan(0);
	});

	test('more than 10 filters and malformed files are refused', () => {
		const eleven = Array.from(
			{ length: 11 },
			(_, i) => `Filter ${i + 1}: ON PK Fc ${1000 + i} Hz Gain -1 dB Q 1`
		).join('\n');
		expect(importTxt(`Preamp: -3 dB\n${eleven}\n`, 'ajustar')).toMatchObject({ error: 'too-many' });
		expect(importTxt('Filter 1: ON PK Fc abc Hz Gain 1 dB Q 1', 'ajustar')).toMatchObject({
			ok: false,
			error: 'format'
		});
	});
});

describe('S1 link (#p=)', () => {
	test.each([NEUTRO, ...OFFICIAL_PRESETS])('round trip of %s', (preset) => {
		const curve = { bands: preset.bands, preampDb: preset.preampDb };
		const hash = linkHash(curve, 'ouvir');
		expect(hash.ok).toBe(true);
		if (!hash.ok) return;
		expect(hash.value.startsWith('#p=')).toBe(true);
		const back = readLinkHash(hash.value, 'ouvir');
		expect(back?.ok).toBe(true);
		if (!back?.ok) return;
		expect(back.curve.preampDb).toBe(preset.preampDb);
		expectSameBands(back.curve.bands, preset.bands);
	});

	test('no link, broken link and the URL helper', () => {
		expect(readLinkHash('', 'ouvir')).toBeNull();
		expect(readLinkHash('#section', 'ouvir')).toBeNull();
		expect(readLinkHash('#p=not-a-curve', 'ouvir')).toMatchObject({ ok: false, error: 'link' });
		const url = linkUrl(new URL('https://example.test/?camada=ajustar#old'), '#p=XYZ');
		expect(url).toBe('https://example.test/?camada=ajustar#p=XYZ');
	});
});

describe('S5 JSON (open-auri/preset@1)', () => {
	test('round trip keeps bands, preamp and the name', () => {
		const json = exportS5(auri, meta, 'ouvir');
		expect(json.ok).toBe(true);
		if (!json.ok) return;
		expect(JSON.parse(json.value)).toMatchObject({
			format: 'open-auri/preset@1',
			name: 'Minha curva'
		});
		const back = importS5(json.value, 'ouvir');
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.curve.name).toBe('Minha curva');
		expect(back.curve.preampDb).toBe(auri.preampDb);
		expectSameBands(back.curve.bands, auri.bands);
		expect(importFileText(json.value, 'ouvir').ok).toBe(true);
	});

	test('invalid envelopes are refused', () => {
		expect(importS5('{"format":"other"}', 'ouvir')).toMatchObject({ ok: false, error: 'envelope' });
		expect(importS5('not json', 'ouvir')).toMatchObject({ ok: false, error: 'envelope' });
	});
});

describe('.bin', () => {
	test('is the exact 220-byte payload with the preset CRC', () => {
		const bin = exportBin(auri, 'ajustar');
		expect(bin.ok).toBe(true);
		if (!bin.ok) return;
		expect(bin.value).toHaveLength(220);
		expect((bin.value[218] ?? 0) | ((bin.value[219] ?? 0) << 8)).toBe(PADRAO_AURI.crc);
		expect([...bin.value.slice(0, 4)]).toEqual([0x45, 0x51, 0x31, 0x23]);
	});
});

describe('untrusted names', () => {
	test('markup stays plain text; controls and URL-like names fall back', () => {
		expect(safeName('<img src=x onerror=alert(1)>', 'x')).toBe('<img src=x onerror=alert(1)>');
		expect(safeName('a\u0000b', 'fallback')).toBe('fallback');
		expect(safeName('https://evil.example', 'fallback')).toBe('fallback');
		expect(safeName(42, 'fallback')).toBe('fallback');
		expect(Array.from(safeName('é'.repeat(80), 'x'))).toHaveLength(NAME_MAX);
	});

	test('file names are ASCII slugs', () => {
		expect(fileName('Harman IE 2019', 'txt')).toBe('harman-ie-2019.txt');
		expect(fileName('<img src=x>', 'bin')).toBe('img-src-x.bin');
		expect(fileName('***', 'json')).toBe('open-auri.json');
	});
});
