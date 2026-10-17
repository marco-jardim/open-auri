import { m } from '#lib/paraglide/messages.js';

/**
 * The five labels LegalPage prints (navigation and version line). The legal routes import this
 * instead of `docsUi()`, whose ~50 Docs messages (both locales) are not needed there (FUX.B).
 * `DocsUi` is a superset, so Docs and its tests can keep passing `docsUi()`.
 */
export function legalUi() {
	return {
		contents: m.docs_contents(),
		back: m.docs_back(),
		privacy: m.docs_privacy(),
		terms: m.docs_terms(),
		version: m.docs_version()
	};
}
export type LegalUi = ReturnType<typeof legalUi>;
