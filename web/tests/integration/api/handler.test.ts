// T4.1b: defineApi composition (handler.ts): origin → auth → rate limit → Turnstile → handler,
// with JSON errors, no-store and PII-free logs.
import { setupNetwork } from '@msw/cloudflare';
import type { RequestHandler } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	ApiError,
	defineApi,
	json,
	readJson,
	TURNSTILE_HEADER,
	type ApiEvent
} from '#lib/server/api/index.ts';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { SITEVERIFY_URL, TURNSTILE_ACTIONS } from '#lib/server/security/turnstile.ts';
import {
	adminLocals,
	expectErrorResponse,
	fakeBinding,
	HOSTNAME,
	localsOf,
	ORIGIN,
	randomIp,
	signedOut,
	staleSession
} from './helpers.ts';

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => {
	network.resetHandlers();
	vi.restoreAllMocks();
});
afterAll(() => network.disable());

interface EventInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	locals?: AuthLocals;
	platformEnv?: unknown;
	noPlatform?: boolean;
	routeId?: string | null;
}

function apiEvent(init: EventInit = {}): ApiEvent {
	const method = init.method ?? 'GET';
	const unsafe = method !== 'GET' && method !== 'HEAD';
	const headers: Record<string, string> = {
		'cf-connecting-ip': randomIp(),
		...(unsafe ? { origin: ORIGIN } : {}),
		...init.headers
	};
	return {
		request: new Request(`${ORIGIN}/api/v1/test`, {
			method,
			headers,
			...(init.body === undefined ? {} : { body: init.body })
		}),
		locals: init.locals ?? signedOut(),
		platform: init.noPlatform ? undefined : { env: init.platformEnv ?? env },
		route: { id: init.routeId === undefined ? '/api/v1/test' : init.routeId }
	};
}

function spyLog() {
	return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

const okHandler = vi.fn(() => json({ ok: true }));

describe('defineApi: success paths', () => {
	it('public: passes the signed-in user, or null (also for banned users)', async () => {
		const seen: (string | null)[] = [];
		const handler = defineApi<ApiEvent>(
			{ auth: 'public', rateLimit: { group: 'api.t.h.public' } },
			({ user, session, env: serverEnv, event }) => {
				expect(serverEnv.publicOrigin).toBe(ORIGIN);
				expect(event.route.id).toBe('/api/v1/test');
				seen.push(user?.id ?? null);
				expect(session?.userId ?? null).toBe(user?.id ?? null);
				return json({ ok: true });
			}
		);
		const locals = localsOf();
		expect((await handler(apiEvent())).status).toBe(200);
		expect((await handler(apiEvent({ locals }))).status).toBe(200);
		expect((await handler(apiEvent({ locals: localsOf({ banned: true }) }))).status).toBe(200);
		expect(seen).toEqual([null, locals.user.id, null]);
	});

	it('verified write: same origin, RL_WRITE, Turnstile, body; returns the handler response', async () => {
		network.use(
			http.post(SITEVERIFY_URL, () =>
				HttpResponse.json({ success: true, action: TURNSTILE_ACTIONS.report, hostname: HOSTNAME })
			)
		);
		const handler = defineApi<ApiEvent>(
			{
				auth: 'verified',
				rateLimit: { group: 'api.t.h.report', quotas: [{ limit: 5 }] },
				turnstile: TURNSTILE_ACTIONS.report
			},
			async ({ event, user }) => {
				const body = await readJson(event.request, z.object({ reason: z.string() }));
				return json({ by: user.id, reason: body.reason }, { status: 201 });
			}
		);
		const locals = localsOf();
		const response = await handler(
			apiEvent({
				method: 'POST',
				locals,
				headers: { 'content-type': 'application/json', [TURNSTILE_HEADER]: 'tok' },
				body: '{"reason":"spam"}'
			})
		);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ by: locals.user.id, reason: 'spam' });
	});

	it('admin: passes an effective admin; rateLimit false skips the limiter', async () => {
		const handler = defineApi<ApiEvent>(
			{ auth: 'admin', rateLimit: false, destructive: true },
			({ user }) => json({ id: user.id })
		);
		const locals = adminLocals();
		const platformEnv = { ...env, RL_WRITE: fakeBinding('throw') };
		const response = await handler(apiEvent({ method: 'POST', locals, platformEnv }));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ id: locals.user.id });
	});

	it('is assignable to a SvelteKit RequestHandler', () => {
		const handler: RequestHandler = defineApi({ auth: 'user', rateLimit: false }, ({ user }) =>
			json({ id: user.id })
		);
		expect(typeof handler).toBe('function');
	});
});

