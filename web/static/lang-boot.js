/*
 * Locale boot (FX2.3/I1). Loaded from <head> with a blocking <script src> because the CSP is
 * `script-src 'self'` (no inline scripts). Pages are prerendered in the base locale (pt-BR);
 * Paraglide resolves the client locale with the strategy in web/project.inlang/paraglide.config.mjs
 * (cookie, localStorage, preferredLanguage, baseLocale). When that resolution differs from the
 * prerendered `lang`, the document stays hidden until the root layout hydrates in the resolved
 * locale and calls `revealLocale` (#lib/components/chrome/lang-boot.ts). A timeout reveals the page
 * anyway if hydration never happens. Keep the constants below in sync with the Paraglide config.
 */
(() => {
	const LOCALES = ['pt-BR', 'en-US'];
	const BASE_LOCALE = 'pt-BR';
	const COOKIE_NAME = 'oa_lang';
	const STORAGE_KEY = 'oa.lang';
	const ATTRIBUTE = 'data-lang-boot';
	const FALLBACK_MS = 3000;
	const root = document.documentElement;

	/** Same matching as Paraglide's toLocale: exact tag, case-insensitive. */
	const toLocale = (value) => {
		if (typeof value !== 'string') return undefined;
		const lower = value.toLowerCase();
		return LOCALES.find((locale) => locale.toLowerCase() === lower);
	};
	const fromCookie = () => {
		for (const part of document.cookie.split(';')) {
			const [name, ...rest] = part.trim().split('=');
			if (name === COOKIE_NAME) return rest.join('=');
		}
		return undefined;
	};
	const fromStorage = () => {
		try {
			return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
		} catch {
			// Storage access can be denied (like Paraglide, fall through to the next strategy).
			return undefined;
		}
	};
	/** Same negotiation as Paraglide's extractLocaleFromNavigator: full tag, then base tag. */
	const fromNavigator = () => {
		for (const tag of navigator.languages ?? []) {
			const locale = toLocale(tag) ?? toLocale(tag.split('-')[0]);
			if (locale) return locale;
		}
		return undefined;
	};

	const resolved =
		toLocale(fromCookie()) ?? toLocale(fromStorage()) ?? fromNavigator() ?? BASE_LOCALE;
	if (resolved === toLocale(root.lang)) return;

	// CSSOM writes are allowed under the CSP; no <style> element or style attribute is parsed.
	root.setAttribute(ATTRIBUTE, resolved);
	root.style.visibility = 'hidden';
	setTimeout(() => {
		if (!root.hasAttribute(ATTRIBUTE)) return;
		root.removeAttribute(ATTRIBUTE);
		root.style.removeProperty('visibility');
	}, FALLBACK_MS);
})();
