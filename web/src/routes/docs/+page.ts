import { getLocale } from '#lib/paraglide/runtime.js';
import { loadDocsContent } from '#lib/components/pages/docs/content.ts';
import type { PageLoad } from './$types';

export const prerender = true;

/**
 * L7: only the active locale's prose is loaded. A locale switch reloads the page, so the
 * universal load runs again with the new locale (during prerender and in the browser).
 */
export const load: PageLoad = async () => ({ content: await loadDocsContent(getLocale()) });
