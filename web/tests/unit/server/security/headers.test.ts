import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_BEACON_HOST, ANALYTICS_SCRIPT_HOST } from '#lib/server/analytics.ts';
import {
	FRAME_ANCESTORS_POLICY,
	HSTS,
	NON_HTML_CSP,
	PERMISSIONS_POLICY,
	renderCsp,
	renderStaticHeadersFile,
	securityHeaders,
	withNoTransform,
	STATIC_DOCUMENT_CSP,
	STATIC_DOCUMENT_CSP_DIRECTIVES
} from '#lib/server/security/headers.ts';

// adapter-cloudflare reads _headers from the project root (web/), not from static/.
const STATIC_HEADERS = fileURLToPath(new URL('../../../../_headers', import.meta.url));
const VITE_CONFIG = fileURLToPath(new URL('../../../../vite.config.ts', import.meta.url));

/**
 * The `csp.directives` object of vite.config.ts, read as text (importing the config would start
 * the SvelteKit and Paraglide plugins). Each entry is one line `'name': ['a', 'b'],`.
 */
function kitDirectives(): Map<string, string[]> {
	const source = readFileSync(VITE_CONFIG, 'utf8');
	const block = /\bcsp:\s*\{[\s\S]*?directives:\s*\{([\s\S]*?)\n\t*\}/.exec(source)?.[1] ?? '';
	const directives = new Map<string, string[]>();
	for (const match of block.matchAll(/'([a-z-]+)':\s*\[([^\]]*)\]/g)) {
		const sources = [...(match[2] ?? '').matchAll(/'([^']*)'/g)].map((value) => value[1] ?? '');
		directives.set(match[1] ?? '', sources);
	}
	return directives;
}

describe('document CSP (T5.4, vite.config.ts)', () => {
	const directives = kitDirectives();

	it('is parsed from vite.config.ts', () => {
		expect(directives.size).toBeGreaterThanOrEqual(10);
		expect(/\bmode:\s*'auto'/.test(readFileSync(VITE_CONFIG, 'utf8'))).toBe(true);
	});

	it('never allows inline or eval scripts, and allows inline styles only as attributes', () => {
		for (const [name, sources] of directives) {
			expect(sources, name).not.toContain('unsafe-eval');
			if (name !== 'style-src-attr') expect(sources, name).not.toContain('unsafe-inline');
		}
		expect(directives.get('style-src-attr')).toEqual(['unsafe-inline']);
		expect(directives.get('style-src')).toEqual(['self']);
		expect(directives.get('script-src')).toEqual([
			'self',
			'https://challenges.cloudflare.com',
			'https://scripts.simpleanalyticscdn.com'
		]);
	});

	it('defaults to none, denies plugins, framing and foreign bases, and keeps workers same-origin', () => {
		expect(directives.get('default-src')).toEqual(['none']);
		expect(directives.get('object-src')).toEqual(['none']);
		expect(directives.get('frame-ancestors')).toEqual(['none']);
		expect(directives.get('base-uri')).toEqual(['self']);
		expect(directives.get('worker-src')).toEqual(['self']);
		expect(directives.get('connect-src')).toEqual(['self', 'https://queue.simpleanalyticscdn.com']);
		expect(directives.get('frame-src')).toEqual(['https://challenges.cloudflare.com']);
	});

	it('allows Simple Analytics: its script host for scripts, its beacon host for beacons only', () => {
		expect(ANALYTICS_SCRIPT_HOST).toBe('https://scripts.simpleanalyticscdn.com');
		expect(ANALYTICS_BEACON_HOST).toBe('https://queue.simpleanalyticscdn.com');
		expect(directives.get('script-src')).toContain(ANALYTICS_SCRIPT_HOST);
		expect(directives.get('connect-src')).toContain(ANALYTICS_BEACON_HOST);
		expect(directives.get('img-src')).toEqual(['self', 'data:', 'blob:', ANALYTICS_BEACON_HOST]);
		// No other directive names the provider (no frames, workers, styles or fonts from it).
		for (const [name, sources] of directives) {
			if (name !== 'script-src') expect(sources, name).not.toContain(ANALYTICS_SCRIPT_HOST);
			if (name !== 'connect-src' && name !== 'img-src') {
				expect(sources, name).not.toContain(ANALYTICS_BEACON_HOST);
			}
		}
		// Every enforced policy must allow the beacons: web/_headers repeats both directives.
		expect(STATIC_DOCUMENT_CSP).toContain(`img-src 'self' data: blob: ${ANALYTICS_BEACON_HOST};`);
		expect(STATIC_DOCUMENT_CSP).toContain(`connect-src 'self' ${ANALYTICS_BEACON_HOST};`);
		expect(STATIC_DOCUMENT_CSP).not.toContain(ANALYTICS_SCRIPT_HOST);
		expect(STATIC_DOCUMENT_CSP).not.toContain('unsafe-inline');
	});

	it('repeats every hash-independent directive in the web/_headers policy', () => {
		const hashBearing = new Set(['default-src', 'script-src', 'style-src', 'style-src-attr']);
		const expected = [...directives].filter(([name]) => !hashBearing.has(name));
		expect(new Map(STATIC_DOCUMENT_CSP_DIRECTIVES.map(([n, s]) => [n, [...s]]))).toEqual(
			new Map(expected)
		);
		for (const name of hashBearing) expect(STATIC_DOCUMENT_CSP).not.toContain(`${name} `);
		expect(STATIC_DOCUMENT_CSP.startsWith(FRAME_ANCESTORS_POLICY)).toBe(true);
	});

	it('renders Kit-style sources with quoted keywords', () => {
		expect(
			renderCsp([
				['img-src', ['self', 'data:']],
				['object-src', ['none']]
			])
		).toBe("img-src 'self' data:; object-src 'none'");
	});
});

