// Edge and refusal branches of the auth server modules (src/lib/server/auth*, account/auth-actions)
// that the flow tests do not reach: malformed sessions, throwing access helpers, the SvelteKit
// wrappers, error mapping, the default log sink and e-mail token parsing.
import { setupNetwork } from '@msw/cloudflare';
import { APIError } from 'better-auth/api';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	changeAccountPassword,
	readAuthError,
	requestAccountClosure,
	type AccountAuthApi
} from '#lib/server/account/auth-actions.ts';
import { toAuthLocals } from '#lib/server/auth.ts';
import {
	confirmEmailChange,
	emailLocaleFromRequest,
	readEmailTokenPayload
} from '#lib/server/auth/emails.ts';
import {
	AccessError,
	assertUser,
	assertVerified,
	type AuthLocals
} from '#lib/server/auth/guards.ts';
import { requireUser, requireVerified } from '#lib/server/auth/kit.ts';
import { createAuthLogger, redactLogMessage } from '#lib/server/auth/logger.ts';
import { reduceUserAgent } from '#lib/server/auth/user-agent.ts';
import type { AuthSession, AuthUser } from '#lib/server/types.ts';
import { mockNetwork, Harness } from '../auth/harness.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});
afterEach(() => {
	vi.restoreAllMocks();
});

const NOW = Date.UTC(2026, 9, 16, 12);

function user(overrides: Partial<AuthUser> = {}): AuthUser {
	return {
		id: 'user-1',
		email: 'person@example.com',
		name: 'Person',
		emailVerified: true,
		role: 'user',
		username: null,
		displayUsername: null,
		banned: false,
		twoFactorEnabled: false,
		...overrides
	};
}

function session(overrides: Partial<AuthSession> = {}): AuthSession {
	return {
		id: 'session-1',
		userId: 'user-1',
		createdAt: new Date(NOW),
		expiresAt: new Date(NOW + 86_400_000),
		twoFactorVerifiedAt: null,
		twoFactorVerified: false,
		impersonatedBy: null,
		...overrides
	};
}

const SIGNED_IN: AuthLocals = { user: user(), session: session() };
const ANONYMOUS: AuthLocals = { user: null, session: null };

function thrown(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return null;
}

describe('access helpers (guards.ts, kit.ts)', () => {
	it('assertUser / assertVerified return the pair or throw AccessError with status and code', () => {
		expect(assertUser(SIGNED_IN)).toEqual(SIGNED_IN);
		expect(assertVerified(SIGNED_IN)).toEqual(SIGNED_IN);
		const cases: [AuthLocals, (locals: AuthLocals) => unknown, number, string][] = [
			[ANONYMOUS, assertUser, 401, 'UNAUTHENTICATED'],
			[
				{ user: user(), session: session({ userId: 'someone-else' }) },
				assertUser,
				401,
				'UNAUTHENTICATED'
			],
			[{ user: user({ banned: true }), session: session() }, assertUser, 403, 'BANNED'],
			[
				{ user: user({ emailVerified: false }), session: session() },
				assertVerified,
				403,
				'EMAIL_NOT_VERIFIED'
			],
			[ANONYMOUS, assertVerified, 401, 'UNAUTHENTICATED']
		];
		for (const [locals, check, status, code] of cases) {
			const error = thrown(() => check(locals));
			expect(error, code).toBeInstanceOf(AccessError);
			expect(error).toMatchObject({ name: 'AccessError', status, code, message: code });
		}
	});

	it('requireUser / requireVerified answer with SvelteKit errors (401 / 403)', () => {
		expect(requireUser(SIGNED_IN)).toEqual(SIGNED_IN);
		expect(requireVerified(SIGNED_IN)).toEqual(SIGNED_IN);
		expect(thrown(() => requireUser(ANONYMOUS))).toMatchObject({ status: 401 });
		expect(
			thrown(() => requireUser({ user: user({ banned: true }), session: session() }))
		).toMatchObject({ status: 403 });
		expect(
			thrown(() => requireVerified({ user: user({ emailVerified: false }), session: session() }))
		).toMatchObject({ status: 403 });
	});
});

