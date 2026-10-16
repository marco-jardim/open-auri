// T4.1b: JSON auth guards (guard.ts).
import { describe, expect, it } from 'vitest';
import { apiAdmin, apiOwner, apiUser, apiVerified } from '#lib/server/api/index.ts';
import {
	adminLocals,
	expectApiError,
	localsOf,
	serverEnv,
	signedOut,
	staleSession
} from './helpers.ts';

const request = new Request('https://auri.example/api/v1/admin/x');

describe('apiUser', () => {
	it('returns the principal of a signed-in user', () => {
		const locals = localsOf({ emailVerified: false });
		expect(apiUser(locals)).toEqual(locals);
	});

	it('401 AUTH_REQUIRED when signed out or the session belongs to someone else', async () => {
		await expectApiError(() => apiUser(signedOut()), 401, 'AUTH_REQUIRED');
		const locals = localsOf();
		await expectApiError(
			() => apiUser({ user: locals.user, session: { ...locals.session, userId: 'other' } }),
			401,
			'AUTH_REQUIRED'
		);
	});

	it('403 BANNED for a banned account', async () => {
		await expectApiError(() => apiUser(localsOf({ banned: true })), 403, 'BANNED');
	});
});

describe('apiVerified', () => {
	it('returns the principal of a verified user', () => {
		const locals = localsOf();
		expect(apiVerified(locals)).toEqual(locals);
	});

	it('401 / 403 EMAIL_NOT_VERIFIED / 403 BANNED', async () => {
		await expectApiError(() => apiVerified(signedOut()), 401, 'AUTH_REQUIRED');
		await expectApiError(
			() => apiVerified(localsOf({ emailVerified: false })),
			403,
			'EMAIL_NOT_VERIFIED'
		);
		await expectApiError(
			() => apiVerified(localsOf({ emailVerified: false, banned: true })),
			403,
			'BANNED'
		);
	});
});

describe('apiOwner', () => {
	it('passes for the owner and hides other resources as 404 NOT_FOUND', async () => {
		const locals = localsOf();
		expect(apiOwner(locals, locals.user.id)).toEqual(locals);
		await expectApiError(() => apiOwner(locals, 'someone-else'), 404, 'NOT_FOUND');
		await expectApiError(() => apiOwner(locals, null), 404, 'NOT_FOUND');
		await expectApiError(() => apiOwner(signedOut(), 'x'), 401, 'AUTH_REQUIRED');
		await expectApiError(() => apiOwner(localsOf({ banned: true }), 'x'), 403, 'BANNED');
	});
});

describe('apiAdmin', () => {
	const env = serverEnv();

	it('returns the admin principal', async () => {
		const locals = adminLocals();
		expect(await apiAdmin(locals, env, request, {})).toEqual(locals);
		expect(await apiAdmin(locals, env, request, {}, { destructive: true })).toEqual(locals);
	});

	it('404 NOT_FOUND for signed-out users, non-admins and admins without the 2FA marker', async () => {
		await expectApiError(() => apiAdmin(signedOut(), env, request, {}), 404, 'NOT_FOUND');
		await expectApiError(() => apiAdmin(localsOf(), env, request, {}), 404, 'NOT_FOUND');
		const no2fa = localsOf({ role: 'admin', twoFactorEnabled: true });
		const strict = { flags: { ...env.flags, admin2faRequired: true } };
		await expectApiError(() => apiAdmin(no2fa, strict, request, {}), 404, 'NOT_FOUND');
		await expectApiError(
			() => apiAdmin(adminLocals({ impersonatedBy: 'admin-x' }), env, request, {}),
			404,
			'NOT_FOUND'
		);
	});

	it('403 REAUTH_REQUIRED for destructive actions on a stale session', async () => {
		const locals = adminLocals(staleSession());
		expect(await apiAdmin(locals, env, request, {})).toEqual(locals);
		await expectApiError(
			() => apiAdmin(locals, env, request, {}, { destructive: true }),
			403,
			'REAUTH_REQUIRED'
		);
	});
});