describe('securityHeaders (plan §3.8)', () => {
	it('returns the full set for HTML on an https origin, leaving the CSP to SvelteKit', () => {
		expect(securityHeaders({ origin: 'https://auri.example', isHtml: true })).toEqual({
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'strict-origin-when-cross-origin',
			'permissions-policy': PERMISSIONS_POLICY,
			'cross-origin-opener-policy': 'same-origin',
			'cross-origin-resource-policy': 'same-origin',
			'x-frame-options': 'DENY',
			'strict-transport-security': HSTS
		});
	});

	it('adds a locked-down CSP for non-HTML and skips HSTS on http', () => {
		const headers = securityHeaders({ origin: 'http://localhost:5173', isHtml: false });
		expect(headers['content-security-policy']).toBe(NON_HTML_CSP);
		expect(headers['strict-transport-security']).toBeUndefined();
	});

	it('uses HSTS of at least one year with subdomains', () => {
		const maxAge = Number(/max-age=(\d+)/.exec(HSTS)?.[1]);
		expect(maxAge).toBeGreaterThanOrEqual(31_536_000);
		expect(HSTS).toContain('includeSubDomains');
	});

	it('allows WebHID for the page itself and turns sensors, camera and microphone off', () => {
		const directives = PERMISSIONS_POLICY.split(', ');
		expect(directives).toContain('hid=(self)');
		const off = ['camera', 'microphone', 'geolocation', 'usb', 'serial', 'payment', 'bluetooth'];
		for (const feature of [...off, 'midi', 'fullscreen', 'publickey-credentials-get']) {
			expect(directives).toContain(`${feature}=()`);
		}
		// Only the features the app uses are granted, and only to its own origin.
		expect(directives.filter((d) => !d.endsWith('=()'))).toEqual([
			'hid=(self)',
			'autoplay=(self)',
			'clipboard-write=(self)'
		]);
		expect(new Set(directives.map((d) => d.split('=')[0])).size).toBe(directives.length);
	});

	it('renders web/_headers for static assets with framing denied', () => {
		const file = renderStaticHeadersFile();
		expect(file.split('\n')).toContain('/*');
		expect(file).toContain('  x-frame-options: DENY');
		expect(file).toContain(`  content-security-policy: ${STATIC_DOCUMENT_CSP}\n`);
		expect(file).toContain(`  strict-transport-security: ${HSTS}`);
		expect(file).toContain('  cross-origin-opener-policy: same-origin');
		expect(file).toContain('  cross-origin-resource-policy: same-origin');
		expect(file).toContain('  x-content-type-options: nosniff');
		expect(file).toContain('  referrer-policy: strict-origin-when-cross-origin');
		expect(file).toContain(`  permissions-policy: ${PERMISSIONS_POLICY}`);
		for (const line of file.split('\n')) expect(line.length).toBeLessThanOrEqual(2000);
	});

	it.skipIf(!existsSync(STATIC_HEADERS))('web/_headers matches renderStaticHeadersFile()', () => {
		expect(readFileSync(STATIC_HEADERS, 'utf8').replaceAll('\r\n', '\n')).toBe(
			renderStaticHeadersFile()
		);
	});
});

describe('withNoTransform', () => {
	const html = (headers: Record<string, string> = {}) =>
		new Response('<!doctype html>', {
			headers: { 'content-type': 'text/html; charset=utf-8', ...headers }
		});

	it('adds no-transform to HTML so Cloudflare injects nothing at the edge', () => {
		expect(withNoTransform(html()).headers.get('cache-control')).toBe('no-transform');
		expect(
			withNoTransform(html({ 'cache-control': 'public, max-age=0, must-revalidate' })).headers.get(
				'cache-control'
			)
		).toBe('public, max-age=0, must-revalidate, no-transform');
		expect(
			withNoTransform(html({ 'cache-control': 'private, no-transform' })).headers.get(
				'cache-control'
			)
		).toBe('private, no-transform');
	});

	it('leaves non-HTML untouched and copies immutable responses', async () => {
		const js = new Response('x', {
			headers: {
				'content-type': 'text/javascript',
				'cache-control': 'public, max-age=31536000, immutable'
			}
		});
		expect(withNoTransform(js).headers.get('cache-control')).toBe(
			'public, max-age=31536000, immutable'
		);
		const frozen = Response.redirect('https://example.org/', 302);
		expect(withNoTransform(frozen)).toBe(frozen);
		const upstream = await fetch('data:text/html,<p>x</p>');
		const result = withNoTransform(upstream);
		expect(result.headers.get('cache-control')).toBe('no-transform');
		expect(await result.text()).toBe('<p>x</p>');
	});
});
