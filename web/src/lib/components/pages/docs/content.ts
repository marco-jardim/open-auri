import type { DocsContent, DocsLocale } from '#lib/content/docs/types.ts';

/**
 * L7: the Docs prose is bilingual and large. Each locale is its own dynamic chunk, so the
 * page's initial JS carries only the active locale. Never import `docsContent` from
 * `#lib/content/docs/index.ts` in the route closure: it pulls both locales back in.
 */
export async function loadDocsContent(locale: DocsLocale): Promise<DocsContent> {
	if (locale === 'en-US') return (await import('#lib/content/docs/en-US.ts')).enUS;
	return (await import('#lib/content/docs/pt-BR.ts')).ptBR;
}
