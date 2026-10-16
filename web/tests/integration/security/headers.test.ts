import { describe, expect, it } from 'vitest';
import {
	applySecurityHeaders,
	FRAME_ANCESTORS_POLICY,
	HSTS,
	NON_HTML_CSP,
	PERMISSIONS_POLICY
} from '#lib/server/security/headers.ts';

const ORIGIN = 'https://auri.example';
const KIT_CSP = "default-src 'self'; script-src 'self' 'nonce-abc'";

function expectBaseline(headers: Headers) {
	expect(headers.get('x-content-type-options')).toBe('nosniff');
	expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
	expect(headers.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
	expect(headers.get('permissions-policy')).toContain('hid=(self)');
	expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
	expect(headers.get('cross-origin-resource-policy')).toBe('same-origin');
	expect(headers.get('x-frame-options')).toBe('DENY');
	expect(headers.get('strict-transport-security')).toBe(HSTS);
}

describe('applySecurityHeaders on Worker responses', () => {
	it('keeps the SvelteKit CSP of an HTML page and adds frame-ancestors as a separate policy', () => {
		const page = new Response('<!doctype html>', {
			headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': KIT_CSP }
		});
		const out = applySecurityHeaders(page, { origin: ORIGIN });
		expectBaseline(out.headers);
		const csp = out.headers.get('content-security-policy') ?? '';
		expect(csp.startsWith(KIT_CSP)).toBe(true);
		expect(csp).toContain(FRAME_ANCESTORS_POLICY);
	});

	it('does not duplicate frame-ancestors already present in the Kit policy', () => {
		const policy = `${KIT_CSP}; frame-ancestors 'none'`;
		const page = new Response('', {
			headers: { 'content-type': 'text/html', 'content-security-policy': policy }
		});
		const out = applySecurityHeaders(page, { origin: ORIGIN });
		expect(out.headers.get('content-security-policy')).toBe(policy);
	});

	it('locks down JSON and other non-HTML responses', () => {
		const json = Response.json({ ok: true });
		const out = applySecurityHeaders(json, { origin: ORIGIN });
		expectBaseline(out.headers);
		expect(out.headers.get('content-security-policy')).toBe(NON_HTML_CSP);
	});

	it('never puts a CSP on JavaScript (worker scripts inherit it)', () => {
		const script = new Response('self.onmessage = null', {
			headers: { 'content-type': 'text/javascript' }
		});
		const out = applySecurityHeaders(script, { origin: ORIGIN });
		expect(out.headers.has('content-security-policy')).toBe(false);
		expect(out.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('lets a route override CORP (e.g. an OG image meant to be embedded)', () => {
		const og = new Response('png', {
			headers: { 'content-type': 'image/png', 'cross-origin-resource-policy': 'cross-origin' }
		});
		const out = applySecurityHeaders(og, { origin: ORIGIN });
		expect(out.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
		expect(out.headers.get('content-security-policy')).toBe(NON_HTML_CSP);
	});

	it('omits HSTS on a plain-http origin (local development)', () => {
		const out = applySecurityHeaders(new Response('x'), { origin: 'http://localhost:5173' });
		expect(out.headers.has('strict-transport-security')).toBe(false);
		expect(out.headers.get('x-frame-options')).toBe('DENY');
	});

	it('returns a copy when the headers are immutable', () => {
		const frozen = Response.redirect('https://auri.example/', 302);
		const out = applySecurityHeaders(frozen, { origin: ORIGIN });
		expect(out.status).toBe(302);
		expect(out.headers.get('location')).toBe('https://auri.example/');
		expect(out.headers.get('x-frame-options')).toBe('DENY');
	});
});
