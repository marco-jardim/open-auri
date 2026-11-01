// T2.5 · The "App Android" chapters of /docs (docs/plans/2026-10-18-android-capacitor-plano.md,
// T2.5 and Anexo G): the same anchors in both languages, including the recovery anchor the cable
// page links to; the Anexo G.6 validation state in one delimited place, never the retired G.1
// notice; every topic of the plan; no U+2014; only well-formed https links.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ANDROID_PLAY_URL } from '#lib/cable/android-links.ts';
import { buildSearchIndex, searchSections } from '#lib/components/pages/docs/search.ts';
import { docsContent as sourceContent } from '#lib/content/docs/index.ts';
import type { DocSection, DocsLocale } from '#lib/content/docs/types.ts';

const web = new URL('../../../', import.meta.url);
const plan = readFileSync(
	new URL('../docs/plans/2026-10-18-android-capacitor-plano.md', web),
	'utf8'
).replace(/\r\n/g, '\n');
const sources: Record<DocsLocale, string> = {
	'pt-BR': readFileSync(new URL('src/lib/content/docs/pt-BR.ts', web), 'utf8'),
	'en-US': readFileSync(new URL('src/lib/content/docs/en-US.ts', web), 'utf8')
};
const locales = ['pt-BR', 'en-US'] as const;
const docsContent = (locale: DocsLocale, inApp = false) => sourceContent(locale, inApp);

/** Anchors of the Android chapters, in page order, identical in both languages. */
const ANDROID_ANCHORS = [
	'android',
	'android-validacao',
	'android-resgate',
	'android-usb',
	'android-diagnostico',
	'android-iphone',
	'android-assinatura',
	'android-privacidade'
];
/** Public anchor `/docs#android-resgate`; no UI links to it any more, but it stays stable. */
const RECOVERY_ANCHOR = 'android-resgate';
const VALIDATION_ANCHOR = 'android-validacao';
const REPORT_URL =
	'https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml';
const RELEASES_URL = 'https://github.com/marco-jardim/open-auri/releases/latest';
const HARDWARE_REPORT_URL =
	'https://github.com/marco-jardim/open-auri/blob/main/docs/android/validacao-hardware.md';

const isAndroid = (section: DocSection) =>
	section.id === 'android' || section.id.startsWith('android-');
const androidSections = (locale: DocsLocale) => docsContent(locale).sections.filter(isAndroid);
const section = (locale: DocsLocale, id: string) =>
	docsContent(locale).sections.find((entry) => entry.id === id)!;
const sectionText = (entry: DocSection) =>
	[entry.title, ...entry.paragraphs, ...(entry.items ?? [])].join('\n');

/** The plan block of one Anexo G item, from its bold heading to the next one. */
function annex(heading: string) {
	const start = plan.indexOf(`**${heading}**`);
	expect(start, heading).toBeGreaterThan(-1);
	const end = plan.indexOf('\n**', start + heading.length + 4);
	return plan.slice(start, end === -1 ? undefined : end);
}

/** The retired Anexo G.1 title and text (historical plan), which the docs must never carry. */
function g1(locale: DocsLocale): { title: string; text: string } {
	const block = annex(`G.1 Modal e banner (${locale})`);
	const title = /^- \*\*Título:\*\* "([^"]+)"$/m.exec(block)?.[1];
	const text = /^- \*\*Texto:\*\* "([^"]+)"$/m.exec(block)?.[1];
	if (title === undefined || text === undefined) throw new Error(`Missing G.1 (${locale})`);
	return { title, text };
}

test('the retired G.1 notice is absent from the docs content and its sources', () => {
	for (const locale of locales) {
		const { title, text } = g1(locale);
		const everything = JSON.stringify(docsContent(locale));
		for (const value of [title, text]) {
			expect(everything).not.toContain(value);
			expect(sources[locale]).not.toContain(value);
		}
	}
	// The report link is the one Anexo G.5 publishes with every release.
	const g5 = annex('G.5 Notas da release, README e ficha da Play')
		.split('\n')
		.slice(1)
		.filter((line) => line.trim() !== '');
	expect(g5).toHaveLength(2);
	for (const line of g5) expect(line).toContain(REPORT_URL);
});

