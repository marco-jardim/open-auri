import { describe, expect, test } from 'vitest';
import { OFFICIAL_PRESETS } from 'open-auri/catalog';
import { encodePayload, preampWord, reportsFromPayload } from 'open-auri/dsp';
import { SOFT_RANGES, THRESHOLDS } from 'open-auri/safety';
import { docsContent, creditSources } from '#lib/content/docs/index.ts';
import { legalNotice } from '#lib/content/docs/legal-notice.ts';
import {
	auriPayload,
	auriPreset,
	crcExample,
	exactNumber,
	hex,
	q23Example,
	reportHex,
	softRangeRows,
	tapeHex,
	thresholdRows
} from '#lib/components/pages/docs/model.ts';
import {
	activeSection,
	buildSearchIndex,
	isSearchShortcut,
	searchSections
} from '#lib/components/pages/docs/search.ts';

test('tape and all nine reports are real Auri bytes, not decorative hex', () => {
	expect(auriPreset).toBe(OFFICIAL_PRESETS.find((preset) => preset.id === 'padrao'));
	expect(auriPayload).toEqual(encodePayload(auriPreset.bands, auriPreset.preampDb));
	expect(tapeHex.split(' ')).toHaveLength(220);
	expect(tapeHex).toBe(hex(auriPayload));
	expect(reportHex.split('\n')).toEqual(
		reportsFromPayload(auriPayload).map((report, i) => `${i}: ${hex(report)}`)
	);
	expect(auriPayload.slice(-2)).toEqual([0x70, 0x19]);
});

