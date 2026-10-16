// Access rules of the account area: owner only, anonymous → 401 (pages redirect to /entrar),
// verified e-mail for profile actions, banned accounts refused, same-origin endpoints.
import { describe, expect, it } from 'vitest';
import { accountAccess, isSameOriginRequest, signInRedirect } from '#lib/server/account/access.ts';
import { ANONYMOUS, authSession, authUser } from './helpers.ts';

const USER = { id: 'user-access', email: 'access@example.com', username: null };

describe('accountAccess', () => {
	it('anonymous → 401', () => {
		expect(accountAccess(ANONYMOUS)).toEqual({ ok: false, status: 401, code: 'UNAUTHENTICATED' });
		expect(accountAccess(ANONYMOUS, true)).toMatchObject({ ok: false, status: 401 });
	});

	it('a session of another user does not count', () => {
		const result = accountAccess({
			user: authUser(USER),
			session: authSession('someone-else', 'session-x')
		});
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('banned → 403', () => {
		const result = accountAccess({
			user: authUser(USER, { banned: true }),
			session: authSession(USER.id, 'session-b')
		});
		expect(result).toEqual({ ok: false, status: 403, code: 'BANNED' });
	});

	it('unverified users may open /conta but not the profile actions', () => {
		const locals = {
			user: authUser(USER, { emailVerified: false }),
			session: authSession(USER.id, 'session-u')
		};
		expect(accountAccess(locals)).toMatchObject({ ok: true, user: { id: USER.id } });
		expect(accountAccess(locals, true)).toEqual({
			ok: false,
			status: 403,
			code: 'EMAIL_NOT_VERIFIED'
		});
	});

	it('the owner gets their own user and session', () => {
		const locals = { user: authUser(USER), session: authSession(USER.id, 'session-ok') };
		expect(accountAccess(locals, true)).toEqual({ ok: true, ...locals });
	});
});

describe('signInRedirect', () => {
	it('carries same-site paths only', () => {
		expect(signInRedirect()).toBe('/entrar?next=%2Fconta');
		expect(signInRedirect('/conta')).toBe('/entrar?next=%2Fconta');
		expect(signInRedirect('//evil.example/x')).toBe('/entrar?next=%2F');
		expect(signInRedirect('https://evil.example')).toBe('/entrar?next=%2F');
		expect(signInRedirect('/\\evil.example')).toBe('/entrar?next=%2F');
	});
});

describe('isSameOriginRequest', () => {
	const ORIGIN = 'https://open-auri.example';
	const post = (headers: Record<string, string>) =>
		new Request(`${ORIGIN}/conta/exportar`, { method: 'POST', headers });

	it('accepts the public origin, or Sec-Fetch-Site same-origin without an Origin header', () => {
		expect(isSameOriginRequest(post({ origin: ORIGIN }), ORIGIN)).toBe(true);
		expect(isSameOriginRequest(post({ 'sec-fetch-site': 'same-origin' }), ORIGIN)).toBe(true);
	});

	it('refuses other origins, opaque origins and requests with no evidence', () => {
		expect(isSameOriginRequest(post({ origin: 'https://evil.example' }), ORIGIN)).toBe(false);
		expect(isSameOriginRequest(post({ origin: `${ORIGIN}.evil.example` }), ORIGIN)).toBe(false);
		expect(isSameOriginRequest(post({ origin: 'null' }), ORIGIN)).toBe(false);
		expect(isSameOriginRequest(post({ 'sec-fetch-site': 'same-site' }), ORIGIN)).toBe(false);
		expect(isSameOriginRequest(post({ 'sec-fetch-site': 'cross-site' }), ORIGIN)).toBe(false);
		expect(isSameOriginRequest(post({}), ORIGIN)).toBe(false);
		// An Origin header wins over Sec-Fetch-Site.
		expect(
			isSameOriginRequest(
				post({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }),
				ORIGIN
			)
		).toBe(false);
	});
});
