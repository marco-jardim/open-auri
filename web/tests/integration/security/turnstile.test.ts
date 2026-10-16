import { setupNetwork } from '@msw/cloudflare';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	MAX_TOKEN_LENGTH,
	SITEVERIFY_URL,
	verifyTurnstile
} from '#lib/server/security/turnstile.ts';

const network = setupNetwork();
const SECRET = '2x0000000000000000000000000000000AA';
const base = { token: 'tok', action: 'sign-in', hostname: 'auri.example', secret: SECRET };

let lastBody: URLSearchParams | null = null;

function siteverify(payload: Record<string, unknown>, status = 200) {
	return http.post(SITEVERIFY_URL, async ({ request }) => {
		lastBody = new URLSearchParams(await request.text());
		return HttpResponse.json(payload, { status });
	});
}

beforeAll(() => network.enable());
afterEach(() => {
	network.resetHandlers();
	lastBody = null;
});
afterAll(() => network.disable());

describe('verifyTurnstile', () => {
	it('accepts a successful response with the expected action and hostname', async () => {
		network.use(siteverify({ success: true, action: 'sign-in', hostname: 'auri.example' }));
		expect(await verifyTurnstile({ ...base, idempotencyKey: 'fixed-key' })).toEqual({ ok: true });
		expect(lastBody?.get('secret')).toBe(SECRET);
		expect(lastBody?.get('response')).toBe('tok');
		expect(lastBody?.get('idempotency_key')).toBe('fixed-key');
		expect(lastBody?.has('remoteip')).toBe(false);
	});

	it('generates an idempotency key when none is given', async () => {
		network.use(siteverify({ success: true, action: 'sign-in', hostname: 'auri.example' }));
		await verifyTurnstile(base);
		expect(lastBody?.get('idempotency_key')).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('rejects a wrong action', async () => {
		network.use(siteverify({ success: true, action: 'sign-up', hostname: 'auri.example' }));
		expect(await verifyTurnstile(base)).toEqual({ ok: false, reason: 'action' });
	});

	it('rejects a wrong hostname', async () => {
		network.use(siteverify({ success: true, action: 'sign-in', hostname: 'evil.example' }));
		expect(await verifyTurnstile(base)).toEqual({ ok: false, reason: 'hostname' });
	});

	it('rejects an invalid token', async () => {
		network.use(siteverify({ success: false, 'error-codes': ['invalid-input-response'] }));
		expect(await verifyTurnstile(base)).toEqual({ ok: false, reason: 'invalid' });
	});

	it('rejects an expired or already redeemed token', async () => {
		network.use(siteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
		expect(await verifyTurnstile(base)).toEqual({ ok: false, reason: 'expired-or-duplicate' });
	});

	it('fails closed on configuration errors, HTTP errors and network failures', async () => {
		network.use(siteverify({ success: false, 'error-codes': ['invalid-input-secret'] }));
		expect(await verifyTurnstile(base)).toEqual({ ok: false, reason: 'unavailable' });

		network.use(siteverify({ success: true, action: 'sign-in', hostname: 'auri.example' }, 500));
		expect(await verifyTurnstile(base)).toEqual({ ok: false, reason: 'unavailable' });

		network.use(http.post(SITEVERIFY_URL, () => HttpResponse.error()));
		expect(await verifyTurnstile(base)).toEqual({ ok: false, reason: 'unavailable' });

		network.use(http.post(SITEVERIFY_URL, () => new HttpResponse('not json')));
		expect(await verifyTurnstile(base)).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('rejects missing and oversized tokens without calling Siteverify', async () => {
		let calls = 0;
		const fetch = async () => {
			calls += 1;
			return new Response('{}');
		};
		expect(await verifyTurnstile({ ...base, token: '', fetch })).toEqual({
			ok: false,
			reason: 'missing'
		});
		expect(await verifyTurnstile({ ...base, token: null, fetch })).toEqual({
			ok: false,
			reason: 'missing'
		});
		const long = 'x'.repeat(MAX_TOKEN_LENGTH + 1);
		expect(await verifyTurnstile({ ...base, token: long, fetch })).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(calls).toBe(0);
	});
});
