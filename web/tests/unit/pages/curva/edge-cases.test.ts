import { describe, expect, test } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import {
	applyMacros,
	clampMacro,
	macroCandidate,
	macroScope,
	proposeMacro,
	regionOf,
	ZERO_MACROS
} from '#lib/components/pages/curva/macros.ts';
import {
	admit,
	exportBin,
	exportS5,
	exportTxt,
	importFileText,
	linkHash,
	linkUrl,
	readLinkHash,
	safeName
} from '#lib/components/pages/curva/io.ts';
import {
	bandValue,
	replaceBand,
	verdictFor,
	type Band,
	type Curve
} from '#lib/components/pages/curva/model.ts';
import {
	formatHz,
	formatHzCompact,
	formatNumber,
	formatQ,
	formatSignedDb,
	hex,
	hexBytes,
	payloadCrc
} from '#lib/components/pages/curva/format.ts';

const neutral: Curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const cut: Band = { kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 };
const pad = (bands: Band[]) => [...bands, ...NEUTRO.bands.slice(bands.length)];
const meta = { name: 'Curva', source: 'custom', lang: 'pt-BR' as const, now: 0 };

describe('macro edge values', () => {
	test.each([
		[-99, -6],
		[99, 6],
		[0.04, 0],
		[0.16, 0.2],
		[-0.16, -0.2]
	])('clamps and rounds %s to %s', (value, expected) => {
		expect(clampMacro(value)).toBe(expected);
	});

	test('a no-op proposal does not allocate an edited curve or claim a refusal', () => {
		expect(
			proposeMacro({
				base: NEUTRO.bands,
				basePreampDb: -0.5,
				values: ZERO_MACROS,
				index: 0,
				target: 0.01
			})
		).toEqual({
			ok: false,
			value: 0,
			bands: NEUTRO.bands,
			preampDb: -0.5,
			stopped: false,
			reasons: [],
			verdict: null
		});
	});

	test('full banks without a regional section have no free scope and remain unchanged', () => {
		const full: Band[] = Array.from({ length: 10 }, () => ({ ...cut }));
		expect(macroScope(full, 0)).toEqual({ type: 'none' });
		expect(macroScope(full, 2)).toEqual({ type: 'sections', count: 10 });
		expect(applyMacros(full, [6, 0, 0, 0])).toEqual(full);
		expect(regionOf(-1)).toBe(-1);
	});

	test('Q above the boost ceiling can be cut but never boosted', () => {
		const base = pad([{ kind: 'PK', freqHz: 3000, gainDb: -1, qFactor: 5 }]);
		expect(applyMacros(base, [0, 0, 6, 0])[0]).toMatchObject({ gainDb: 0 });
		expect(applyMacros(base, [0, 0, -6, 0])[0]).toMatchObject({ gainDb: -7 });
		expect(base[0]).toMatchObject({ gainDb: -1 });
	});

	test('absolute gain limits apply to existing sections', () => {
		const base = pad([
			{ kind: 'LS', freqHz: 120, gainDb: -23, qFactor: 0.7 },
			{ kind: 'PK', freqHz: 3000, gainDb: 9, qFactor: 1 }
		]);
		const out = applyMacros(base, [-6, 0, 6, 0]);
		expect(out[0]).toMatchObject({ gainDb: -24 });
		expect(out[1]).toMatchObject({ gainDb: 9.2 });
	});

	test('a base already outside the envelope cannot be rescued by an unrelated macro', () => {
		const base = pad([{ kind: 'PK', freqHz: 15000, gainDb: 9, qFactor: 1 }]);
		const input = { base, basePreampDb: -6, values: ZERO_MACROS, index: 0, target: -1 };
		expect(macroCandidate(input, -1).accepted).toBe(false);
		const result = proposeMacro(input);
		expect(result).toMatchObject({ ok: false, value: 0, bands: base, preampDb: -6, stopped: true });
		expect(result.reasons.length).toBeGreaterThan(0);
	});
});

