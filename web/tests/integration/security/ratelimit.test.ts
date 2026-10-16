import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAuthGuard, type AuthGuardLogEvent } from '#lib/server/security/auth-guard.ts';
import { createKeyedHasher, forgetSalts } from '#lib/server/security/iphash.ts';
import {
	AUTH_GUARDED_PATHS,
	authRateLimit,
	rateLimit,
	rateLimitKey,
	RateLimitKeyError,
	slidingWindowLimit,
	type WindowRule
} from '#lib/server/security/ratelimit.ts';
import type { TurnstileResult, VerifyTurnstileOptions } from '#lib/server/security/turnstile.ts';

const HASH = 'A'.repeat(43);
const T0 = Date.parse('2026-10-16T12:00:00Z'); // multiple of 10, 60 and 300 s
// The guard creates a real daily salt in KV (which rejects past expirations): use the real day,
// aligned 1 s after a 300 s boundary so every window is deterministic.
const GUARD_NOW = Math.floor(Date.now() / 300_000) * 300_000 + 1000;

function rule(limit: number, windowSeconds: number, id = 'probe'): WindowRule {
	return { key: rateLimitKey.ip(`test.${id}`, HASH), limit, windowSeconds };
}

async function attempts(rules: WindowRule[], times: number, at: number) {
	const outcomes = [];
	for (let index = 0; index < times; index += 1) {
		outcomes.push(await slidingWindowLimit(env.DB, rules, new Date(at)));
	}
	return outcomes;
}

/** Fake Workers RateLimit binding: `limit` successes per key, then failures. */
function fakeBinding(limit: number) {
	const counts = new Map<string, number>();
	const keys: string[] = [];
	return {
		keys,
		binding: {
			limit: async ({ key }: { key: string }) => {
				keys.push(key);
				const next = (counts.get(key) ?? 0) + 1;
				counts.set(key, next);
				return { success: next <= limit };
			}
		}
	};
}

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM rate_limit_counters').run();
});

describe('rate-limit keys', () => {
	it('accept hashes, user ids and groups, never a raw IP', () => {
		expect(rateLimitKey.ip('auth', HASH)).toBe(`ip:auth:${HASH}`);
		expect(rateLimitKey.user('write', 'user_123')).toBe('u:write:user_123');
		expect(rateLimitKey.route('api.public')).toBe('r:api.public');
		expect(() => rateLimitKey.ip('auth', '203.0.113.9')).toThrow(RateLimitKeyError);
		expect(() => rateLimitKey.ip('auth', '2001:db8::1')).toThrow(RateLimitKeyError);
		expect(() => rateLimitKey.id('auth', 'someone@example.com')).toThrow(RateLimitKeyError);
		expect(() => rateLimitKey.route('Bad Group')).toThrow(RateLimitKeyError);
	});
});