describe('toAuthLocals', () => {
	const good = {
		user: {
			id: 'u1',
			email: 'a@example.com',
			name: 'A',
			emailVerified: true,
			role: 'admin',
			username: 'nick',
			displayUsername: 'Nick',
			banned: false,
			twoFactorEnabled: true
		},
		session: {
			id: 's1',
			userId: 'u1',
			createdAt: '2026-10-16T12:00:00.000Z',
			expiresAt: new Date(NOW + 1000),
			twoFactorVerifiedAt: NOW,
			impersonatedBy: 'admin-1'
		}
	};

	it('maps a well-formed session, coercing dates and optional fields', () => {
		const mapped = toAuthLocals(good);
		expect(mapped?.user).toMatchObject({ role: 'admin', twoFactorEnabled: true, username: 'nick' });
		expect(mapped?.session.createdAt.toISOString()).toBe('2026-10-16T12:00:00.000Z');
		expect(mapped?.session.twoFactorVerified).toBe(true);
		expect(mapped?.session.impersonatedBy).toBe('admin-1');
		const plain = toAuthLocals({
			user: { ...good.user, name: 42, role: 'owner', username: '', emailVerified: 'yes' },
			session: { ...good.session, twoFactorVerifiedAt: 'not a date', impersonatedBy: null }
		});
		expect(plain?.user).toMatchObject({
			name: '',
			role: 'user',
			username: null,
			emailVerified: false
		});
		expect(plain?.session).toMatchObject({ twoFactorVerifiedAt: null, twoFactorVerified: false });
	});

	it('returns null for anything malformed', () => {
		for (const value of [
			null,
			'string',
			{},
			{ user: good.user },
			{ session: good.session },
			{ user: { ...good.user, id: '' }, session: good.session },
			{ user: { ...good.user, email: 7 }, session: good.session },
			{ user: good.user, session: { ...good.session, id: '' } },
			{ user: good.user, session: { ...good.session, createdAt: 'never' } },
			{ user: good.user, session: { ...good.session, expiresAt: undefined } },
			{ user: good.user, session: { ...good.session, userId: 'u2' } }
		]) {
			expect(toAuthLocals(value)).toBeNull();
		}
	});
});

describe('reduceUserAgent', () => {
	it('keeps browser family and OS only', () => {
		const cases: [string | null | undefined, string][] = [
			[null, ''],
			[undefined, ''],
			['', ''],
			[
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0',
				'Edge on Windows'
			],
			['Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/128.0', 'Firefox on Linux'],
			[
				'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1',
				'Safari on iOS'
			],
			[
				'Mozilla/5.0 (Linux; Android 14) SamsungBrowser/24.0 Chrome/117.0 Mobile Safari/537.36',
				'Samsung Internet on Android'
			],
			['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/120.0 Safari/537.36', 'Chrome on ChromeOS'],
			['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) OPR/105.0', 'Opera on macOS'],
			['curl/8.0', 'Other on Other']
		];
		for (const [agent, expected] of cases)
			expect(reduceUserAgent(agent), String(agent)).toBe(expected);
		expect(reduceUserAgent(`${'x'.repeat(600)} Firefox/1.0 Linux`)).toBe('Other on Other');
	});
});

describe('auth logger', () => {
	it('default sink: errors to console.error, the rest to console.warn, without personal data', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const logger = createAuthLogger();
		expect(logger.level).toBe('warn');
		logger.log(
			'error',
			'failed for person@example.com from 203.0.113.9',
			new TypeError('x'),
			'extra'
		);
		logger.log('warn', 'plain message');
		logger.log(
			'info',
			'token abcdefghijklmnopqrstuvwxyz0123456789',
			Object.assign(new Error('y'), { name: '' })
		);
		expect(error).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledTimes(2);
		const first = JSON.parse(String(error.mock.calls[0]?.[0])) as Record<string, unknown>;
		expect(first).toEqual({
			event: 'better_auth.log',
			level: 'error',
			message: 'failed for [email] from [ip]',
			errors: ['TypeError']
		});
		const second = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
		expect(second).not.toHaveProperty('errors');
		const third = JSON.parse(String(warn.mock.calls[1]?.[0])) as Record<string, unknown>;
		expect(third).toMatchObject({ message: 'token [redacted]', errors: ['Error'] });
		expect(redactLogMessage('https://x.example/a?b=c and 2001:db8::1')).toBe('[url] and [ip]');
		// Long prose is cut at 200 characters (a long unbroken run is redacted as a possible token).
		expect(redactLogMessage('word '.repeat(60))).toHaveLength(200);
	});
});

describe('e-mail helpers of the auth flows', () => {
	function jwtWith(payload: unknown): string {
		const encoded = btoa(JSON.stringify(payload))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		return `header.${encoded}.signature`;
	}

	it('reads the change-email payload and ignores broken tokens', () => {
		expect(readEmailTokenPayload(jwtWith({ email: 'a@x.test', updateTo: 'b@x.test' }))).toEqual({
			email: 'a@x.test',
			updateTo: 'b@x.test'
		});
		expect(readEmailTokenPayload(jwtWith({ email: 3, updateTo: null }))).toEqual({});
		expect(readEmailTokenPayload(jwtWith(5))).toEqual({});
		expect(readEmailTokenPayload('no-dots')).toEqual({});
		expect(readEmailTokenPayload('a.%%%.c')).toEqual({});
		expect(readEmailTokenPayload(`a.${btoa('{not json')}.c`)).toEqual({});
	});

	it('picks the locale from oa_lang, then Accept-Language, then pt-BR', () => {
		const request = (headers: Record<string, string>) =>
			new Request('https://example.org/', { headers });
		expect(emailLocaleFromRequest(undefined)).toBe('pt-BR');
		expect(emailLocaleFromRequest(null)).toBe('pt-BR');
		expect(emailLocaleFromRequest(request({ cookie: 'a=1; oa_lang=en-US' }))).toBe('en-US');
		expect(emailLocaleFromRequest(request({ 'accept-language': 'en-US,en;q=0.9' }))).toBe('en-US');
		expect(emailLocaleFromRequest(request({}))).toBe('pt-BR');
	});

	it('renders the current-address confirmation with and without a name, in both locales', () => {
		const origin = 'https://example.org';
		const url = 'https://example.org/api/auth/verify-email?token=t';
		const named = confirmEmailChange('en-US', { origin, url, name: 'Ana <b>' });
		expect(named.text).toContain('Hi Ana');
		expect(named.html).toContain('Ana &lt;b&gt;');
		expect(named.html).not.toContain('Ana <b>');
		expect(confirmEmailChange('en-US', { origin, url }).text).toContain('Hi,');
		const pt = confirmEmailChange('pt-BR', { origin, url, name: null });
		expect(pt.text).toContain('Olá.');
		expect(pt.subject).not.toBe(named.subject);
		expect(() => confirmEmailChange('pt-BR', { origin, url: 'javascript:alert(1)' })).toThrow();
	});
});