test('both languages have the same Android anchors, contiguous, unique and fragment-safe', () => {
	for (const locale of locales) {
		const ids = docsContent(locale).sections.map((entry) => entry.id);
		expect(new Set(ids).size, locale).toBe(ids.length);
		expect(androidSections(locale).map((entry) => entry.id)).toEqual(ANDROID_ANCHORS);
		const first = ids.indexOf(ANDROID_ANCHORS[0]);
		expect(ids.slice(first, first + ANDROID_ANCHORS.length)).toEqual(ANDROID_ANCHORS);
		for (const entry of androidSections(locale)) {
			expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
			expect(entry.title.trim(), entry.id).not.toBe('');
			expect(entry.paragraphs.length, entry.id).toBeGreaterThan(0);
		}
	}
	expect(ANDROID_ANCHORS).toContain(RECOVERY_ANCHOR);
	// Same shape in both languages: paragraphs, items and link targets per chapter.
	const shape = (locale: DocsLocale) =>
		androidSections(locale).map((entry) => ({
			id: entry.id,
			paragraphs: entry.paragraphs.length,
			items: entry.items?.length ?? 0,
			links: entry.links?.map((link) => link.href) ?? []
		}));
	expect(shape('en-US')).toEqual(shape('pt-BR'));
});

for (const locale of locales) {
	describe(locale, () => {
		const en = locale === 'en-US';
		test('app projection keeps anchors but never offers a GitHub APK or switching sources', () => {
			const app = docsContent(locale, true);
			expect(app.sections.map((entry) => entry.id)).toEqual(
				docsContent(locale).sections.map((entry) => entry.id)
			);
			expect(
				app.sections
					.flatMap((entry) => entry.links ?? [])
					.some((link) => link.href === RELEASES_URL)
			).toBe(false);
			expect(
				app.sections.find((entry) => entry.id === 'android')?.links?.map((link) => link.href)
			).toEqual([ANDROID_PLAY_URL]);
			const text = JSON.stringify(app);
			expect(text).not.toContain('GitHub Releases');
			expect(text).not.toContain('apksigner');
			expect(text).not.toContain('without uninstalling');
			expect(text).not.toContain('sem desinstalar');
			expect(searchSections(buildSearchIndex(app), 'apksigner')).toEqual([]);
		});

		test('the validation state is the Anexo G.6 text (date, devices and report)', () => {
			const validation = section(locale, VALIDATION_ANCHOR);
			expect(sectionText(validation)).toMatch(
				en ? /validated on a real cable on / : /validada em cabo real em /
			);
			expect(sectionText(validation)).toContain('docs/android/validacao-hardware.md');
			expect(sectionText(validation)).not.toMatch(
				/não testad|teste em um celular|tested on one phone|untested|validação completa|full validation/i
			);
			expect(validation.links?.map((link) => link.href)).toEqual([REPORT_URL, HARDWARE_REPORT_URL]);
		});

		test('the validation text lives in one delimited block of the content file', () => {
			const source = sources[locale];
			const begin = source.indexOf('// BEGIN Android validation state');
			const end = source.indexOf('// END Android validation state');
			expect(begin).toBeGreaterThan(-1);
			expect(end).toBeGreaterThan(begin);
			expect(source.indexOf('// BEGIN Android validation state', begin + 1)).toBe(-1);
			expect(source.slice(end)).toContain('paragraphs: androidValidationState');
		});

		test('the recovery anchor explains Neutral from the app, then from a computer, and reporting', () => {
			const recovery = section(locale, RECOVERY_ANCHOR);
			const text = sectionText(recovery);
			expect(text).toMatch(en ? /write Neutral from the app/ : /grave o Neutro pelo próprio app/);
			expect(text).toMatch(
				en
					? /write Neutral from the site on a computer with Chrome or Edge/
					: /grave o Neutro pelo site num computador com Chrome ou Edge/
			);
			expect(text).toMatch(en ? /report the result/ : /relate o resultado/);
			expect(recovery.links?.map((link) => link.href)).toEqual([REPORT_URL]);
		});

		test('every topic of the plan is covered', () => {
			const text = (id: string) => sectionText(section(locale, id));
			const app = text('android');
			expect(app).toContain('Google Play');
			expect(app).toContain('GitHub Releases');
			expect(app).toMatch(en ? /Android 8 or newer/ : /Android 8 ou mais novo/);
			expect(app).toContain('USB host (OTG)');
			expect(app).toContain('Android System WebView');
			expect(section(locale, 'android').links?.map((link) => link.href)).toEqual([RELEASES_URL]);

			const usb = text('android-usb');
			expect(usb).toMatch(en ? /Android asks whether open-auri may access/ : /o Android pergunta/);
			expect(usb).toMatch(
				en
					? /the same gate v2, the same checklist and the same journal as the site/
					: /o mesmo gate v2, o mesmo checklist e o mesmo diário do site/
			);
			expect(usb).toMatch(
				en ? /What changes: only the final stretch/ : /O que muda: só o trecho final/
			);

			const diagnostics = text('android-diagnostico');
			expect(diagnostics).toMatch(en ? /Engineering layer/ : /camada Engenharia/);
			expect(diagnostics).toMatch(en ? /only in the app/ : /só existe no app/);
			expect(diagnostics).toContain('JSON');
			expect(diagnostics).toMatch(
				en ? /Nothing is sent to the server/ : /Nada é enviado ao servidor/
			);

			const iphone = text('android-iphone');
			for (const term of ['CoreHID', 'macOS 15', 'External Accessory', 'MFi', 'USBDriverKit'])
				expect(iphone).toContain(term);
			expect(iphone).toMatch(en ? /iPads with an M-series chip/ : /iPad com chip da série M/);
			expect(iphone).toContain('entitlement');

			const signature = text('android-assinatura');
			for (const term of ['SHA-256', 'fingerprint', 'SHA256SUMS.txt', 'Google Play', 'GitHub'])
				expect(signature).toContain(term);
			expect(signature).toMatch(en ? /the same for both sources/ : /o mesmo nas duas fontes/);

			expect(text('android-privacidade')).toMatch(
				en
					? /collects nothing beyond what the site already collects/
					: /não coleta nada além do que o site já coleta/
			);
		});

		test('no U+2014 anywhere in the content file or the content', () => {
			expect(sources[locale]).not.toContain('\u2014');
			expect(JSON.stringify(docsContent(locale))).not.toContain('\u2014');
		});

		test('every Android link and URL is https and well formed', () => {
			for (const entry of androidSections(locale)) {
				const hrefs = entry.links?.map((link) => link.href) ?? [];
				expect(new Set(hrefs).size, entry.id).toBe(hrefs.length);
				const inText = sectionText(entry).match(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi) ?? [];
				for (const href of [...hrefs, ...inText]) {
					const url = new URL(href);
					expect(url.protocol, href).toBe('https:');
					expect(url.href, href).toBe(href);
					expect(url.username + url.password, href).toBe('');
					expect(url.hostname, href).toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/);
				}
				for (const link of entry.links ?? []) expect(link.label.trim(), link.href).not.toBe('');
			}
			const all = androidSections(locale).flatMap((entry) => entry.links ?? []);
			expect(new Set(all.map((link) => link.href))).toEqual(
				new Set([RELEASES_URL, REPORT_URL, HARDWARE_REPORT_URL])
			);
		});

		test('search finds the Android chapters', () => {
			const index = buildSearchIndex(docsContent(locale));
			expect(searchSections(index, 'USBDriverKit').map((result) => result.id)).toEqual([
				'android-iphone'
			]);
			expect(searchSections(index, 'SHA256SUMS').map((result) => result.id)).toContain(
				'android-assinatura'
			);
		});
	});
}