describe('IO refusal and dispatch boundaries', () => {
	test('TXT dispatch ignores leading whitespace; JSON objects are parsed as envelopes', () => {
		expect(importFileText(' \nPreamp: -0.5 dB\n', 'ajustar')).toMatchObject({ ok: true });
		expect(importFileText(' \n{"format":"other"}', 'ajustar')).toMatchObject({
			ok: false,
			error: 'envelope'
		});
	});

	test('blank names use the supplied fallback and names normalise before display', () => {
		expect(safeName('', 'fallback')).toBe('fallback');
		expect(safeName('  Ｃｕｒｖａ  ', 'fallback')).toBe('Curva');
	});

	test('off-grid values cannot be encoded as either an S5 code or a link', () => {
		const offGrid = { ...neutral, preampDb: -0.55 };
		expect(exportS5(offGrid, meta, 'engenharia')).toMatchObject({
			ok: false,
			error: 'grid',
			detail: 's1:grid'
		});
		expect(linkHash(offGrid, 'engenharia')).toMatchObject({ ok: false, error: 'grid' });
	});

	test('invalid envelope metadata returns an envelope failure, and TXT warnings survive admission', () => {
		expect(exportS5(neutral, { ...meta, source: 'not a source slug' }, 'ajustar')).toMatchObject({
			ok: false,
			error: 'envelope',
			detail: expect.stringContaining('env:pattern')
		});
		expect(importFileText('Preamp: -0.5 dB\nUnknown directive\n', 'ajustar')).toMatchObject({
			ok: true,
			warnings: 1
		});
	});

	test('experimental curves cannot leave Engenharia through JSON or links', () => {
		const hs: Curve = {
			bands: pad([{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }]),
			preampDb: -1
		};
		expect(exportS5(hs, meta, 'ajustar')).toMatchObject({ ok: false, error: 'experimental-layer' });
		expect(linkHash(hs, 'ouvir')).toMatchObject({ ok: false, error: 'experimental-layer' });
		const hash = linkHash(hs, 'engenharia');
		expect(hash.ok).toBe(true);
		if (!hash.ok) throw new Error('Invalid experimental link fixture');
		expect(readLinkHash(hash.value, 'ajustar')).toMatchObject({
			ok: false,
			error: 'experimental-layer'
		});
		expect(readLinkHash(hash.value, 'engenharia')).toMatchObject({ ok: true });
	});

	test('an invalid curve cannot become a binary or an admitted import', () => {
		const invalid = { ...neutral, preampDb: 1 };
		expect(exportBin(invalid)).toMatchObject({ ok: false, error: 'gate' });
		expect(
			admit({ ...invalid, name: null, bands: [...invalid.bands] }, 'engenharia')
		).toMatchObject({ ok: false, error: 'gate' });
	});

	test('nonrepresentable TXT returns a parser failure instead of throwing', () => {
		expect(
			exportTxt({ bands: Array.from({ length: 11 }, () => cut), preampDb: -1 }, 'ajustar')
		).toMatchObject({ ok: false, error: 'format' });
	});

	test('hash helper accepts hashes with and without a leading #', () => {
		expect(linkUrl(new URL('https://example.test/?x=1#old'), 'p=code')).toBe(
			'https://example.test/?x=1#p=code'
		);
	});
});

describe('model accessors and locale boundaries', () => {
	test('OFF and pass filters do not invent gain values; replacement is immutable', () => {
		expect(bandValue({ kind: 'OFF' }, 'freqHz')).toBeNull();
		expect(bandValue({ kind: 'HP', freqHz: 50, qFactor: 0.7 }, 'gainDb')).toBeNull();
		expect(bandValue(cut, 'gainDb')).toBe(-3);
		expect(bandValue(cut, 'qFactor')).toBe(1);
		const replaced = replaceBand(NEUTRO.bands, 2, cut);
		expect(replaced[2]).toEqual(cut);
		expect(NEUTRO.bands[2]).toEqual({ kind: 'OFF' });
		expect(verdictFor(neutral).ok).toBe(true);
	});

	test.each([NaN, Infinity, -Infinity])('nonfinite %s is shown as unknown', (value) => {
		expect(formatNumber(value, 'pt-BR')).toBe('?');
	});

	test('formats signed zero, decimal separators, Hz/kHz and byte fallbacks', () => {
		expect(formatNumber(-0, 'pt-BR')).toBe('0,0');
		expect(formatSignedDb(2.5, 'pt-BR')).toBe('+2,5 dB');
		expect(formatSignedDb(-2.5, 'en-US')).toBe('−2.5 dB');
		expect(formatHz(999, 'en-US')).toBe('999 Hz');
		expect(formatHz(1000, 'pt-BR')).toBe('1 kHz');
		expect(formatHz(1500, 'pt-BR')).toBe('1,50 kHz');
		expect(formatQ(0.7, 'en-US')).toBe('0.70');
		expect(hex(-1, 8)).toBe('FFFFFFFF');
		expect(hexBytes([0, 15, 255])).toBe('00 0F FF');
		expect(payloadCrc([])).toBe('0x0000');
		expect(payloadCrc([255])).toBe('0xFF00');
	});

	test('reused formatters keep locales and digits apart; a bad locale still throws', () => {
		const rounds = [1, 2, 3].map(() => [
			formatNumber(1.5, 'pt-BR', 1),
			formatNumber(1.5, 'en-US', 1),
			formatNumber(1.5, 'pt-BR', 2),
			formatNumber(-1.5, 'pt-BR', 0),
			formatHzCompact(2250, 'pt-BR'),
			formatHzCompact(2250, 'en-US')
		]);
		for (const round of rounds) {
			expect(round).toEqual(['1,5', '1.5', '1,50', '−2', '2,3 kHz', '2.3 kHz']);
		}
		expect(() => formatNumber(1, 'not a locale!')).toThrow(RangeError);
		expect(() => formatNumber(1, 'not a locale!')).toThrow(RangeError);
	});
});
