// T4.1b: rate limits (bindings + D1 quotas) and Turnstile of /api/v1 (limits.ts).
import { setupNetwork } from '@msw/cloudflare';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	apiRateLimit,
	apiTurnstile,
	BINDING_RETRY_AFTER,
	TURNSTILE_HEADER,
	type ApiLimitEnv
} from '#lib/server/api/index.ts';
import {
	DUMMY_TURNSTILE_TOKEN,
	SITEVERIFY_URL,
	TURNSTILE_ACTIONS
} from '#lib/server/security/turnstile.ts';
import {
	expectApiError,
	fakeBinding,
	HOSTNAME,
	localsOf,
	ORIGIN,
	randomIp,
	serverEnv,
	signedOut,
	type FakeBinding
} from './helpers.ts';

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

const base = serverEnv();

function limitEnv(api: FakeBinding, write: FakeBinding): ApiLimitEnv {
	return { ...base, rateLimit: { api, write } };
}

function request(ip?: string, method = 'GET'): Request {
	return new Request(`${ORIGIN}/api/v1/x`, {
		method,
		headers: ip === undefined ? {} : { 'cf-connecting-ip': ip }
	});
}

describe('apiRateLimit', () => {
	it('uses RL_API for reads and RL_WRITE for writes, keyed by user id when signed in', async () => {
		const api = fakeBinding('allow');
		const write = fakeBinding('allow');
		const locals = localsOf();
		await apiRateLimit(
			limitEnv(api, write),
			{ request: request(), locals },
			{
				group: 'api.t.read',
				kind: 'read'
			}
		);
		await apiRateLimit(
			limitEnv(api, write),
			{ request: request(), locals },
			{
				group: 'api.t.write',
				kind: 'write'
			}
		);
		expect(api.keys).toEqual([`u:api.t.read:${locals.user.id}`]);
		expect(write.keys).toEqual([`u:api.t.write:${locals.user.id}`]);
	});

	it('keys signed-out clients by the salted IP hash, never the raw IP', async () => {
		const api = fakeBinding('allow');
		const env = limitEnv(api, fakeBinding('allow'));
		const ip = randomIp();
		const rule = { group: 'api.t.ip', kind: 'read' as const };
		await apiRateLimit(env, { request: request(ip), locals: signedOut() }, rule);
		await apiRateLimit(env, { request: request(ip), locals: signedOut() }, rule);
		await apiRateLimit(env, { request: request(randomIp()), locals: signedOut() }, rule);
		await apiRateLimit(env, { request: request(), locals: signedOut() }, rule);
		await apiRateLimit(env, { request: request('not-an-ip'), locals: signedOut() }, rule);
		const [first, again, other, none, invalid] = api.keys;
		expect(first).toMatch(/^ip:api\.t\.ip:[A-Za-z0-9_-]{43}$/);
		expect(first).not.toContain(ip);
		expect(again).toBe(first);
		expect(other).not.toBe(first);
		// Missing and invalid IPs share one bucket.
		expect(none).toMatch(/^ip:api\.t\.ip:[A-Za-z0-9_-]{43}$/);
		expect(invalid).toBe(none);
	});

	it('passes with the real RL_API binding', async () => {
		await apiRateLimit(
			base,
			{ request: request(randomIp()), locals: signedOut() },
			{
				group: 'api.t.real',
				kind: 'read'
			}
		);
		expect(true).toBe(true);
	});

	it('429 RATE_LIMITED with retry-after when the binding refuses', async () => {
		const error = await expectApiError(
			() =>
				apiRateLimit(
					limitEnv(fakeBinding('allow'), fakeBinding('deny')),
					{
						request: request(randomIp(), 'POST'),
						locals: signedOut()
					},
					{ group: 'api.t.deny', kind: 'write' }
				),
			429,
			'RATE_LIMITED'
		);
		expect(error.headers).toEqual({ 'retry-after': String(BINDING_RETRY_AFTER) });
	});

	it('503 RATE_LIMIT_UNAVAILABLE when the binding, the salt store or the rule fails', async () => {
		await expectApiError(
			() =>
				apiRateLimit(
					limitEnv(fakeBinding('throw'), fakeBinding('allow')),
					{
						request: request(),
						locals: localsOf()
					},
					{ group: 'api.t.down', kind: 'read' }
				),
			503,
			'RATE_LIMIT_UNAVAILABLE'
		);
		const brokenKv: ApiLimitEnv = {
			...limitEnv(fakeBinding('allow'), fakeBinding('allow')),
			config: {
				get: async () => {
					throw new Error('kv down');
				},
				put: async () => undefined
			}
		};
		await expectApiError(
			() =>
				apiRateLimit(
					brokenKv,
					{ request: request(randomIp()), locals: signedOut() },
					{
						group: 'api.t.kv',
						kind: 'read'
					}
				),
			503,
			'RATE_LIMIT_UNAVAILABLE'
		);
		await expectApiError(
			() =>
				apiRateLimit(
					limitEnv(fakeBinding('allow'), fakeBinding('allow')),
					{
						request: request(),
						locals: localsOf()
					},
					{ group: 'Bad Group!', kind: 'read' }
				),
			503,
			'RATE_LIMIT_UNAVAILABLE'
		);
		await expectApiError(
			() =>
				apiRateLimit(
					limitEnv(fakeBinding('allow'), fakeBinding('allow')),
					{
						request: request(),
						locals: localsOf()
					},
					{ group: 'api.t.window', kind: 'write', quotas: [{ limit: 1, windowSeconds: 0.5 }] }
				),
			503,
			'RATE_LIMIT_UNAVAILABLE'
		);
	});

	it('enforces D1 quotas (daily by default) after the burst guard', async () => {
		const write = fakeBinding('allow');
		const env = limitEnv(fakeBinding('allow'), write);
		const locals = localsOf();
		const rule = { group: 'api.t.quota', kind: 'write' as const, quotas: [{ limit: 2 }] };
		const now = new Date('2026-10-16T12:00:00Z');
		await apiRateLimit(env, { request: request(), locals }, rule, now);
		await apiRateLimit(env, { request: request(), locals }, rule, now);
		const error = await expectApiError(
			() => apiRateLimit(env, { request: request(), locals }, rule, now),
			429,
			'RATE_LIMITED'
		);
		// 12 h left in the UTC day window.
		expect(error.headers).toEqual({ 'retry-after': String(12 * 3600) });
		expect(write.keys).toHaveLength(3);
	});
});

