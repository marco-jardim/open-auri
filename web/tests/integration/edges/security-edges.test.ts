// Refusal and failure branches of the security layer: IP normalization and hashing edge cases,
// salt store failures, base64url decoding, Siteverify answers, D1 window failures and every
// fail-closed path of the auth guard. Security headers for the static file and plain-http origins.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerEnv } from '#lib/server/env.ts';
import {
	buildAccessRecord,
	captureAccess,
	sealAccessRecord,
	type AccessEventLike,
	type AccessLogFailure,
	type AccessRecord
} from '#lib/server/security/access-log.ts';
import { createAuthGuard, type AuthGuardDeps } from '#lib/server/security/auth-guard.ts';
import {
	base64UrlToBytes,
	bytesToBase64Url,
	concatBytes,
	utcDay
} from '#lib/server/security/encoding.ts';
import {
	FRAME_ANCESTORS_POLICY,
	HSTS,
	renderStaticHeadersFile,
	securityHeaders
} from '#lib/server/security/headers.ts';
import {
	createKeyedHasher,
	forgetSalts,
	getDailySalt,
	InvalidIpError,
	ipHash,
	ipHashMaterial,
	isKeyedHash,
	normalizeIp,
	SaltUnavailableError
} from '#lib/server/security/iphash.ts';
import { rateLimit, slidingWindowLimit } from '#lib/server/security/ratelimit.ts';
import {
	reasonFromErrorCodes,
	SITEVERIFY_URL,
	verifyTurnstile
} from '#lib/server/security/turnstile.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

const SALT = new Uint8Array(32).fill(7);

describe('normalizeIp', () => {
	it('canonicalizes IPv4, IPv6, mapped and bracketed forms', () => {
		const cases: [string, string | null][] = [
			[' 010.001.2.3 ', '10.1.2.3'],
			['[2001:DB8::1]', '2001:0db8:0000:0000:0000:0000:0000:0001'],
			['fe80::1%eth0', 'fe80:0000:0000:0000:0000:0000:0000:0001'],
			['::ffff:192.0.2.1', '192.0.2.1'],
			['0:0:0:0:0:ffff:c000:0201', '192.0.2.1'],
			['64:ff9b::192.0.2.1', '0064:ff9b:0000:0000:0000:0000:c000:0201'],
			['::1.2.3.4', '0000:0000:0000:0000:0000:0000:0102:0304'],
			['1::1.2.3.4', '0001:0000:0000:0000:0000:0000:0102:0304'],
			['1:2:3:4:5:6:7:8', '0001:0002:0003:0004:0005:0006:0007:0008'],
			['', null],
			['%eth0', null],
			['x'.repeat(65), null],
			['256.1.1.1', null],
			['1.2.3', null],
			['example.org', null],
			['1:2:3:4:5:6:7:8:9', null],
			['1:2:3:4:5:6:7', null],
			['1::2::3', null],
			['1:2:3:4:5:6:7:8::', null],
			['gggg::1', null],
			['::1.2.3.999', null],
			['1.2.3.4:5', null]
		];
		for (const [input, expected] of cases) {
			expect(normalizeIp(input)?.address ?? null, input).toBe(expected);
		}
	});

	it('hashes IPv6 per /64 by default and per address on request', async () => {
		const a = normalizeIp('2001:db8:1:2::1');
		const b = normalizeIp('2001:db8:1:2::ffff');
		if (!a || !b) throw new Error('parse');
		expect(ipHashMaterial(a)).toBe(ipHashMaterial(b));
		expect(ipHashMaterial(a, 128)).not.toBe(ipHashMaterial(b, 128));
		const options = { pepper: 'pepper', salt: SALT };
		expect(await ipHash('2001:db8:1:2::1', options)).toBe(await ipHash('2001:db8:1:2::ffff', options));
		expect(await ipHash('2001:db8:1:2::1', { ...options, ipv6Prefix: 128 })).not.toBe(
			await ipHash('2001:db8:1:2::ffff', { ...options, ipv6Prefix: 128 })
		);
		const hash = await ipHash('203.0.113.7', options);
		expect(isKeyedHash(hash)).toBe(true);
		expect(isKeyedHash('203.0.113.7')).toBe(false);
	});

	it('refuses a missing key and an invalid address without echoing it', async () => {
		await expect(createKeyedHasher({ pepper: '', salt: SALT })).rejects.toBeInstanceOf(
			SaltUnavailableError
		);
		await expect(
			createKeyedHasher({ pepper: 'p', salt: new Uint8Array(8) as Uint8Array<ArrayBuffer> })
		).rejects.toBeInstanceOf(SaltUnavailableError);
		const hasher = await createKeyedHasher({ pepper: 'p', salt: SALT });
		const error = await hasher.ip('not-an-ip-secret').catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(InvalidIpError);
		expect(String((error as Error).message)).not.toContain('not-an-ip-secret');
	});
});

