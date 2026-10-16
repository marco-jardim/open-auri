import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
	readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const script = read('../../../static/lang-boot.js');
const config = read('../../../project.inlang/paraglide.config.mjs');
const appHtml = read('../../../src/app.html');

interface Boot {
	cookie?: string;
	stored?: string | null;
	storageThrows?: boolean;
	languages?: string[];
	lang?: string;
}

function boot({
	cookie = '',
	stored = null,
	storageThrows = false,
	languages = [],
	lang = 'pt-BR'
}: Boot) {
	const attributes = new Map<string, string>();
	const style = new Map<string, string>();
	const timers: (() => void)[] = [];
	const root = {
		lang,
		setAttribute(name: string, value: string) {
			attributes.set(name, value);
		},
		removeAttribute(name: string) {
			attributes.delete(name);
		},
		hasAttribute(name: string) {
			return attributes.has(name);
		},
		style: {
			set visibility(value: string) {
				style.set('visibility', value);
			},
			get visibility() {
				return style.get('visibility') ?? '';
			},
			removeProperty(name: string) {
				style.delete(name);
			}
		}
	};
	const localStorage = {
		getItem(key: string) {
			if (storageThrows) throw new Error('SecurityError');
			return key === 'oa.lang' ? stored : null;
		}
	};
	runInNewContext(script, {
		document: { cookie, documentElement: root },
		navigator: { languages },
		window: { localStorage },
		setTimeout: (callback: () => void) => {
			timers.push(callback);
			return timers.length;
		}
	});
	return {
		root,
		pending: () => attributes.get('data-lang-boot') ?? null,
		hidden: () => style.get('visibility') === 'hidden',
		fireTimers: () => {
			for (const timer of timers.splice(0)) timer();
		}
	};
}

describe('lang-boot.js (FX2.3/I1)', () => {
	it('mirrors the Paraglide strategy, cookie name and storage key', () => {
		// Plan §3.5 keeps auto-detection, so the boot script must resolve exactly like Paraglide.
		expect(config).toContain(
			"strategy: ['cookie', 'localStorage', 'preferredLanguage', 'baseLocale']"
		);
		expect(config).toContain("cookieName: 'oa_lang'");
		expect(config).toContain("localStorageKey: 'oa.lang'");
		expect(script).toContain("COOKIE_NAME = 'oa_lang'");
		expect(script).toContain("STORAGE_KEY = 'oa.lang'");
		expect(script).toContain("BASE_LOCALE = 'pt-BR'");
	});

	it('is loaded as a blocking external script (CSP script-src self, no inline code)', () => {
		const head = appHtml.slice(0, appHtml.indexOf('%sveltekit.head%'));
		expect(head).toContain('<script src="%sveltekit.assets%/lang-boot.js"></script>');
		expect(appHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
		expect(head).not.toMatch(/lang-boot\.js"[^>]*\b(async|defer|type="module")/);
	});

	it('leaves a pt-BR visitor on prerendered pt-BR untouched (no hide, no flash)', () => {
		for (const setup of [
			{},
			{ languages: ['pt-BR', 'en-US'] },
			{ languages: ['pt'] },
			{ languages: ['en-GB'] },
			{ cookie: 'oa_lang=pt-BR', languages: ['en-US'] },
			{ stored: 'pt-BR', languages: ['en-US'] }
		]) {
			const result = boot(setup);
			expect(result.pending(), JSON.stringify(setup)).toBeNull();
			expect(result.hidden()).toBe(false);
		}
	});

	it('hides the base-locale document until hydration when the visitor resolves to en-US', () => {
		for (const setup of [
			{ languages: ['en-US', 'pt-BR'] },
			{ languages: ['en-us'] },
			{ cookie: 'theme=dark; oa_lang=en-US', languages: ['pt-BR'] },
			{ stored: 'en-US', languages: ['pt-BR'] },
			{ storageThrows: true, languages: ['en-US'] }
		]) {
			const result = boot(setup);
			expect(result.pending(), JSON.stringify(setup)).toBe('en-US');
			expect(result.hidden()).toBe(true);
			// The boot script never rewrites lang itself; the layout does after hydration.
			expect(result.root.lang).toBe('pt-BR');
		}
	});

	it('gives the cookie priority over localStorage and both over the browser', () => {
		expect(boot({ cookie: 'oa_lang=en-US', stored: 'pt-BR' }).pending()).toBe('en-US');
		expect(boot({ stored: 'en-US', languages: ['pt-BR'] }).pending()).toBe('en-US');
		expect(boot({ cookie: 'oa_lang=xx', stored: 'en-US' }).pending()).toBe('en-US');
	});

	it('does nothing when SSR already rendered the resolved locale', () => {
		const result = boot({ lang: 'en-US', languages: ['en-US'] });
		expect(result.pending()).toBeNull();
		expect(result.hidden()).toBe(false);
	});

	it('reveals the page after the fallback timeout if hydration never happens', () => {
		const result = boot({ languages: ['en-US'] });
		expect(result.hidden()).toBe(true);
		result.fireTimers();
		expect(result.pending()).toBeNull();
		expect(result.hidden()).toBe(false);
	});
});