describe('apiTurnstile', () => {
	let sent: URLSearchParams | null = null;

	function siteverify(payload: Record<string, unknown>) {
		return http.post(SITEVERIFY_URL, async ({ request: incoming }) => {
			sent = new URLSearchParams(await incoming.text());
			return HttpResponse.json(payload);
		});
	}

	function withToken(token: string): Request {
		return new Request(`${ORIGIN}/api/v1/x`, {
			method: 'POST',
			headers: { [TURNSTILE_HEADER]: token }
		});
	}

	it('passes when Siteverify confirms the action and the PUBLIC_ORIGIN hostname', async () => {
		network.use(
			siteverify({ success: true, action: TURNSTILE_ACTIONS.report, hostname: HOSTNAME })
		);
		await apiTurnstile(base, withToken('tok-1'), TURNSTILE_ACTIONS.report);
		expect(sent?.get('response')).toBe('tok-1');
		expect(sent?.get('secret')).toBe(base.secrets.turnstileSecret);
		expect(sent?.has('remoteip')).toBe(false);
	});

	it('403 TURNSTILE_FAILED for missing, invalid and mismatched tokens', async () => {
		await expectApiError(
			() => apiTurnstile(base, request(), TURNSTILE_ACTIONS.report),
			403,
			'TURNSTILE_FAILED'
		);
		network.use(siteverify({ success: false, 'error-codes': ['invalid-input-response'] }));
		await expectApiError(
			() => apiTurnstile(base, withToken('bad'), TURNSTILE_ACTIONS.report),
			403,
			'TURNSTILE_FAILED'
		);
		network.use(siteverify({ success: true, action: TURNSTILE_ACTIONS.s6, hostname: HOSTNAME }));
		await expectApiError(
			() => apiTurnstile(base, withToken('tok'), TURNSTILE_ACTIONS.report),
			403,
			'TURNSTILE_FAILED'
		);
	});

	it('uses the local stub only for capture on a loopback origin', async () => {
		// `sent` is shared by this describe: clear what the previous tests recorded.
		sent = null;
		const local = {
			publicOrigin: 'http://localhost:4174',
			emailTransport: 'capture' as const,
			secrets: { turnstileSecret: base.secrets.turnstileSecret }
		};
		await apiTurnstile(local, withToken(DUMMY_TURNSTILE_TOKEN), TURNSTILE_ACTIONS.report);
		await expectApiError(
			() => apiTurnstile(local, withToken('other'), TURNSTILE_ACTIONS.report),
			403,
			'TURNSTILE_FAILED'
		);
		expect(sent).toBeNull();
	});
});
