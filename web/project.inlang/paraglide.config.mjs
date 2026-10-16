/**
 * Paraglide compiler options shared by the Vite plugin and the CLI compile step.
 * Plan §3.5 fixes this strategy (auto-detection included). web/static/lang-boot.js mirrors the
 * strategy, cookie name and localStorage key to avoid a locale flash on prerendered pages; keep
 * both in sync.
 */
/** @type {Omit<Partial<import('@inlang/paraglide-js').CompilerOptions>, 'project' | 'outdir'>} */
const options = {
	strategy: ['cookie', 'localStorage', 'preferredLanguage', 'baseLocale'],
	cookieName: 'oa_lang',
	localStorageKey: 'oa.lang',
	cookieSameSite: 'lax',
	cookieSecure: 'auto',
	emitTsDeclarations: true
};

export default options;