describe('getDailySalt', () => {
	const day = new Date(Date.UTC(2026, 9, 16, 9));

	it('replaces a corrupt stored salt and memoizes the result', async () => {
		let stored: string | null = 'too-short';
		let reads = 0;
		const kv = {
			get: async () => {
				reads += 1;
				return stored;
			},
			put: async (_key: string, value: string) => {
				stored = value;
			}
		};
		const salt = await getDailySalt(kv as never, day);
		expect(salt).toHaveLength(32);
		expect(bytesToBase64Url(salt)).toBe(stored);
		const before = reads;
		expect(await getDailySalt(kv as never, day)).toBe(salt);
		expect(reads).toBe(before);
		forgetSalts(kv);
		await getDailySalt(kv as never, day);
		expect(reads).toBe(before + 1);
	});

	it('falls back to the fresh salt when the read-back is empty, and fails closed on KV errors', async () => {
		const lossy = { get: async () => null, put: async () => undefined };
		expect(await getDailySalt(lossy as never, day)).toHaveLength(32);
		const broken = {
			get: async () => {
				throw new Error('kv down');
			},
			put: async () => undefined
		};
		await expect(getDailySalt(broken as never, day)).rejects.toBeInstanceOf(SaltUnavailableError);
	});
});

describe('encoding helpers', () => {
	it('round-trips base64url and refuses anything else', () => {
		const bytes = new Uint8Array([0, 251, 255, 63, 62]);
		const text = bytesToBase64Url(bytes);
		expect(text).not.toMatch(/[+/=]/);
		expect(base64UrlToBytes(text)).toEqual(bytes);
		expect(bytesToBase64Url(bytes.buffer)).toBe(text);
		expect(base64UrlToBytes('a+b/')).toBeNull();
		expect(base64UrlToBytes('abcde')).toBeNull();
		expect(base64UrlToBytes('')).toEqual(new Uint8Array());
		expect(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
		expect(utcDay(new Date(Date.UTC(2026, 0, 2, 23, 59)))).toBe('2026-01-02');
	});
});

describe('verifyTurnstile (Siteverify answers)', () => {
	const base = { action: 'sign-in', hostname: 'example.org', secret: 'secret' };
	const answering = (body: unknown, status = 200) => async () =>
		new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

	it('maps every answer to a fail-closed result', async () => {
		const cases: [Parameters<typeof verifyTurnstile>[0], string | true][] = [
			[{ ...base, token: 'x'.repeat(2049) }, 'invalid'],
			[{ ...base, token: 't', secret: '' }, 'unavailable'],
			[{ ...base, token: 't', fetch: answering({}, 500) }, 'unavailable'],
			[{ ...base, token: 't', fetch: answering('null') }, 'unavailable'],
			[{ ...base, token: 't', fetch: answering('<html>') }, 'unavailable'],
			[
				{
					...base,
					token: 't',
					fetch: async () => {
						throw new TypeError('down');
					}
				},
				'unavailable'
			],
			[{ ...base, token: 't', fetch: answering({ success: false }) }, 'unavailable'],
			[
				{ ...base, token: 't', fetch: answering({ success: false, 'error-codes': [1, 'missing-input-response'] }) },
				'missing'
			],
			[
				{ ...base, token: 't', fetch: answering({ success: false, 'error-codes': ['timeout-or-duplicate'] }) },
				'expired-or-duplicate'
			],
			[{ ...base, token: 't', fetch: answering({ success: true, action: 'other', hostname: 'example.org' }) }, 'action'],
			[{ ...base, token: 't', fetch: answering({ success: true, action: 'sign-in', hostname: 'evil.example' }) }, 'hostname'],
			[{ ...base, token: 't', fetch: answering({ success: true, action: 'sign-in', hostname: 'example.org' }) }, true]
		];
		for (const [options, expected] of cases) {
			const result = await verifyTurnstile(options);
			if (expected === true) expect(result).toEqual({ ok: true });
			else expect(result, expected).toEqual({ ok: false, reason: expected });
		}
		expect(reasonFromErrorCodes(['internal-error'])).toBe('unavailable');
		expect(reasonFromErrorCodes(['invalid-input-response'])).toBe('invalid');
	});

	it('posts the secret, the token and an idempotency key, never the client IP', async () => {
		let sent: URLSearchParams | null = null;
		let url = '';
		await verifyTurnstile({
			...base,
			token: 'tok',
			idempotencyKey: 'fixed-key',
			fetch: async (input, init) => {
				url = input;
				sent = new URLSearchParams(String(init.body));
				return Response.json({ success: true, action: 'sign-in', hostname: 'example.org' });
			}
		});
		expect(url).toBe(SITEVERIFY_URL);
		const params = sent as URLSearchParams | null;
		expect(params?.get('idempotency_key')).toBe('fixed-key');
		expect(params?.get('response')).toBe('tok');
		expect(params?.has('remoteip')).toBe(false);
	});
});

describe('rate limit primitives', () => {
	it('binding errors are unavailable; empty rule sets pass; bad windows throw', async () => {
		expect(
			await rateLimit(
				{
					limit: async () => {
						throw new Error('binding down');
					}
				},
				'k' as never
			)
		).toEqual({ ok: false, reason: 'unavailable' });
		expect(await slidingWindowLimit(env.DB, [])).toEqual({ ok: true });
		await expect(
			slidingWindowLimit(env.DB, [{ key: 'k' as never, limit: 1, windowSeconds: 0.5 }])
		).rejects.toThrow(RangeError);
		const brokenDb = {
			prepare: (query: string) => env.DB.prepare(query),
			batch: async () => {
				throw new Error('d1 down');
			}
		};
		expect(
			await slidingWindowLimit(brokenDb as never, [{ key: 'k' as never, limit: 1, windowSeconds: 10 }])
		).toEqual({ ok: false, reason: 'unavailable' });
	});
});

describe('auth guard: every dependency failure fails closed', () => {
	const serverEnv = () => getServerEnv({ env });
	const passing = async () => ({ ok: true }) as const;
	const input = (overrides: Record<string, unknown> = {}) => ({
		path: '/sign-in/email',
		ip: `10.${crypto.getRandomValues(new Uint8Array(3)).join('.')}`,
		email: `guard-${crypto.randomUUID()}@example.test`,
		turnstileToken: 'token',
		...overrides
	});

	function guard(deps: Partial<AuthGuardDeps> = {}) {
		return createAuthGuard({
			env: serverEnv(),
			verifyTurnstile: passing,
			log: () => undefined,
			...deps
		});
	}

	it('passes unguarded paths and requests without a usable IP (shared bucket)', async () => {
		expect(await guard()({ path: '/get-session', ip: null })).toEqual({ ok: true });
		expect(await guard()(input({ ip: null }))).toEqual({ ok: true });
		expect(await guard()(input({ ip: 'not-an-ip' }))).toEqual({ ok: true });
	});

	it('maps limits, outages and Turnstile failures', async () => {
		const cases: [Partial<AuthGuardDeps>, Record<string, unknown>, Record<string, unknown>][] = [
			[{ rateLimit: async () => ({ ok: false, reason: 'limited' }) }, {}, { status: 429, code: 'RATE_LIMITED', retryAfter: 60 }],
			[{ rateLimit: async () => ({ ok: false, reason: 'unavailable' }) }, {}, { status: 503, code: 'RATE_LIMIT_UNAVAILABLE' }],
			[{ windowLimit: async () => ({ ok: false, reason: 'limited', retryAfter: 7 }) }, {}, { status: 429, code: 'RATE_LIMITED', retryAfter: 7 }],
			[{ windowLimit: async () => ({ ok: false, reason: 'unavailable' }) }, {}, { status: 503, code: 'RATE_LIMIT_UNAVAILABLE' }],
			[{}, { path: '/change-email', userId: 'not a valid id!' }, { status: 503, code: 'RATE_LIMIT_UNAVAILABLE' }],
			[{}, { turnstileToken: null }, { status: 400, code: 'TURNSTILE_REQUIRED' }],
			[{ verifyTurnstile: async () => ({ ok: false, reason: 'unavailable' }) }, {}, { status: 503, code: 'TURNSTILE_UNAVAILABLE' }],
			[{ verifyTurnstile: async () => ({ ok: false, reason: 'missing' }) }, {}, { status: 400, code: 'TURNSTILE_REQUIRED' }],
			[{ verifyTurnstile: async () => ({ ok: false, reason: 'hostname' }) }, {}, { status: 403, code: 'TURNSTILE_FAILED' }]
		];
		for (const [deps, overrides, expected] of cases) {
			expect(await guard(deps)(input(overrides)), JSON.stringify(expected)).toEqual({
				ok: false,
				...expected
			});
		}
	});

	it('a KV salt failure is RATE_LIMIT_UNAVAILABLE, and denials log codes only', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const base = serverEnv();
		const failing = createAuthGuard({
			env: {
				...base,
				config: {
					get: async () => {
						throw new Error('kv down');
					},
					put: async () => undefined
				} as never
			},
			verifyTurnstile: passing
		});
		const request = input();
		expect(await failing(request)).toEqual({
			ok: false,
			status: 503,
			code: 'RATE_LIMIT_UNAVAILABLE'
		});
		const line = String(warn.mock.calls[0]?.[0]);
		expect(JSON.parse(line)).toEqual({
			event: 'auth_guard.denied',
			group: 'auth.sign-in',
			code: 'RATE_LIMIT_UNAVAILABLE'
		});
		expect(line).not.toContain(request.email);
		expect(line).not.toContain(request.ip);
	});
});