test('Q23 and CRC examples delegate to the production codec', () => {
	expect(q23Example('−6,0')?.word).toBe(preampWord(-6));
	expect(q23Example('0')?.bytes).toBe('00 00 80 00');
	expect(q23Example('−0.5')).toEqual(q23Example('-0,5'));
	for (const invalid of ['', 'NaN', 'Infinity', '1', '--6', '6junk', '1,2,3'])
		expect(q23Example(invalid)).toBeNull();
	expect(crcExample('123456789')).toEqual({ value: '0x29B1', bytes: 'B1 29' });
	expect(crcExample('')).toEqual({ value: '0xFFFF', bytes: 'FF FF' });
	expect(crcExample('á')).not.toEqual(crcExample('a'));
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	describe(locale, () => {
		const content = docsContent(locale);
		test('all exact thresholds come from THRESHOLDS, with no decimal truncation', () => {
			const rows = thresholdRows(content);
			expect(softRangeRows(locale).map((row) => row.profile)).toEqual(Object.keys(SOFT_RANGES));
			THRESHOLDS.coefficientPositions.forEach((position, i) => {
				expect(rows[i]).toEqual({
					id: `coefficient-${i}`,
					label: `|${position.replace('-', '−')}|`,
					value: `${exactNumber(THRESHOLDS.coefficientAbs[i], locale)} · ${THRESHOLDS.coefficientAbsWords[i]} LSB`
				});
			});
			for (const key of [
				'poleRadius',
				'sectionPeakDb',
				'internalAudibleDb',
				'outputAudibleDb',
				'outputFullDb'
			] as const) {
				expect(rows.find((row) => row.id === key)?.value).toContain(
					exactNumber(THRESHOLDS[key], locale)
				);
			}
			expect(rows.find((row) => row.id === 'preamp')?.value).toBe(
				`${exactNumber(THRESHOLDS.preampMinDb, locale)} … ${exactNumber(THRESHOLDS.preampMaxDb, locale)} dB`
			);
			expect(rows.find((row) => row.id === 'dbTolerance')?.value).toBe(
				exactNumber(THRESHOLDS.dbNumericalTolerance, locale)
			);
			expect(rows.find((row) => row.id === 'radiusTolerance')?.value).toBe(
				exactNumber(THRESHOLDS.radiusNumericalTolerance, locale)
			);
		});
		test('legal anchor and full notice exist in both locales; social sections are filled', () => {
			expect(content.sections.find((section) => section.id === 'aviso-legal')?.paragraphs).toEqual(
				legalNotice[locale]
			);
			expect(content.sections.map((section) => section.id)).toEqual([
				'comeco',
				'camadas',
				'envelope',
				'protocolo',
				'protocolo-cabo',
				'limites',
				'memoria',
				'previa',
				'dados-locais',
				'pagina-oficial',
				'perguntas',
				'glossario',
				'aviso-legal',
				'creditos',
				'contas',
				'privacidade-atividade',
				'rankings',
				'moderacao',
				's6',
				's7',
				'android',
				'android-validacao',
				'android-resgate',
				'android-usb',
				'android-diagnostico',
				'android-iphone',
				'android-assinatura',
				'android-privacidade'
			]);
			expect(content.safetyCaveat).toMatch(locale === 'pt-BR' ? /não uma prova/ : /not a proof/);
			for (const id of ['contas', 'privacidade-atividade', 'rankings', 'moderacao', 's6', 's7']) {
				const section = content.sections.find((entry) => entry.id === id);
				expect(section?.paragraphs.length).toBeGreaterThan(0);
				expect(JSON.stringify(section)).not.toMatch(/próxima fase|next phase/);
			}
			if (locale === 'pt-BR') expect(JSON.stringify(content)).not.toContain('—');
		});
		test('cable protocol section documents the official app findings with its sources', () => {
			const section = content.sections.find((entry) => entry.id === 'protocolo-cabo');
			const text = section?.paragraphs.join(' ') ?? '';
			for (const fact of [
				'CB1100AU',
				'14 + 20 × n',
				'01 tag 00 01 FF',
				'01 tag 00 00 FF',
				'80 00 00 00 FF',
				'0x65',
				'TT39510B01'
			])
				expect(text).toContain(fact);
			expect(section?.links?.map((link) => link.href)).toEqual([
				'https://peq.szwalkplay.com/',
				'https://github.com/Ircama/walkplay',
				'https://szttgk.com/uploads/files/20240725/51fad44bb79a05a35046af38b0017de5.pdf',
				'https://szttgk.com/en/product/HIFIhighfidelityaudiomodule/815.html',
				'https://github.com/marco-jardim/open-auri/blob/main/docs/protocol-0xcb.md'
			]);
			const index = buildSearchIndex(content);
			expect(searchSections(index, 'CB1100AU').map((result) => result.id)).toEqual([
				'protocolo-cabo'
			]);
		});
		test('search indexes every section, glossary, credits and exact threshold values locally', () => {
			const index = buildSearchIndex(content);
			expect(index).toHaveLength(content.sections.length);
			expect(searchSections(index, 'CRC').map((result) => result.id)).toContain('protocolo');
			expect(searchSections(index, 'Q23').map((result) => result.id)).toContain('glossario');
			expect(
				searchSections(index, exactNumber(THRESHOLDS.poleRadius, locale)).map((result) => result.id)
			).toEqual(['envelope']);
			expect(searchSections(index, 'Nyquist').map((result) => result.id)).toContain('creditos');
			expect(searchSections(index, 'Basshead').map((result) => result.id)).toContain(
				'pagina-oficial'
			);
			expect(searchSections(index, 'not-a-real-term')).toEqual([]);
			expect(searchSections(index, '   ')).toEqual(index);
			if (locale === 'pt-BR')
				expect(searchSections(index, 'MEMORIA').map((result) => result.id)).toContain('memoria');
		});
	});
}

test('mandatory Portuguese notice is literal and all honorees have sources', () => {
	expect(legalNotice['pt-BR'][0]).toBe(
		'open-auri não é oficial nem endossado pela Kuba, pela TTGK, pela Savitech ou por qualquer fabricante. Tudo aqui foi obtido por estudo do protocolo para fins de interoperabilidade. Use por sua conta e risco: não nos responsabilizamos por danos ao cabo, ao fone ou à sua audição.'
	);
	for (const name of [
		'Moog',
		'Emerick',
		'Les Paul',
		'Hildebrand',
		'Clearmountain',
		'Toole',
		'Olive',
		'Dolby',
		'Nyquist'
	])
		expect(
			creditSources.some(
				(source) => source.label.includes(name) && source.href.startsWith('https://')
			)
		).toBe(true);
});

test('TOC uses the last heading above the sticky chrome and the last section at document end', () => {
	const positions = [
		{ id: 'first', top: -400 },
		{ id: 'second', top: 120 },
		{ id: 'last', top: 900 }
	];
	expect(activeSection(positions, 100)).toBe('first');
	expect(activeSection(positions, 120)).toBe('second');
	expect(activeSection(positions, 150, true)).toBe('last');
	expect(activeSection([{ id: 'first', top: 500 }], 150)).toBe('first');
	expect(activeSection([], 150)).toBe('');
});

test('Ctrl/Command+K shortcuts ignore composition, repeats, Alt and consumed events', () => {
	const base = {
		key: 'k',
		ctrlKey: true,
		metaKey: false,
		altKey: false,
		repeat: false,
		isComposing: false,
		defaultPrevented: false
	};
	expect(isSearchShortcut(base)).toBe(true);
	expect(isSearchShortcut({ ...base, key: 'K', ctrlKey: false, metaKey: true })).toBe(true);
	for (const patch of [
		{ ctrlKey: false },
		{ altKey: true },
		{ repeat: true },
		{ isComposing: true },
		{ defaultPrevented: true },
		{ key: 'a' }
	])
		expect(isSearchShortcut({ ...base, ...patch })).toBe(false);
});
