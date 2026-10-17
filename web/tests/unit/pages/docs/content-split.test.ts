// L7 (spec §5.3): only the active locale's prose belongs to the /docs initial chunk.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { docsContent } from '#lib/content/docs/index.ts';
import { loadDocsContent } from '#lib/components/pages/docs/content.ts';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

test('each locale loads its own prose module', async () => {
	for (const locale of ['pt-BR', 'en-US'] as const) {
		const content = await loadDocsContent(locale);
		expect(content.locale).toBe(locale);
		expect(content).toBe(docsContent(locale));
	}
});

test('the route closure never imports both locales statically', () => {
	const loader = read('../../../../src/lib/components/pages/docs/content.ts');
	expect(loader).toMatch(/import\('#lib\/content\/docs\/en-US\.ts'\)/);
	expect(loader).toMatch(/import\('#lib\/content\/docs\/pt-BR\.ts'\)/);
	expect(loader).not.toMatch(/^import [^(]*content\/docs\/(?:en-US|pt-BR)/m);

	const route = read('../../../../src/routes/docs/+page.ts');
	expect(route).toMatch(/export const prerender = true/);
	expect(route).toMatch(/loadDocsContent\(getLocale\(\)\)/);
	for (const file of [
		'../../../../src/routes/docs/+page.ts',
		'../../../../src/routes/docs/+page.svelte',
		'../../../../src/lib/components/pages/docs/DocsPage.svelte',
		'../../../../src/lib/components/pages/docs/SearchDialog.svelte',
		'../../../../src/lib/components/pages/docs/ProtocolWidgets.svelte',
		'../../../../src/lib/components/pages/docs/search.ts'
	]) {
		const source = read(file);
		expect(source, file).not.toMatch(/\bdocsContent\b/);
		expect(source, file).not.toMatch(/from '#lib\/content\/docs\/(?:en-US|pt-BR)\.ts'/);
	}
});

test('the Docs page imports no Fontsource package (fonts.css is the single source)', () => {
	for (const file of [
		'../../../../src/routes/docs/+page.svelte',
		'../../../../src/routes/privacidade/+page.svelte',
		'../../../../src/routes/termos/+page.svelte',
		'../../../../src/lib/components/pages/docs/DocsPage.svelte',
		'../../../../src/lib/components/pages/docs/LegalPage.svelte',
		'../../../../src/lib/components/pages/docs/ProtocolWidgets.svelte',
		'../../../../src/lib/components/pages/docs/SearchDialog.svelte'
	])
		expect(read(file), file).not.toMatch(/@fontsource\//);
});

test('legal pages take their typography from the tokens and a readable measure', () => {
	const source = read('../../../../src/lib/components/pages/docs/LegalPage.svelte');
	expect(source).toMatch(/--legal-measure:\s*68ch/);
	expect(source).toMatch(/var\(--fs-body\)\s*\/\s*var\(--lh-body\)/);
	expect(source).toMatch(/var\(--fs-display-m\)/);
	expect(source).toMatch(/var\(--fs-lede\)/);
	expect(source).not.toMatch(/\b\d+px\/\d/);
});
