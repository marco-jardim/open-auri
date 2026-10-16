// End-to-end auth flows against `auth.handler(request)` with local D1, mocked Resend and
// Turnstile: sign-up (switch on/off), verification, sign-in/out, uniform errors, reset (single
// use, expiry, session revocation), change e-mail, change password, delete, ban.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POLICY_VERSION } from '#lib/content/legal/version.ts';
import { recordAcceptance } from '#lib/server/legal/acceptance.ts';
import {
	createVerifiedUser,
	errorCode,
	Harness,
	linkOf,
	mockNetwork,
	NEW_PASSWORD,
	PASSWORD,
	signedIn,
	uniqueEmail
} from './harness.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
afterAll(async () => {
	await network.disable();
});

function harness(overrides: ConstructorParameters<typeof Harness>[0] = {}): Harness {
	network.resetHandlers();
	mockNetwork(network);
	return new Harness(overrides);
}

async function userRow(email: string) {
	return env.DB.prepare('SELECT id, email, emailVerified, banned FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ id: string; email: string; emailVerified: number; banned: number | null }>();
}

async function sessionCount(userId: string): Promise<number> {
	const row = await env.DB.prepare('SELECT count(*) AS n FROM session WHERE userId = ?')
		.bind(userId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

const TWO_HOURS = 2 * 60 * 60 * 1000;

function jumpAhead(ms: number): void {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.now() + ms);
}

describe('sign-up', () => {
	it('answers 403 SIGNUP_DISABLED when SIGNUP_ENABLED=false and creates nothing', async () => {
		const h = harness({ signupEnabled: false });
		const email = uniqueEmail('closed');
		const response = await h.client().signUp(email);
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe('SIGNUP_DISABLED');
		expect(await userRow(email)).toBeNull();
		await h.flush();
		expect(h.mails(email)).toHaveLength(0);
	});

	it('creates an unverified user and sends the verification e-mail when enabled', async () => {
		const h = harness();
		const email = uniqueEmail('open');
		const response = await h.client().signUp(email);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { token: unknown };
		expect(body.token).toBeNull();
		expect((await userRow(email))?.emailVerified).toBe(0);
		await h.flush();
		const link = linkOf(h.mail(email, 'verify-email'));
		expect(link.origin).toBe(h.origin);
		expect(link.pathname).toBe('/api/auth/verify-email');
	});

	it('answers a duplicate sign-up like a new one, without a second account', async () => {
		const h = harness();
		const email = uniqueEmail('dup');
		await createVerifiedUser(h, email);
		const again = await h.client().signUp(email);
		expect(again.status).toBe(200);
		const fresh = await h.client().signUp(uniqueEmail('dup-fresh'));
		expect(Object.keys((await again.json()) as object).sort()).toEqual(
			Object.keys((await fresh.json()) as object).sort()
		);
		const count = await env.DB.prepare('SELECT count(*) AS n FROM "user" WHERE email = ?')
			.bind(email)
			.first<{ n: number }>();
		expect(count?.n).toBe(1);
	});
});

describe('verification and sign-in', () => {
	it('blocks sign-in until the e-mail is verified, then signs in and out', async () => {
		const h = harness();
		const email = uniqueEmail('verify');
		const client = h.client();
		await client.signUp(email);
		await h.flush();

		const early = await client.signIn(email);
		expect(early.status).toBe(403);
		expect(await errorCode(early)).toBe('EMAIL_NOT_VERIFIED');

		const verified = await h.client().get(linkOf(h.mail(email, 'verify-email')));
		expect(verified.status).toBe(302);
		expect((await userRow(email))?.emailVerified).toBe(1);

		const ok = await client.signIn(email);
		expect(ok.status).toBe(200);
		const current = await client.session();
		expect(current?.user.email).toBe(email);
		expect(current?.session.ipAddress ?? '').toBe('');

		const out = await client.post('/sign-out');
		expect(out.status).toBe(200);
		expect(await client.session()).toBeNull();
		const user = await userRow(email);
		expect(await sessionCount(user?.id ?? '')).toBe(0);
	});

	it('gives the same error for a wrong password and for an unknown e-mail', async () => {
		const h = harness();
		const email = uniqueEmail('wrong');
		await createVerifiedUser(h, email);
		const wrong = await h.client().signIn(email, 'not the password at all');
		const unknown = await h.client().signIn(uniqueEmail('nobody'), 'not the password at all');
		expect(wrong.status).toBe(401);
		expect(unknown.status).toBe(401);
		expect(await wrong.json()).toEqual(await unknown.json());
	});

	it('refuses a banned user', async () => {
		const h = harness();
		const email = uniqueEmail('banned');
		const id = await createVerifiedUser(h, email);
		await env.DB.prepare('UPDATE "user" SET banned = 1 WHERE id = ?').bind(id).run();
		const response = await h.client().signIn(email);
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe('BANNED_USER');
		expect(await sessionCount(id)).toBe(0);
	});
});

describe('password reset', () => {
	it('answers an unknown e-mail exactly like a known one and mails only the known one', async () => {
		const h = harness();
		const known = uniqueEmail('reset-known');
		await createVerifiedUser(h, known);
		const unknown = uniqueEmail('reset-unknown');
		const a = await h.client().post('/request-password-reset', { email: known });
		const b = await h.client().post('/request-password-reset', { email: unknown });
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(await a.json()).toEqual(await b.json());
		await h.flush();
		expect(h.mails(known, 'reset-password')).toHaveLength(1);
		expect(h.mails(unknown)).toHaveLength(0);
	});

	it('resets once with the mailed token, revokes every session and refuses reuse', async () => {
		const h = harness();
		const email = uniqueEmail('reset');
		const id = await createVerifiedUser(h, email);
		const other = await signedIn(h, email);
		expect(await other.session()).not.toBeNull();

		await h.client().post('/request-password-reset', { email });
		await h.flush();
		const link = linkOf(h.mail(email, 'reset-password'));
		expect(link.pathname).toBe('/redefinir-senha');
		const token = link.searchParams.get('token') ?? '';
		expect(token).not.toBe('');

		const reset = await h.client().post('/reset-password', { token, newPassword: NEW_PASSWORD });
		expect(reset.status).toBe(200);
		expect(await sessionCount(id)).toBe(0);
		expect(await other.session()).toBeNull();

		const reuse = await h
			.client()
			.post('/reset-password', { token, newPassword: 'yet another secret 333' });
		expect(reuse.status).toBe(400);
		expect(await errorCode(reuse)).toBe('INVALID_TOKEN');

		expect((await h.client().signIn(email, PASSWORD)).status).toBe(401);
		expect((await h.client().signIn(email, NEW_PASSWORD)).status).toBe(200);
		await h.flush();
		expect(h.mails(email, 'password-changed')).toHaveLength(1);
	});

	it('refuses an expired reset token', async () => {
		const h = harness();
		const email = uniqueEmail('reset-expired');
		await createVerifiedUser(h, email);
		await h.client().post('/request-password-reset', { email });
		await h.flush();
		const token = linkOf(h.mail(email, 'reset-password')).searchParams.get('token') ?? '';
		jumpAhead(TWO_HOURS);
		const response = await h.client().post('/reset-password', { token, newPassword: NEW_PASSWORD });
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe('INVALID_TOKEN');
		vi.useRealTimers();
		expect((await h.client().signIn(email, PASSWORD)).status).toBe(200);
	});

	it('enforces the minimum password length on reset', async () => {
		const h = harness();
		const email = uniqueEmail('reset-short');
		await createVerifiedUser(h, email);
		await h.client().post('/request-password-reset', { email });
		await h.flush();
		const token = linkOf(h.mail(email, 'reset-password')).searchParams.get('token') ?? '';
		const response = await h.client().post('/reset-password', { token, newPassword: 'short1' });
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe('PASSWORD_TOO_SHORT');
	});
});

describe('change e-mail', () => {
	it('confirms on the current address, verifies the new one and notifies the old one', async () => {
		const h = harness();
		const email = uniqueEmail('move-from');
		const target = uniqueEmail('move-to');
		await createVerifiedUser(h, email);
		const client = await signedIn(h, email);

		const response = await client.post('/change-email', { newEmail: target, callbackURL: '/' });
		expect(response.status).toBe(200);
		await h.flush();
		expect(h.mails(target)).toHaveLength(0);
		const confirm = await h.client().get(linkOf(h.mail(email, 'confirm-email-change')));
		expect(confirm.status).toBe(302);
		await h.flush();
		expect(h.mails(email, 'email-change-notice')).toHaveLength(1);
		expect((await userRow(email))?.email).toBe(email);

		const verify = await h.client().get(linkOf(h.mail(target, 'confirm-new-email')));
		expect(verify.status).toBe(302);
		expect(await userRow(email)).toBeNull();
		expect((await userRow(target))?.emailVerified).toBe(1);
	});

	it('answers a taken address exactly like a free one and sends nothing', async () => {
		const h = harness();
		const email = uniqueEmail('collide');
		const taken = uniqueEmail('collide-taken');
		await createVerifiedUser(h, email);
		await createVerifiedUser(h, taken);
		const client = await signedIn(h, email);
		const before = h.mails(email).length;

		const collision = await client.post('/change-email', { newEmail: taken });
		const free = await client.post('/change-email', { newEmail: uniqueEmail('collide-free') });
		expect(collision.status).toBe(200);
		expect(free.status).toBe(200);
		expect(await collision.json()).toEqual(await free.json());
		await h.flush();
		expect(h.mails(email, 'confirm-email-change')).toHaveLength(1);
		expect(h.mails(email).length).toBe(before + 1);
		expect(h.mails(taken, 'confirm-new-email')).toHaveLength(0);
		expect(h.mails(taken, 'email-change-notice')).toHaveLength(0);
	});

	it('rejects an expired confirmation link and keeps the address', async () => {
		const h = harness();
		const email = uniqueEmail('move-expired');
		const target = uniqueEmail('move-expired-to');
		await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		await client.post('/change-email', { newEmail: target, callbackURL: '/' });
		await h.flush();
		const link = linkOf(h.mail(email, 'confirm-email-change'));
		jumpAhead(TWO_HOURS);
		const response = await h.client().get(link);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toContain('error=TOKEN_EXPIRED');
		vi.useRealTimers();
		await h.flush();
		expect(h.mails(target)).toHaveLength(0);
		expect((await userRow(email))?.email).toBe(email);
	});
});

describe('change password', () => {
	it('refuses a wrong current password', async () => {
		const h = harness();
		const email = uniqueEmail('chpw-wrong');
		await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		const response = await client.post('/change-password', {
			currentPassword: 'definitely not it 0',
			newPassword: NEW_PASSWORD
		});
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe('INVALID_PASSWORD');
		expect((await h.client().signIn(email, PASSWORD)).status).toBe(200);
	});

	it('changes the password, revokes the other sessions and sends a notice', async () => {
		const h = harness();
		const email = uniqueEmail('chpw');
		await createVerifiedUser(h, email);
		const here = await signedIn(h, email);
		const elsewhere = await signedIn(h, email);
		const response = await here.post('/change-password', {
			currentPassword: PASSWORD,
			newPassword: NEW_PASSWORD,
			revokeOtherSessions: true
		});
		expect(response.status).toBe(200);
		expect(await elsewhere.session()).toBeNull();
		expect((await here.session())?.user.email).toBe(email);
		expect((await h.client().signIn(email, NEW_PASSWORD)).status).toBe(200);
		await h.flush();
		expect(h.mails(email, 'password-changed')).toHaveLength(1);
	});
});

describe('delete account', () => {
	it('refuses without a password, then deletes after the mailed confirmation', async () => {
		const h = harness();
		const email = uniqueEmail('delete');
		const id = await createVerifiedUser(h, email);
		await recordAcceptance(env.DB, id, POLICY_VERSION, Date.now());
		const client = await signedIn(h, email);

		const noPassword = await client.post('/delete-user', {});
		expect(noPassword.status).toBe(400);
		expect(await errorCode(noPassword)).toBe('PASSWORD_REQUIRED');

		const wrong = await client.post('/delete-user', { password: 'not my password 00' });
		expect(wrong.status).toBe(400);
		expect(await errorCode(wrong)).toBe('INVALID_PASSWORD');

		const requested = await client.post('/delete-user', { password: PASSWORD, callbackURL: '/' });
		expect(requested.status).toBe(200);
		expect(((await requested.json()) as { message: string }).message).toBe(
			'Verification email sent'
		);
		await h.flush();
		// Not confirmed yet: everything is still there.
		expect(await userRow(email)).not.toBeNull();

		const link = linkOf(h.mail(email, 'confirm-account-deletion'));
		const confirmed = await client.get(link);
		expect(confirmed.status).toBe(302);
		expect(await userRow(email)).toBeNull();
		expect(await sessionCount(id)).toBe(0);
		const acceptances = await env.DB.prepare(
			'SELECT count(*) AS n FROM policy_acceptances WHERE user_id = ?'
		)
			.bind(id)
			.first<{ n: number }>();
		expect(acceptances?.n).toBe(0);
		const accounts = await env.DB.prepare('SELECT count(*) AS n FROM account WHERE userId = ?')
			.bind(id)
			.first<{ n: number }>();
		expect(accounts?.n).toBe(0);
		await h.flush();
		expect(h.mails(email, 'account-deleted')).toHaveLength(1);
	});

	it('runs an injected content-deletion policy before deleting', async () => {
		network.resetHandlers();
		mockNetwork(network);
		const seen: string[] = [];
		const h = new Harness(
			{},
			{
				beforeDeleteUser: async (user) => {
					seen.push(user.id);
				}
			}
		);
		const email = uniqueEmail('delete-policy');
		const id = await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		await client.post('/delete-user', { password: PASSWORD, callbackURL: '/' });
		await h.flush();
		await client.get(linkOf(h.mail(email, 'confirm-account-deletion')));
		expect(seen).toEqual([id]);
		expect(await userRow(email)).toBeNull();
	});

	it('does not delete with a confirmation link of another user', async () => {
		const h = harness();
		const owner = uniqueEmail('delete-owner');
		const intruder = uniqueEmail('delete-intruder');
		await createVerifiedUser(h, owner);
		await createVerifiedUser(h, intruder);
		const ownerClient = await signedIn(h, owner);
		await ownerClient.post('/delete-user', { password: PASSWORD, callbackURL: '/' });
		await h.flush();
		const link = linkOf(h.mail(owner, 'confirm-account-deletion'));
		const intruderClient = await signedIn(h, intruder);
		const response = await intruderClient.get(link);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(await userRow(owner)).not.toBeNull();
		expect(await userRow(intruder)).not.toBeNull();
	});
});