describe('account auth actions: error mapping', () => {
	const input = {
		currentPassword: 'current password 1',
		newPassword: 'brand new password 2',
		confirmPassword: 'brand new password 2',
		revokeOtherSessions: false
	};

	function apiThrowing(error: unknown): AccountAuthApi {
		const reject = async () => {
			throw error;
		};
		return {
			changePassword: reject,
			changeEmail: reject,
			deleteUser: reject
		} as unknown as AccountAuthApi;
	}

	it('reads code, status and Retry-After from APIErrors only', () => {
		expect(readAuthError(new Error('plain'))).toBeNull();
		expect(readAuthError('string')).toBeNull();
		expect(
			readAuthError(
				new APIError(
					'TOO_MANY_REQUESTS',
					{ code: 'RATE_LIMITED', message: 'x' },
					{ 'Retry-After': '30' }
				)
			)
		).toEqual({ code: 'RATE_LIMITED', status: 429, retryAfter: 30 });
		expect(
			readAuthError(new APIError('BAD_REQUEST', undefined, new Headers({ 'retry-after': 'soon' })))
		).toEqual({ code: 'AUTH_ERROR', status: 400 });
		expect(readAuthError(new APIError('FORBIDDEN'))).toMatchObject({ status: 403 });
	});

	it('maps INVALID_PASSWORD to wrong-password, passes other codes, rethrows non-API errors', async () => {
		const headers = new Headers();
		expect(
			await changeAccountPassword(
				apiThrowing(new APIError('BAD_REQUEST', { code: 'INVALID_PASSWORD', message: 'x' })),
				headers,
				input
			)
		).toEqual({ ok: false, code: 'wrong-password', status: 400 });
		expect(
			await changeAccountPassword(
				apiThrowing(new APIError('UNAUTHORIZED', { code: 'SESSION_EXPIRED', message: 'x' })),
				headers,
				input
			)
		).toEqual({ ok: false, code: 'SESSION_EXPIRED', status: 401 });
		await expect(
			changeAccountPassword(apiThrowing(new TypeError('network')), headers, input)
		).rejects.toThrow('network');
	});

	it('closure is refused before Better Auth without a valid mode, the box or a password', async () => {
		const api = apiThrowing(new Error('must not be called'));
		const base = {
			db: env.DB,
			userId: 'nobody',
			password: 'x',
			mode: 'anonymize' as const,
			acknowledged: true,
			now: NOW
		};
		expect(
			await requestAccountClosure(api, new Headers(), { ...base, mode: 'bogus' as never })
		).toEqual({ ok: false, code: 'invalid-mode', status: 400 });
		expect(
			await requestAccountClosure(api, new Headers(), { ...base, acknowledged: false })
		).toEqual({
			ok: false,
			code: 'not-acknowledged',
			status: 400
		});
		expect(await requestAccountClosure(api, new Headers(), { ...base, password: '' })).toEqual({
			ok: false,
			code: 'wrong-password',
			status: 400
		});
	});
});

describe('auth hooks: origin from Referer', () => {
	it('accepts a same-origin Referer when Origin is absent and refuses a broken or foreign one', async () => {
		network.resetHandlers();
		mockNetwork(network);
		const h = new Harness();
		const client = h.client();
		const sameSite = await client.post(
			'/revoke-other-sessions',
			{},
			{ origin: null, headers: { referer: `${h.origin}/conta` } }
		);
		// Past the origin check: refused only for having no session.
		expect(sameSite.status).toBe(401);
		for (const referer of ['not a url', 'https://evil.example/conta']) {
			const response = await client.post(
				'/revoke-other-sessions',
				{},
				{
					origin: null,
					headers: { referer }
				}
			);
			expect(response.status, referer).toBe(403);
		}
		const nullOrigin = await client.post('/revoke-other-sessions', {}, { origin: 'null' });
		expect(nullOrigin.status).toBe(403);
	});
});
