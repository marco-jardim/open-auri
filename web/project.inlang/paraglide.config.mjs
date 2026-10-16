/** Paraglide compiler options shared by the Vite plugin and the CLI compile step. */
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