describe('rateLimit (Workers RateLimit binding)', () => {
	it('maps success, limit and binding failure', async () => {
		const { binding } = fakeBinding(1);
		const key = rateLimitKey.route('probe');
		expect(await rateLimit(binding, key)).toEqual({ ok: true });
		expect(await rateLimit(binding, key)).toEqual({ ok: false, reason: 'limited' });
		const broken = { limit: () => Promise.reject(new Error('down')) };
		expect(await rateLimit(broken, key)).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('works with the real RL_AUTH binding', async () => {
		expect(await rateLimit(env.RL_AUTH, rateLimitKey.ip('probe', HASH))).toEqual({ ok: true });
	});
});

describe('slidingWindowLimit (D1)', () => {
	it('allows 3 per 10 s, blocks the 4th, and recovers after the window slides', async () => {
		const rules = [rule(3, 10)];
		const first = await attempts(rules, 4, T0 + 1000);
		expect(first.slice(0, 3).every((o) => o.ok)).toBe(true);
		const blocked = first[3];
		expect(blocked).toMatchObject({ ok: false, reason: 'limited' });
		// Clock is injected (T0 + 1 s, window 10 s): the hint is the rest of the window, 1–10 s.
		const retryAfter =
			blocked && !blocked.ok && blocked.reason === 'limited' ? blocked.retryAfter : 0;
		expect(retryAfter).toBeGreaterThanOrEqual(1);
		expect(retryAfter).toBeLessThanOrEqual(10);
		// 25 s later both counted windows are gone.
		expect((await attempts(rules, 1, T0 + 25_000))[0]).toEqual({ ok: true });
	});

	it('weights the previous window (no burst right after a boundary)', async () => {
		const rules = [rule(3, 60)];
		await attempts(rules, 3, T0 + 59_000);
		// 1 s into the next window, ~98% of the previous 3 still count.
		expect((await attempts(rules, 1, T0 + 61_000))[0]).toMatchObject({ ok: false });
	});

	it('supports windows longer than 60 s (3 per 300 s)', async () => {
		const rules = [rule(3, 300)];
		const outcomes = await attempts(rules, 4, T0 + 10_000);
		expect(outcomes.map((o) => o.ok)).toEqual([true, true, true, false]);
		// Still limited two minutes later (a 60 s binding would have reset).
		expect((await attempts(rules, 1, T0 + 130_000))[0]).toMatchObject({ ok: false });
		// Two full windows later: allowed again.
		expect((await attempts(rules, 1, T0 + 610_000))[0]).toEqual({ ok: true });
	});

	it('enforces every rule of a batch and keeps keys independent', async () => {
		const strict = rule(1, 60, 'strict');
		const loose = rule(5, 60, 'loose');
		expect((await attempts([strict, loose], 1, T0))[0]).toEqual({ ok: true });
		expect((await attempts([strict, loose], 1, T0))[0]).toMatchObject({ ok: false });
		expect((await attempts([loose], 1, T0))[0]).toEqual({ ok: true });
	});

	it('peek rules (failure budgets) are read, never counted', async () => {
		const counted = rule(2, 60, 'peek');
		const peek: WindowRule = { ...counted, peek: true };
		const peeks = await attempts([peek], 5, T0);
		expect(peeks.every((o) => o.ok)).toBe(true);
		await attempts([counted], 1, T0);
		expect((await attempts([peek], 1, T0))[0]).toEqual({ ok: true });
		await attempts([counted], 1, T0);
		// Two failures counted: one more would exceed the limit of 2.
		expect((await attempts([peek], 1, T0))[0]).toMatchObject({ ok: false, reason: 'limited' });
	});

	it('reports D1 failures as unavailable', async () => {
		const broken: Pick<D1Database, 'prepare' | 'batch'> = {
			prepare: (query: string) => env.DB.prepare(query),
			batch: () => Promise.reject(new Error('d1 down'))
		};
		expect(await slidingWindowLimit(broken as D1Database, [rule(1, 10)])).toEqual({
			ok: false,
			reason: 'unavailable'
		});
	});
});

describe('authRateLimit rules', () => {
	it('covers every guarded path with the plan limits', () => {
		const limits = (path: string) =>
			authRateLimit({
				path,
				ipHash: HASH,
				idHash: 'B'.repeat(43),
				ipIdHash: 'C'.repeat(43)
			})?.map((r) => `${r.limit}/${r.windowSeconds}`);
		expect(limits('/sign-in/email')?.[0]).toBe('3/10');
		expect(limits('/sign-in/username')?.[0]).toBe('3/10');
		expect(limits('/sign-up/email')?.[0]).toBe('3/60');
		expect(limits('/request-password-reset')?.[0]).toBe('3/60');
		expect(limits('/send-verification-email')?.[0]).toBe('3/300');
		// FX3.1 (Q3-4): daily cap per address.
		expect(limits('/send-verification-email')).toContain('10/86400');
		expect(limits('/change-email')).toContain('3/300');
		expect(authRateLimit({ path: '/get-session', ipHash: HASH })).toBeNull();
		for (const path of AUTH_GUARDED_PATHS) expect(limits(path)?.length).toBeGreaterThan(0);
	});

	it('combines IP and identifier when present, adds a per-identifier rule, falls back to IP', () => {
		const withId = authRateLimit({
			path: '/sign-in/email',
			ipHash: HASH,
			idHash: 'B'.repeat(43),
			ipIdHash: 'C'.repeat(43)
		});
		expect(withId?.map((r) => r.key)).toEqual([
			`ip:auth.sign-in.0:${'C'.repeat(43)}`,
			`id:auth.sign-in.1:${'B'.repeat(43)}`,
			`ip:auth.sign-in.2:${HASH}`
		]);
		const withoutId = authRateLimit({ path: '/sign-in/email', ipHash: HASH });
		expect(withoutId?.map((r) => r.key)).toEqual([
			`ip:auth.sign-in.0:${HASH}`,
			`ip:auth.sign-in.2:${HASH}`
		]);
	});
});

describe('createAuthGuard', () => {
	const okTurnstile = async (): Promise<TurnstileResult> => ({ ok: true });

	function guardWith(
		options: {
			bindingLimit?: number;
			verify?: (o: VerifyTurnstileOptions) => Promise<TurnstileResult>;
			now?: number;
		} = {}
	) {
		const fake = fakeBinding(options.bindingLimit ?? 100);
		const logs: AuthGuardLogEvent[] = [];
		const calls: VerifyTurnstileOptions[] = [];
		const verify = options.verify ?? okTurnstile;
		const guard = createAuthGuard({
			env: {
				db: env.DB,
				config: env.CONFIG,
				rateLimit: { auth: fake.binding },
				publicOrigin: 'https://auri.example',
				secrets: { iphashPepper: env.IPHASH_PEPPER, turnstileSecret: env.TURNSTILE_SECRET }
			},
			verifyTurnstile: (o) => {
				calls.push(o);
				return verify(o);
			},
			now: () => new Date(options.now ?? GUARD_NOW),
			log: (event) => logs.push(event)
		});
		return { guard, logs, calls, keys: fake.keys };
	}

	const signIn = {
		path: '/sign-in/email',
		ip: '203.0.113.9',
		email: 'Someone@Example.com',
		turnstileToken: 'token'
	};

	beforeEach(() => forgetSalts(env.CONFIG));

	it('passes unguarded paths untouched', async () => {
		const { guard, keys, calls } = guardWith();
		expect(await guard({ path: '/get-session', ip: '203.0.113.9' })).toEqual({ ok: true });
		expect(keys).toEqual([]);
		expect(calls).toEqual([]);
	});

	it('allows 3 sign-ins per 10 s for the same IP and e-mail, then 429 with Retry-After', async () => {
		const { guard, logs, calls } = guardWith();
		for (let index = 0; index < 3; index += 1) expect(await guard(signIn)).toEqual({ ok: true });
		const blocked = await guard({ ...signIn, email: '  someone@example.COM ' });
		expect(blocked).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED' });
		expect(calls).toHaveLength(3);
		expect(calls[0]).toMatchObject({ action: 'sign-in', hostname: 'auri.example' });
		expect(logs).toEqual([
			{ event: 'auth_guard.denied', group: 'auth.sign-in', code: 'RATE_LIMITED' }
		]);
		expect(JSON.stringify(logs)).not.toMatch(/203\.0\.113|example\.com/i);
	});

	it('limits an e-mail across rotating IPs', async () => {
		const { guard } = guardWith();
		const results = [];
		for (let index = 1; index <= 11; index += 1) {
			results.push(await guard({ ...signIn, ip: `198.51.100.${index}` }));
		}
		expect(results.slice(0, 10).every((r) => r.ok)).toBe(true);
		expect(results[10]).toMatchObject({ ok: false, status: 429 });
	});

	it('counts the per-e-mail rule only after Turnstile passed (no lockout by third parties)', async () => {
		const failing = guardWith({ verify: async () => ({ ok: false, reason: 'hostname' }) });
		for (let index = 1; index <= 15; index += 1) {
			const ip = `198.51.100.${index}`;
			expect(await failing.guard({ ...signIn, ip })).toMatchObject({ status: 403 });
			expect(await failing.guard({ ...signIn, ip, turnstileToken: null })).toMatchObject({
				status: 400
			});
		}
		const { guard } = guardWith();
		expect(await guard({ ...signIn, ip: '198.51.100.99' })).toEqual({ ok: true });
	});

	it('limits resend verification to 3 per 300 s without Turnstile', async () => {
		const { guard, calls } = guardWith();
		const resend = { path: '/send-verification-email', ip: '203.0.113.7', email: 'a@b.example' };
		for (let index = 0; index < 3; index += 1) expect((await guard(resend)).ok).toBe(true);
		expect(await guard(resend)).toMatchObject({ ok: false, status: 429 });
		expect(calls).toEqual([]);
	});

	it('applies the coarse RL_AUTH binding keyed by the IP hash only', async () => {
		const { guard, keys } = guardWith({ bindingLimit: 0 });
		expect(await guard(signIn)).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED' });
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^ip:auth:[A-Za-z0-9_-]{43}$/);
	});

	it('requires a Turnstile token and maps verification failures', async () => {
		expect(await guardWith().guard({ ...signIn, turnstileToken: null })).toMatchObject({
			ok: false,
			status: 400,
			code: 'TURNSTILE_REQUIRED'
		});
		const failed = guardWith({ verify: async () => ({ ok: false, reason: 'hostname' }) });
		expect(await failed.guard({ ...signIn, ip: '203.0.113.20' })).toMatchObject({
			status: 403,
			code: 'TURNSTILE_FAILED'
		});
		const down = guardWith({ verify: async () => ({ ok: false, reason: 'unavailable' }) });
		expect(await down.guard({ ...signIn, ip: '203.0.113.21' })).toMatchObject({
			status: 503,
			code: 'TURNSTILE_UNAVAILABLE'
		});
	});

	it('fails closed when the salt store is down', async () => {
		const guard = createAuthGuard({
			env: {
				db: env.DB,
				config: {
					get: () => Promise.reject(new Error('kv down')),
					put: () => Promise.reject(new Error('kv down'))
				},
				rateLimit: { auth: fakeBinding(100).binding },
				publicOrigin: 'https://auri.example',
				secrets: { iphashPepper: env.IPHASH_PEPPER, turnstileSecret: env.TURNSTILE_SECRET }
			},
			verifyTurnstile: okTurnstile,
			now: () => new Date('2031-01-01T00:00:00Z'),
			log: () => undefined
		});
		expect(await guard(signIn)).toMatchObject({ status: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
	});

	it('hashes identifiers so the counters hold no e-mail or IP', async () => {
		const { guard } = guardWith();
		await guard(signIn);
		const rows = await env.DB.prepare('SELECT key FROM rate_limit_counters').all<{ key: string }>();
		const keys = rows.results.map((row) => row.key).join('\n');
		expect(keys).not.toMatch(/someone|example|203\.0\.113/i);
		const hasher = await createKeyedHasher({
			pepper: env.IPHASH_PEPPER,
			salt: new Uint8Array(32)
		});
		expect(await hasher.value('id:x')).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});
});
