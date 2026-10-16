// T3.T cross-cutting checks of the hooks.server.ts steps (that file imports `$app/*`, so its steps
// are driven here through the modules it composes):
//   - the read-only switch (createReadOnlyHandle + KV CONFIG) in front of real handlers;
//   - security headers and CSP added by applySecurityHeaders to responses the real handlers produce.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handleExportRequest } from '#lib/server/account/endpoints.ts';
import { READ_ONLY_CODE, setReadOnly } from '#lib/server/admin/read-only.ts';
import { createReadOnlyHandle, HOOK_ORDER } from '#lib/server/auth/compose.ts';
import { respondToResendWebhook } from '#lib/server/email/webhook.ts';
import { getServerEnv } from '#lib/server/env.ts';
import {
	applySecurityHeaders,
	FRAME_ANCESTORS_POLICY,
	HSTS,
	NON_HTML_CSP,
	PERMISSIONS_POLICY
} from '#lib/server/security/headers.ts';
import { linkOf, uniqueEmail } from '../auth/harness.ts';
import { harness, persona } from './helpers.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

const serverEnv = () => getServerEnv({ env });

afterEach(async () => {
	await setReadOnly(serverEnv(), false, 'phase3-test');
});

describe('read-only switch in front of the real handlers', () => {
	it('runs first in the hook order', () => {
		expect(HOOK_ORDER[0]).toBe('readOnly');
	});

	it('blocks writes outside the allowlist with 503 READ_ONLY before any handler runs', async () => {
		const h = harness(network);
		const handle = createReadOnlyHandle({ building: false, env: getServerEnv });
		const platform = { env, ctx: { waitUntil: () => undefined } };
		const reached: string[] = [];
		const through = (request: Request) =>
			handle({
				event: { request, platform, url: new URL(request.url) } as never,
				resolve: (async () => {
					reached.push(new URL(request.url).pathname);
					return h.auth.handler(request);
				}) as never
			});
		const email = uniqueEmail('readonly-signup');
		const post = (path: string, body: unknown) =>
			new Request(`${h.origin}${path}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: h.origin,
					'cf-connecting-ip': '10.9.9.9',
					'x-turnstile-token': h.turnstileToken(path.replace('/api/auth', '')) ?? ''
				},
				body: JSON.stringify(body)
			});

		await setReadOnly(serverEnv(), true, 'phase3-test');
		const blocked = await through(
			post('/api/auth/sign-up/email', { name: '', email, password: 'a long password 123' })
		);
		expect(blocked.status).toBe(503);
		expect(blocked.headers.get('retry-after')).not.toBeNull();
		expect(((await blocked.json()) as { code: string }).code).toBe(READ_ONLY_CODE);
		expect(reached).toEqual([]);
		const row = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?').bind(email).first();
		expect(row).toBeNull();

		// /conta/exportar only reads (LGPD access right) and stays allowed in read-only (Q3-10).
		const writes = ['/conta', '/conta/politica', '/api/auth/change-password'];
		for (const path of writes) {
			const response = await through(post(path, {}));
			expect(response.status, path).toBe(503);
		}
		// Reads and the allowlist (sign-in, the guarded /admin area) keep working.
		const signIn = await through(
			post('/api/auth/sign-in/email', { email, password: 'a long password 123' })
		);
		expect(signIn.status).not.toBe(503);
		const read = await through(new Request(`${h.origin}/api/auth/get-session`));
		expect(read.status).toBe(200);
		expect(reached).toEqual(['/api/auth/sign-in/email', '/api/auth/get-session']);

		await setReadOnly(serverEnv(), false, 'phase3-test');
		const open = await through(
			post('/api/auth/sign-up/email', { name: '', email, password: 'a long password 123' })
		);
		expect(open.status).toBe(200);
	});

	it('the toggle is audited with the actor', async () => {
		await setReadOnly(serverEnv(), true, 'phase3-audit-actor');
		await setReadOnly(serverEnv(), false, 'phase3-audit-actor');
		const rows = await env.DB.prepare(
			'SELECT action FROM audit_log WHERE actor_id = ? ORDER BY rowid'
		)
			.bind('phase3-audit-actor')
			.all<{ action: string }>();
		expect(rows.results.length).toBeGreaterThanOrEqual(2);
	});
});

function expectBaseline(response: Response, origin: string): void {
	const headers = response.headers;
	expect(headers.get('x-content-type-options')).toBe('nosniff');
	expect(headers.get('x-frame-options')).toBe('DENY');
	expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
	expect(headers.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
	expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
	expect(headers.get('cross-origin-resource-policy')).toBe('same-origin');
	if (new URL(origin).protocol === 'https:') {
		expect(headers.get('strict-transport-security')).toBe(HSTS);
	} else {
		expect(headers.get('strict-transport-security')).toBeNull();
	}
}

describe('security headers and CSP on real responses', () => {
	it('Better Auth JSON, redirects and errors get the baseline and the locked-down CSP', async () => {
		const h = harness(network);
		const origin = serverEnv().publicOrigin;
		const email = uniqueEmail('headers');
		await h.client().signUp(email);
		await h.flush();
		const responses = [
			await h.client().get('/get-session'),
			await h.client().get(linkOf(h.mail(email, 'verify-email'))),
			await h.client().post('/change-password', {}),
			await h.client().post('/sign-in/email', {}, { origin: 'https://evil.example' })
		];
		for (const raw of responses) {
			const response = applySecurityHeaders(raw, { origin });
			expectBaseline(response, origin);
			expect(response.headers.get('content-security-policy')).toBe(NON_HTML_CSP);
		}
	});

	it('the export attachment, the webhook answer and immutable responses are covered too', async () => {
		const h = harness(network);
		const verified = await persona(h, 'verified');
		const origin = serverEnv().publicOrigin;
		const exported = await handleExportRequest({
			request: new Request(`${origin}/conta/exportar`, { method: 'POST', headers: { origin } }),
			locals: verified.locals,
			db: env.DB,
			publicOrigin: origin
		});
		const webhook = await respondToResendWebhook(
			new Request(`${origin}/api/webhooks/resend`, { method: 'POST', body: '{}' }),
			serverEnv(),
			{ logger: { warn: () => undefined, info: () => undefined } }
		);
		const immutable = Response.redirect(`${origin}/entrar`, 303);
		for (const raw of [exported, webhook, immutable]) {
			const response = applySecurityHeaders(raw, { origin });
			expectBaseline(response, origin);
			expect(response.headers.get('content-security-policy')).toBe(NON_HTML_CSP);
		}
		expect(applySecurityHeaders(exported, { origin }).headers.get('cache-control')).toContain(
			'no-store'
		);
	});

	it("HTML keeps Kit's CSP and always gains frame-ancestors 'none'", async () => {
		const origin = serverEnv().publicOrigin;
		const kitPolicy = "script-src 'self' 'nonce-abc'; object-src 'none'";
		const page = applySecurityHeaders(
			new Response('<!doctype html><title>x</title>', {
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'content-security-policy': kitPolicy
				}
			}),
			{ origin }
		);
		expectBaseline(page, origin);
		const csp = page.headers.get('content-security-policy') ?? '';
		expect(csp).toContain(kitPolicy);
		expect(csp).toContain(FRAME_ANCESTORS_POLICY);
		const bare = applySecurityHeaders(
			new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } }),
			{ origin }
		);
		expect(bare.headers.get('content-security-policy')).toBe(FRAME_ANCESTORS_POLICY);
		const script = applySecurityHeaders(
			new Response('self.x=1', { headers: { 'content-type': 'text/javascript' } }),
			{ origin }
		);
		expect(script.headers.get('content-security-policy')).toBeNull();
		// A route's own CORP override wins.
		const embeddable = applySecurityHeaders(
			new Response('png', {
				headers: { 'content-type': 'image/png', 'cross-origin-resource-policy': 'cross-origin' }
			}),
			{ origin }
		);
		expect(embeddable.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
	});
});
