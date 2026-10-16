import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
	HOMAGE_ROUTES,
	PAGE_META,
	getFooterHonoree,
	getPageMeta
} from '../../../src/lib/page-meta.ts';

function messages(locale: string): Record<string, string> {
	const staging = new URL(`../../../messages/_staging/T2.9.${locale}.json`, import.meta.url);
	const merged = new URL(`../../../messages/${locale}.json`, import.meta.url);
	return JSON.parse(readFileSync(existsSync(staging) ? staging : merged, 'utf8')) as Record<
		string,
		string
	>;
}

const pt = messages('pt-BR');
const en = messages('en-US');
const routes = [
	'/',
	'/biblioteca',
	'/comparar',
	'/soe-como-x',
	'/comunidade',
	'/teste-cego',
	'/cabo',
	'/docs',
	'/privacidade',
	'/termos',
	'/c/[id]',
	'/u/[apelido]',
	'/entrar',
	'/criar-conta',
	'/verificar-email',
	'/esqueci-senha',
	'/redefinir-senha',
	'/conta',
	'/conta/**',
	'/admin',
	'/admin/**'
];

describe('route chrome metadata', () => {
	test.each(routes)('%s has a valid page slug and accent', (route) => {
		expect(Object.hasOwn(PAGE_META, route)).toBe(true);
		const meta = getPageMeta(route);
		expect(meta.page).toMatch(/^[a-z][a-z0-9-]*$/);
		expect(meta.accent).toMatch(/^#[\dA-F]{6}$/);
	});

	test.each(HOMAGE_ROUTES)('%s preserves its canonical footer verbatim', (route) => {
		const meta = getPageMeta(route);
		const honoree = meta.honoree;
		expect(honoree).toBeDefined();
		if (!honoree) throw new Error('Missing honoree');
		const mock = readFileSync(
			new URL(`../../../../design/mocks/v2/${meta.page}.html`, import.meta.url),
			'utf8'
		)
			.split('<footer class="site-footer">')[1]
			?.split('</footer>')[0];
		if (!mock) throw new Error('Missing canonical footer');
		const text = (html: string) =>
			html
				.replace(/<[^>]+>/g, '')
				.replace(/\s+/g, ' ')
				.trim();
		const name = mock.match(/<strong>([\s\S]*?)<\/strong>/)?.[1] ?? '';
		const curiosity = mock.match(/<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
		expect(honoree.name).toBe(text(name));
		expect(honoree.years).toBe(mock.match(/\d{4}–(?:\d{4})?/)?.[0] ?? '');
		expect(pt[honoree.curiosity]).toBe(text(curiosity));
		expect(en[honoree.curiosity]?.length).toBeGreaterThan(100);
		const sourceHtml = mock.match(/<div class="sources">([\s\S]*?)<\/div>/)?.[1] ?? '';
		const sources = [...sourceHtml.matchAll(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
		expect(honoree.sources).toHaveLength(sources.length);
		for (const [index, source] of honoree.sources.entries()) {
			expect(source.href).toBe(sources[index]?.[1]);
			expect(source.label).toBe(text(sources[index]?.[2] ?? '').replace(/\s*↗$/, ''));
			expect(pt[source.labelKey]).toBe(source.label);
			expect(en[source.labelKey]).toBeTruthy();
			expect(new URL(source.href).protocol).toBe('https:');
		}
	});

	test('resolves actual dynamic URLs and docs aliases', () => {
		expect(getPageMeta('/c/abc')).toBe(PAGE_META['/biblioteca']);
		expect(getPageMeta('/c/[id]')).toBe(PAGE_META['/biblioteca']);
		expect(getPageMeta('/u/someone')).toBe(PAGE_META['/u/[apelido]']);
		expect(getPageMeta('/conta/seguranca')).toBe(PAGE_META['/conta/**']);
		expect(getPageMeta('/admin/auditoria')).toBe(PAGE_META['/admin/**']);
		expect(getPageMeta('/docs/?section=legal#aviso')).toBe(PAGE_META['/docs']);
		expect(getPageMeta('/privacidade')).toBe(PAGE_META['/docs']);
		expect(getPageMeta('/termos')).toBe(PAGE_META['/docs']);
		expect(getPageMeta('/missing').page).toBe('erro');
	});

	test('keeps future homages absent and neutral, with the permitted Footer fallback', () => {
		for (const route of routes.filter((route) =>
			/conta|senha|entrar|email|admin|^\/u\//.test(route)
		)) {
			const meta = getPageMeta(route);
			expect(meta.accent).toBe('#ECE7DD');
			expect(meta.honoree).toBeUndefined();
			expect(getFooterHonoree(meta)).toBe(PAGE_META['/'].honoree);
		}
	});

	test('staging message sets match in both locales', () => {
		const featureKeys = (catalog: Record<string, string>) =>
			Object.keys(catalog)
				.filter((key) => /^(meta_|layout_)/.test(key))
				.sort();
		expect(featureKeys(pt)).toEqual(featureKeys(en));
		for (const key of featureKeys(pt)) {
			expect(pt[key]?.trim()).toBeTruthy();
			expect(en[key]?.trim()).toBeTruthy();
			expect(pt[key]).not.toContain('—');
		}
	});
});