describe('defineApi: error codes', () => {
	it('403 BAD_ORIGIN before anything else (missing or foreign Origin)', async () => {
		okHandler.mockClear();
		const handler = defineApi<ApiEvent>(
			{ auth: 'user', rateLimit: { group: 'api.t.h.o' } },
			okHandler
		);
		const missing = apiEvent({ method: 'POST', locals: localsOf() });
		missing.request.headers.delete('origin');
		await expectErrorResponse(await handler(missing), 403, 'BAD_ORIGIN');
		await expectErrorResponse(
			await handler(apiEvent({ method: 'DELETE', headers: { origin: 'https://evil.example' } })),
			403,
			'BAD_ORIGIN'
		);
		expect(okHandler).not.toHaveBeenCalled();
	});

	it('401 AUTH_REQUIRED, 403 EMAIL_NOT_VERIFIED, 403 BANNED', async () => {
		const user = defineApi<ApiEvent>(
			{ auth: 'user', rateLimit: { group: 'api.t.h.u' } },
			okHandler
		);
		const verified = defineApi<ApiEvent>(
			{ auth: 'verified', rateLimit: { group: 'api.t.h.v' } },
			okHandler
		);
		okHandler.mockClear();
		await expectErrorResponse(await user(apiEvent()), 401, 'AUTH_REQUIRED');
		await expectErrorResponse(
			await verified(apiEvent({ locals: localsOf({ emailVerified: false }) })),
			403,
			'EMAIL_NOT_VERIFIED'
		);
		await expectErrorResponse(
			await user(apiEvent({ method: 'PATCH', locals: localsOf({ banned: true }) })),
			403,
			'BANNED'
		);
		expect(okHandler).not.toHaveBeenCalled();
	});

	it('404 NOT_FOUND for non-admins and 403 REAUTH_REQUIRED for stale destructive sessions', async () => {
		const admin = defineApi<ApiEvent>({ auth: 'admin', rateLimit: false }, okHandler);
		const destructive = defineApi<ApiEvent>(
			{ auth: 'admin', rateLimit: false, destructive: true },
			okHandler
		);
		await expectErrorResponse(await admin(apiEvent({ locals: localsOf() })), 404, 'NOT_FOUND');
		await expectErrorResponse(
			await destructive(apiEvent({ method: 'POST', locals: adminLocals(staleSession()) })),
			403,
			'REAUTH_REQUIRED'
		);
	});

	it('429 RATE_LIMITED with retry-after; reads use RL_API and writes RL_WRITE', async () => {
		const handler = defineApi<ApiEvent>(
			{ auth: 'public', rateLimit: { group: 'api.t.h.rl' } },
			() => json({ ok: true })
		);
		const readDenied = { ...env, RL_API: fakeBinding('deny'), RL_WRITE: fakeBinding('allow') };
		const read = await handler(apiEvent({ platformEnv: readDenied }));
		expect(read.headers.get('retry-after')).toBe('60');
		await expectErrorResponse(read, 429, 'RATE_LIMITED');
		expect((await handler(apiEvent({ method: 'POST', platformEnv: readDenied }))).status).toBe(200);

		const writeDenied = { ...env, RL_API: fakeBinding('allow'), RL_WRITE: fakeBinding('deny') };
		await expectErrorResponse(
			await handler(apiEvent({ method: 'PUT', platformEnv: writeDenied })),
			429,
			'RATE_LIMITED'
		);
		const forcedWrite = defineApi<ApiEvent>(
			{ auth: 'public', rateLimit: { group: 'api.t.h.rlw', kind: 'write' } },
			() => json({ ok: true })
		);
		await expectErrorResponse(
			await forcedWrite(apiEvent({ platformEnv: writeDenied })),
			429,
			'RATE_LIMITED'
		);
	});

	it('503 RATE_LIMIT_UNAVAILABLE when the binding fails, logged with the code only', async () => {
		const log = spyLog();
		const handler = defineApi<ApiEvent>({ auth: 'public', rateLimit: { group: 'api.t.h.d' } }, () =>
			json({ ok: true })
		);
		const ip = '203.0.113.77';
		const response = await handler(
			apiEvent({
				headers: { 'cf-connecting-ip': ip },
				platformEnv: { ...env, RL_API: fakeBinding('throw') }
			})
		);
		await expectErrorResponse(response, 503, 'RATE_LIMIT_UNAVAILABLE');
		expect(log).toHaveBeenCalledWith(
			JSON.stringify({ event: 'api.error', route: '/api/v1/test', code: 'RATE_LIMIT_UNAVAILABLE' })
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain(ip);
	});

	it('403 TURNSTILE_FAILED without a valid token; the handler never runs', async () => {
		okHandler.mockClear();
		const handler = defineApi<ApiEvent>(
			{ auth: 'verified', rateLimit: { group: 'api.t.h.ts' }, turnstile: TURNSTILE_ACTIONS.s6 },
			okHandler
		);
		await expectErrorResponse(
			await handler(apiEvent({ method: 'POST', locals: localsOf() })),
			403,
			'TURNSTILE_FAILED'
		);
		expect(okHandler).not.toHaveBeenCalled();
	});

	it('maps body errors thrown by readJson: 415, 413, 400', async () => {
		const handler = defineApi<ApiEvent>(
			{ auth: 'user', rateLimit: { group: 'api.t.h.body' } },
			async ({ event }) => {
				await readJson(event.request, z.object({ n: z.number() }), { maxBytes: 32 });
				return json({ ok: true });
			}
		);
		const locals = localsOf();
		await expectErrorResponse(
			await handler(apiEvent({ method: 'POST', locals, body: '{"n":1}' })),
			415,
			'UNSUPPORTED_MEDIA_TYPE'
		);
		const jsonHeaders = { 'content-type': 'application/json' };
		await expectErrorResponse(
			await handler(
				apiEvent({
					method: 'POST',
					locals,
					headers: jsonHeaders,
					body: `{"n":"${'9'.repeat(64)}"}`
				})
			),
			413,
			'PAYLOAD_TOO_LARGE'
		);
		const invalid = await expectErrorResponse(
			await handler(apiEvent({ method: 'POST', locals, headers: jsonHeaders, body: '{"n":"x"}' })),
			400,
			'INVALID_BODY'
		);
		expect(invalid.error.details).toEqual({ issues: [{ path: ['n'], code: 'invalid_type' }] });
	});

	it('maps ApiErrors thrown by the handler (FORBIDDEN, CONFLICT, NOT_FOUND)', async () => {
		for (const [status, code] of [
			[403, 'FORBIDDEN'],
			[409, 'CONFLICT'],
			[404, 'NOT_FOUND']
		] as const) {
			const handler = defineApi<ApiEvent>({ auth: 'public', rateLimit: false }, () => {
				throw new ApiError(status, code, { reason: 'test' });
			});
			const body = await expectErrorResponse(await handler(apiEvent()), status, code);
			expect(body.error.details).toEqual({ reason: 'test' });
		}
	});

	it('500 INTERNAL for other errors, logging only the route id and the error name', async () => {
		const log = spyLog();
		const pii = 'person@example.test 198.51.100.4';
		const handler = defineApi<ApiEvent>({ auth: 'public', rateLimit: false }, () => {
			throw new TypeError(pii);
		});
		const body = await expectErrorResponse(await handler(apiEvent()), 500, 'INTERNAL');
		expect(body).toEqual({ error: { code: 'INTERNAL' } });
		expect(log).toHaveBeenCalledWith(
			JSON.stringify({ event: 'api.error', route: '/api/v1/test', error: 'TypeError' })
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain('198.51.100.4');

		const thrownString = defineApi<ApiEvent>({ auth: 'public', rateLimit: false }, () => {
			throw pii;
		});
		await expectErrorResponse(await thrownString(apiEvent({ routeId: null })), 500, 'INTERNAL');
		expect(log).toHaveBeenLastCalledWith(
			JSON.stringify({ event: 'api.error', route: 'unknown', error: 'string' })
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain('person@example.test');
	});

	it('500 INTERNAL when the platform env is missing or invalid', async () => {
		const log = spyLog();
		const handler = defineApi<ApiEvent>({ auth: 'public', rateLimit: false }, () => json({}));
		await expectErrorResponse(await handler(apiEvent({ noPlatform: true })), 500, 'INTERNAL');
		await expectErrorResponse(
			await handler(apiEvent({ platformEnv: { ...env, IPHASH_PEPPER: 'short' } })),
			500,
			'INTERNAL'
		);
		expect(log).toHaveBeenLastCalledWith(
			JSON.stringify({ event: 'api.error', route: '/api/v1/test', error: 'ServerEnvError' })
		);
	});
});
