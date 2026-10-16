import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	FRAME_ANCESTORS_POLICY,
	HSTS,
	NON_HTML_CSP,
	PERMISSIONS_POLICY,
	renderStaticHeadersFile,
	securityHeaders
} from '#lib/server/security/headers.ts';

// adapter-cloudflare reads _headers from the project root (web/), not from static/.
const STATIC_HEADERS = fileURLToPath(new URL('../../../../_headers', import.meta.url));

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
		for (const off of ['camera', 'microphone', 'geolocation', 'usb', 'serial', 'payment']) {
			expect(directives).toContain(`${off}=()`);
		}
		expect(new Set(directives.map((d) => d.split('=')[0])).size).toBe(directives.length);
	});

	it('renders web/_headers for static assets with framing denied', () => {
		const file = renderStaticHeadersFile();
		expect(file.split('\n')).toContain('/*');
		expect(file).toContain('  x-frame-options: DENY');
		expect(file).toContain(`  content-security-policy: ${FRAME_ANCESTORS_POLICY}`);
		expect(file).toContain(`  strict-transport-security: ${HSTS}`);
		expect(file).toContain(`  permissions-policy: ${PERMISSIONS_POLICY}`);
		for (const line of file.split('\n')) expect(line.length).toBeLessThanOrEqual(2000);
	});

	it.skipIf(!existsSync(STATIC_HEADERS))('web/_headers matches renderStaticHeadersFile()', () => {
		expect(readFileSync(STATIC_HEADERS, 'utf8').replaceAll('\r\n', '\n')).toBe(
			renderStaticHeadersFile()
		);
	});
});