describe('access log capture: skips and failures never throw or leak', () => {
	const KEY = 'k7:integration-access-log-edge-key-0000000000';
	const event = (overrides: Partial<AccessEventLike> = {}): AccessEventLike => ({
		request: { headers: new Headers() },
		route: { id: '/conta' },
		...overrides
	});

	it('without a client IP (header absent, getClientAddress throwing) the record is skipped', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const sent: unknown[] = [];
		const queue = { send: async (body: unknown) => void sent.push(body) };
		const base = { queue, enabled: true, waitUntil: () => undefined, key: KEY, status: 200 };
		await captureAccess(
			event({
				getClientAddress: () => {
					throw new Error('no address');
				}
			}),
			base
		);
		await captureAccess(event(), base);
		expect(sent).toEqual([]);
		expect(error).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
			event: 'access_log.skipped',
			reason: 'no-client-ip'
		});
		await captureAccess(event(), { ...base, enabled: false });
		expect(error).toHaveBeenCalledTimes(2);
	});

	it('queue and key failures are logged by class only', async () => {
		const failures: AccessLogFailure[] = [];
		const base = {
			enabled: true,
			waitUntil: () => undefined,
			status: 200,
			log: (failure: AccessLogFailure) => failures.push(failure)
		};
		const withIp = event({ getClientAddress: () => '203.0.113.5' });
		await captureAccess(withIp, {
			...base,
			key: KEY,
			queue: { send: async () => Promise.reject('not an error') }
		});
		await captureAccess(withIp, { ...base, key: 'k1:short', queue: { send: async () => undefined } });
		expect(failures).toEqual([
			{ event: 'access_log.enqueue_failed', reason: 'unknown' },
			{ event: 'access_log.enqueue_failed', reason: 'Error' }
		]);
		expect(JSON.stringify(failures)).not.toContain('203.0.113.5');
	});

	it('records unmatched routes, a valid port only, and the keyring id', async () => {
		const record = buildAccessRecord(event({ route: { id: null }, getClientAddress: () => ' 198.51.100.2 ' }), {
			status: 404,
			userId: 'u1',
			port: 70_000,
			ts: 1
		});
		expect(record).toMatchObject({ route_group: 'unmatched', port: null, user_id: 'u1' });
		const withPort = buildAccessRecord(
			{ request: { headers: new Headers({ 'cf-connecting-ip': ' 198.51.100.2 ' }) }, route: { id: '/x' } },
			{ status: 200, port: 443, ts: 1 }
		);
		expect(withPort).toMatchObject({ ip: '198.51.100.2', port: 443, user_id: null });
		const sealed = await sealAccessRecord(withPort as AccessRecord, KEY);
		expect(sealed.kid).toBe('k7');
		expect(sealed.ct).not.toContain('198.51.100.2');
	});
});

describe('security headers', () => {
	it('HSTS only for https origins (and never for an unparsable one)', () => {
		expect(securityHeaders({ origin: 'https://example.org', isHtml: true })['strict-transport-security']).toBe(HSTS);
		expect(securityHeaders({ origin: 'http://localhost:4173', isHtml: true })).not.toHaveProperty('strict-transport-security');
		expect(securityHeaders({ origin: 'not a url', isHtml: false })).not.toHaveProperty('strict-transport-security');
		expect(securityHeaders({ origin: 'https://example.org', isHtml: false, crossOriginResourcePolicy: 'cross-origin' })['cross-origin-resource-policy']).toBe('cross-origin');
	});

	it('the static _headers file carries the same set plus frame-ancestors', () => {
		const file = renderStaticHeadersFile();
		const lines = file.trimEnd().split('\n');
		expect(lines[2]).toBe('/*');
		expect(file).toContain(`strict-transport-security: ${HSTS}`);
		expect(file).toContain(`content-security-policy: ${FRAME_ANCESTORS_POLICY}`);
		expect(file).toContain('x-frame-options: DENY');
		expect(file.endsWith('\n')).toBe(true);
	});
});
