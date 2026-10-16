// Admin 2FA session marker, isAdminEffective, freshness helper and access helpers.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	FRESH_SESSION_MS,
	isAdminEffective,
	isFreshSession,
	requireFreshSession,
	StaleSessionError,
	toAuthLocals
} from '#lib/server/auth.ts';
import { checkUser, checkVerified } from '#lib/server/auth/guards.ts';
import type { AuthSession, AuthUser } from '#lib/server/types.ts';
import {
	createVerifiedUser,
	Harness,
	mockNetwork,
	PASSWORD,
	signedIn,
	totpSecretFromUri,
	uniqueEmail,
	type Client
} from './harness.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

function harness(overrides: ConstructorParameters<typeof Harness>[0] = {}): Harness {
	network.resetHandlers();
	mockNetwork(network);
	return new Harness(overrides);
}

async function locals(client: Client) {
	const current = toAuthLocals(await client.session());
	if (!current) throw new Error('not signed in');
	return current;
}

async function makeAdmin(email: string): Promise<void> {
	await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE email = ?`).bind(email).run();
}

async function totpCode(h: Harness, secret: string): Promise<string> {
	const { code } = await h.auth.api.generateTOTP({ body: { secret } });
	return code;
}

/** Enables TOTP for the signed-in client; returns the raw secret and the backup codes. */
async function enableTotp(
	h: Harness,
	client: Client
): Promise<{ secret: string; backupCodes: string[] }> {
	const enabled = await client.post('/two-factor/enable', { password: PASSWORD });
	expect(enabled.status).toBe(200);
	const body = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
	const secret = totpSecretFromUri(body.totpURI);
	const verified = await client.post('/two-factor/verify-totp', {
		code: await totpCode(h, secret)
	});
	expect(verified.status).toBe(200);
	return { secret, backupCodes: body.backupCodes };
}

describe('admin 2FA marker', () => {
	it('makes the admin role effective only after 2FA is verified in the session', async () => {
		const h = harness({ admin2faRequired: true });
		const email = uniqueEmail('admin');
		await createVerifiedUser(h, email);
		await makeAdmin(email);
		const client = await signedIn(h, email);

		const before = await locals(client);
		expect(before.user.role).toBe('admin');
		expect(before.session.twoFactorVerified).toBe(false);
		expect(isAdminEffective(before.session, before.user, h.env)).toBe(false);
		expect(
			isAdminEffective(before.session, before.user, { flags: { admin2faRequired: false } })
		).toBe(true);

		const { backupCodes } = await enableTotp(h, client);
		const after = await locals(client);
		expect(after.user.twoFactorEnabled).toBe(true);
		expect(after.session.twoFactorVerifiedAt).toBeInstanceOf(Date);
		expect(isAdminEffective(after.session, after.user, h.env)).toBe(true);

		// A new sign-in starts without the marker and gets it from the second factor.
		const second = h.client();
		const challenge = await second.signIn(email);
		expect(challenge.status).toBe(200);
		expect(((await challenge.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(
			true
		);
		expect(await second.session()).toBeNull();
		const backup = await second.post('/two-factor/verify-backup-code', {
			code: backupCodes[0]
		});
		expect(backup.status).toBe(200);
		const viaBackup = await locals(second);
		expect(viaBackup.session.twoFactorVerified).toBe(true);
		expect(isAdminEffective(viaBackup.session, viaBackup.user, h.env)).toBe(true);
	});

	it('marks a challenged sign-in verified through TOTP', async () => {
		const h = harness({ admin2faRequired: true });
		const email = uniqueEmail('admin-totp');
		await createVerifiedUser(h, email);
		await makeAdmin(email);
		const { secret } = await enableTotp(h, await signedIn(h, email));

		const client = h.client();
		await client.signIn(email);
		const wrong = await client.post('/two-factor/verify-totp', { code: '000000' });
		expect(wrong.status).toBe(401);
		expect(await client.session()).toBeNull();
		const ok = await client.post('/two-factor/verify-totp', { code: await totpCode(h, secret) });
		expect(ok.status).toBe(200);
		const current = await locals(client);
		expect(isAdminEffective(current.session, current.user, h.env)).toBe(true);
	});

	it('cannot be set by the client', async () => {
		const h = harness({ admin2faRequired: true });
		const email = uniqueEmail('admin-forge');
		await createVerifiedUser(h, email);
		await makeAdmin(email);
		const client = await signedIn(h, email);
		const forged = await client.post('/update-session', {
			twoFactorVerifiedAt: new Date().toISOString()
		});
		expect(forged.ok).toBe(false);
		const forgedUser = await client.post('/update-user', { twoFactorEnabled: true });
		expect(forgedUser.ok).toBe(false);
		const current = await locals(client);
		expect(current.session.twoFactorVerified).toBe(false);
		expect(current.user.twoFactorEnabled).toBe(false);
		expect(isAdminEffective(current.session, current.user, h.env)).toBe(false);
	});

	it('never applies to non-admins, banned admins or impersonation sessions', () => {
		const session = { createdAt: new Date(), twoFactorVerifiedAt: new Date() };
		const flags = { flags: { admin2faRequired: true } };
		const admin = { role: 'admin', twoFactorEnabled: true, banned: false };
		expect(isAdminEffective(session, admin, flags)).toBe(true);
		expect(isAdminEffective(session, { ...admin, role: 'user' }, flags)).toBe(false);
		expect(isAdminEffective(session, { ...admin, banned: true }, flags)).toBe(false);
		expect(isAdminEffective(session, { ...admin, twoFactorEnabled: false }, flags)).toBe(false);
		expect(isAdminEffective({ ...session, impersonatedBy: 'x' }, admin, flags)).toBe(false);
		expect(isAdminEffective(null, admin, flags)).toBe(false);
	});
});

describe('freshness helper', () => {
	const now = Date.UTC(2026, 9, 16, 12, 0, 0);

	it('accepts a session created or 2FA-verified in the last 10 minutes', () => {
		expect(FRESH_SESSION_MS).toBe(600_000);
		expect(isFreshSession({ createdAt: new Date(now - 60_000) }, FRESH_SESSION_MS, now)).toBe(true);
		expect(isFreshSession({ createdAt: new Date(now - 11 * 60_000) }, FRESH_SESSION_MS, now)).toBe(
			false
		);
		expect(
			isFreshSession(
				{
					createdAt: new Date(now - 3_600_000),
					twoFactorVerifiedAt: new Date(now - 120_000).toISOString()
				},
				FRESH_SESSION_MS,
				now
			)
		).toBe(true);
		expect(isFreshSession({ createdAt: 'not a date' }, FRESH_SESSION_MS, now)).toBe(false);
		expect(isFreshSession(null, FRESH_SESSION_MS, now)).toBe(false);
	});

	it('throws a typed error when stale', () => {
		expect(() =>
			requireFreshSession({ createdAt: now - 3_600_000 }, FRESH_SESSION_MS, now)
		).toThrow(StaleSessionError);
		expect(() =>
			requireFreshSession({ createdAt: now - 1_000 }, FRESH_SESSION_MS, now)
		).not.toThrow();
	});

	it('is fresh right after sign-in', async () => {
		const h = harness();
		const email = uniqueEmail('fresh');
		await createVerifiedUser(h, email);
		const current = await locals(await signedIn(h, email));
		expect(isFreshSession(current.session)).toBe(true);
	});
});

describe('access helpers (requireUser / requireVerified core)', () => {
	const user: AuthUser = {
		id: 'u1',
		email: 'a@example.com',
		name: 'A',
		emailVerified: true,
		role: 'user',
		username: null,
		displayUsername: null,
		banned: false,
		twoFactorEnabled: false
	};
	const session: AuthSession = {
		id: 's1',
		userId: 'u1',
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 60_000),
		twoFactorVerifiedAt: null,
		twoFactorVerified: false,
		impersonatedBy: null
	};

	it('maps signed-out, unverified and banned users to 401/403', () => {
		expect(checkUser({ user: null, session: null })).toEqual({
			ok: false,
			status: 401,
			code: 'UNAUTHENTICATED'
		});
		expect(checkVerified({ user: { ...user, emailVerified: false }, session })).toEqual({
			ok: false,
			status: 403,
			code: 'EMAIL_NOT_VERIFIED'
		});
		expect(checkUser({ user: { ...user, banned: true }, session })).toMatchObject({
			ok: false,
			status: 403,
			code: 'BANNED'
		});
		expect(checkUser({ user, session: { ...session, userId: 'other' } })).toMatchObject({
			status: 401
		});
		expect(checkVerified({ user, session })).toMatchObject({ ok: true });
	});

	it('accepts a real verified session', async () => {
		const h = harness();
		const email = uniqueEmail('helpers');
		await createVerifiedUser(h, email);
		const current = await locals(await signedIn(h, email));
		expect(checkVerified(current)).toMatchObject({ ok: true });
		expect(current.session).not.toHaveProperty('token');
	});
});
