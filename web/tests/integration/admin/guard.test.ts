// /admin guard (T3.8): 404 unless an effective admin (role + 2FA marker when required), fresh
// session for destructive actions, TOTP re-authentication.
import { setupNetwork } from '@msw/cloudflare';
import type { RateLimit } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAudit } from '#lib/server/admin/audit.ts';
import { REAUTH_REQUIRED, requireAdmin } from '#lib/server/admin/guard.ts';
import { normalizeTotp, reauthenticate } from '#lib/server/admin/reauth.ts';
import { FRESH_SESSION_MS } from '#lib/server/auth/session-policy.ts';
import { account, adminRequest, enableTotp, harness, localsOf, totpCode } from './helpers.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

const allow: RateLimit = { limit: async () => ({ success: true }) };
const deny: RateLimit = { limit: async () => ({ success: false }) };
const broken: RateLimit = {
	limit: async () => {
		throw new Error('limiter down');
	}
};

describe('requireAdmin', () => {
	it('answers 404 to anonymous visitors and non-admins', async () => {
		const h = harness(network, { admin2faRequired: true });
		const request = adminRequest(h);
		expect(
			await requireAdmin({ user: null, session: null }, h.env, { request, rawEnv: {} })
		).toEqual({ ok: false, status: 404, reason: 'not_admin' });

		const user = await account(h, 'plain');
		const locals = await localsOf(user.client);
		for (const destructive of [false, true]) {
			expect(await requireAdmin(locals, h.env, { request, rawEnv: {}, destructive })).toMatchObject(
				{ ok: false, status: 404 }
			);
		}
	});

	it('answers 404 to an admin without the 2FA marker when ADMIN_2FA_REQUIRED is on', async () => {
		const h = harness(network, { admin2faRequired: true });
		const admin = await account(h, 'no2fa', true);
		const locals = await localsOf(admin.client);
		expect(locals.user.role).toBe('admin');
		const result = await requireAdmin(locals, h.env, { request: adminRequest(h), rawEnv: {} });
		expect(result).toEqual({ ok: false, status: 404, reason: 'not_admin' });

		// Same session without the requirement: allowed (the flag is what hides it).
		const relaxed = await requireAdmin(
			locals,
			{ flags: { ...h.env.flags, admin2faRequired: false } },
			{ request: adminRequest(h), rawEnv: {} }
		);
		expect(relaxed).toMatchObject({ ok: true, accessConfigured: false });
	});

	it('lets an admin with the 2FA marker in, and banned admins never', async () => {
		const h = harness(network, { admin2faRequired: true });
		const admin = await account(h, 'with2fa', true);
		await enableTotp(h, admin.client);
		const locals = await localsOf(admin.client);
		const result = await requireAdmin(locals, h.env, { request: adminRequest(h), rawEnv: {} });
		expect(result).toMatchObject({ ok: true, accessConfigured: false });
		if (result.ok) expect(result.user.id).toBe(admin.id);

		const banned = { ...locals, user: { ...locals.user, banned: true } };
		expect(
			await requireAdmin(banned, h.env, { request: adminRequest(h), rawEnv: {} })
		).toMatchObject({ ok: false, status: 404 });
		const impersonated = { ...locals, session: { ...locals.session, impersonatedBy: 'x' } };
		expect(
			await requireAdmin(impersonated, h.env, { request: adminRequest(h), rawEnv: {} })
		).toMatchObject({ ok: false, status: 404 });
	});

	it('requires a fresh session for destructive actions only', async () => {
		const h = harness(network, { admin2faRequired: true });
		const admin = await account(h, 'stale', true);
		await enableTotp(h, admin.client);
		const locals = await localsOf(admin.client);
		const later = Date.now() + FRESH_SESSION_MS + 60_000;
		const options = { request: adminRequest(h), rawEnv: {}, now: later };

		expect(await requireAdmin(locals, h.env, { ...options, destructive: false })).toMatchObject({
			ok: true
		});
		expect(await requireAdmin(locals, h.env, { ...options, destructive: true })).toEqual({
			ok: false,
			status: 403,
			reason: 'stale',
			code: REAUTH_REQUIRED
		});
		expect(
			await requireAdmin(locals, h.env, { request: adminRequest(h), rawEnv: {}, destructive: true })
		).toMatchObject({ ok: true });
	});
});

describe('re-authentication', () => {
	it('normalizes typed codes', () => {
		expect(normalizeTotp('123 456')).toBe('123456');
		expect(normalizeTotp('123-456')).toBe('123456');
		expect(normalizeTotp('12345')).toBeNull();
		expect(normalizeTotp(null)).toBeNull();
	});

	it('refreshes the 2FA marker with a valid TOTP code and audits every attempt', async () => {
		const h = harness(network, { admin2faRequired: true });
		const admin = await account(h, 'reauth', true);
		const secret = await enableTotp(h, admin.client);
		const before = (await localsOf(admin.client)).session.twoFactorVerifiedAt;
		expect(before).toBeInstanceOf(Date);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const deps = {
			db: env.DB,
			auth: h.auth,
			headers: admin.client.headers(),
			rateLimit: allow,
			user: { id: admin.id, twoFactorEnabled: true }
		};
		expect(await reauthenticate(deps, '000000')).toEqual({ ok: false, code: 'INVALID_CODE' });
		expect(await reauthenticate(deps, 'garbage')).toEqual({ ok: false, code: 'INVALID_CODE' });
		expect(await reauthenticate(deps, await totpCode(h, secret))).toEqual({ ok: true });

		const after = (await localsOf(admin.client)).session.twoFactorVerifiedAt;
		expect(after?.getTime()).toBeGreaterThan(before?.getTime() ?? Number.POSITIVE_INFINITY);

		const trail = await listAudit(env.DB, { targetId: admin.id });
		const results = trail.rows
			.filter((row) => row.action === 'admin.reauth')
			.map((row) => row.detail?.result);
		expect(results.sort()).toEqual(['invalid', 'invalid', 'ok']);
	});

	it('is rate limited (fail closed) and points admins without 2FA to a new sign-in', async () => {
		const h = harness(network, { admin2faRequired: false });
		const admin = await account(h, 'reauthrl', true);
		const base = {
			db: env.DB,
			auth: h.auth,
			headers: admin.client.headers(),
			user: { id: admin.id, twoFactorEnabled: true }
		};
		expect(await reauthenticate({ ...base, rateLimit: deny }, '123456')).toEqual({
			ok: false,
			code: 'RATE_LIMITED'
		});
		expect(await reauthenticate({ ...base, rateLimit: broken }, '123456')).toEqual({
			ok: false,
			code: 'RATE_LIMITED'
		});
		expect(
			await reauthenticate(
				{ ...base, rateLimit: allow, user: { id: admin.id, twoFactorEnabled: false } },
				'123456'
			)
		).toEqual({ ok: false, code: 'NO_SECOND_FACTOR' });
	});
});
