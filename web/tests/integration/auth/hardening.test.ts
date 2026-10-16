// FX3.1: fixes of the Q3 round-1 security review, through the real Better Auth handler.
//   Q3-1 per-user limits and lockout on password / second-factor checks of a session;
//   Q3-2 token-less or invalid-Turnstile requests never spend a victim's per-account window;
//   Q3-4 single-use change-email links, request-keyed final mails, daily resend cap;
//   Q3-5 freshness (or password) on /change-email, 2FA marker for admins' 2FA management;
//   Q3-7 unused endpoints closed over HTTP, bounded `name`;
//   Q3-9 malformed `oa_lang` cookie, /conta e-mails in the user's locale.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	changeAccountPassword,
	requestAccountClosure,
	requestEmailChange
} from '#lib/server/account/auth-actions.ts';
import { recordEmailChangeRequest } from '#lib/server/account/email-change.ts';
import { reauthenticate } from '#lib/server/admin/reauth.ts';
import { CLOSED_AUTH_PATHS } from '#lib/server/auth.ts';
import { confirmEmailChange, emailLocaleFromRequest } from '#lib/server/auth/emails.ts';
import { recordSecretFailure, type SecretKind } from '#lib/server/auth/secret-guard.ts';
import {
	buildIdempotencyKey,
	confirmAccountDeletion,
	passwordChanged,
	RESEND_ENDPOINT
} from '#lib/server/email/index.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { createAuthGuard } from '#lib/server/security/auth-guard.ts';
import { SECRET_POLICIES } from '#lib/server/security/ratelimit.ts';
import type { AuthSession } from '#lib/server/types.ts';
import {
	createVerifiedUser,
	errorCode,
	Harness,
	linkOf,
	mockNetwork,
	NEW_PASSWORD,
	outbox,
	PASSWORD,
	signedIn,
	totpSecretFromUri,
	uniqueEmail,
	type Client
} from './harness.ts';

const network = setupNetwork();

vi.setConfig({ testTimeout: 60_000 });

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

/** Resend idempotency keys seen, per template. */
const keys: { template: string; to: string; key: string }[] = [];

function harness(overrides: ConstructorParameters<typeof Harness>[0] = {}): Harness {
	network.resetHandlers();
	mockNetwork(network);
	// Takes precedence over the harness handler: also records the Idempotency-Key header.
	network.use(
		http.post(RESEND_ENDPOINT, async ({ request }) => {
			const body = (await request.json()) as {
				to: string[];
				subject: string;
				text: string;
				html: string;
				tags?: { name: string; value: string }[];
			};
			const template = body.tags?.find((tag) => tag.name === 'template')?.value ?? '';
			const to = body.to[0] ?? '';
			keys.push({ template, to, key: request.headers.get('idempotency-key') ?? '' });
			outbox.push({ to, subject: body.subject, text: body.text, html: body.html, template });
			return HttpResponse.json({ id: `email_${outbox.length}` });
		})
	);
	return new Harness(overrides);
}

const MINUTE = 60_000;

async function makeAdmin(id: string): Promise<void> {
	await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE id = ?`).bind(id).run();
}

async function totpCode(h: Harness, secret: string): Promise<string> {
	const { code } = await h.auth.api.generateTOTP({ body: { secret } });
	return code;
}

/** Enables TOTP (one verification attempt) and returns the raw secret. */
async function enableTotp(h: Harness, client: Client): Promise<string> {
	const enabled = await client.post('/two-factor/enable', { password: PASSWORD });
	expect(enabled.status).toBe(200);
	const { totpURI } = (await enabled.json()) as { totpURI: string };
	const secret = totpSecretFromUri(totpURI);
	const verified = await client.post('/two-factor/verify-totp', {
		code: await totpCode(h, secret)
	});
	expect(verified.status).toBe(200);
	return secret;
}

/** Wrong secrets counted today for `userId` (the lockout budget). */
async function failures(kind: SecretKind, userId: string): Promise<number> {
	const { group, failures: rule } = SECRET_POLICIES[kind];
	const row = await env.DB.prepare(
		'SELECT COALESCE(SUM(count), 0) AS n FROM rate_limit_counters WHERE key = ?'
	)
		.bind(`u:${group}.failures:${userId}:${rule.windowSeconds}`)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function exhaustFailures(kind: SecretKind, userId: string): Promise<void> {
	for (let index = 0; index < SECRET_POLICIES[kind].failures.limit; index += 1) {
		await recordSecretFailure(env.DB, kind, userId);
	}
}

async function makeStale(userId: string): Promise<void> {
	await env.DB.prepare('UPDATE "session" SET "createdAt" = ? WHERE "userId" = ?')
		.bind(new Date(Date.now() - 20 * MINUTE).toISOString(), userId)
		.run();
}

function sessionFor(userId: string, createdAt: Date): AuthSession {
	return {
		id: 'session-under-test',
		userId,
		createdAt,
		expiresAt: new Date(Date.now() + 60 * MINUTE),
		twoFactorVerifiedAt: null,
		twoFactorVerified: false,
		impersonatedBy: null
	};
}

describe('Q3-1: second-factor and password guessing by a session holder', () => {
	it('verify-totp of a session: 5 attempts per 5 min, wrong codes counted', async () => {
		const h = harness();
		const email = uniqueEmail('hard-totp');
		const id = await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		const secret = await enableTotp(h, client); // attempt 1
		const statuses: number[] = [];
		for (let index = 0; index < 4; index += 1) {
			statuses.push((await client.post('/two-factor/verify-totp', { code: '000000' })).status);
		}
		expect(statuses).toEqual([401, 401, 401, 401]);
		expect(await failures('second-factor', id)).toBe(4);
		const blocked = await client.post('/two-factor/verify-totp', {
			code: await totpCode(h, secret)
		});
		expect(blocked.status).toBe(429);
		expect(await errorCode(blocked)).toBe('RATE_LIMITED');
		expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
		// The backup-code endpoint shares the budget.
		const backup = await client.post('/two-factor/verify-backup-code', { code: 'abcde-fghij' });
		expect(backup.status).toBe(429);
	});

	it('locks after 20 wrong codes a day: even the right code is refused, admin reauth too', async () => {
		const h = harness({ admin2faRequired: true });
		const email = uniqueEmail('hard-lock');
		const id = await createVerifiedUser(h, email);
		await makeAdmin(id);
		const client = await signedIn(h, email);
		const secret = await enableTotp(h, client);
		await exhaustFailures('second-factor', id);

		const response = await client.post('/two-factor/verify-totp', {
			code: await totpCode(h, secret)
		});
		expect(response.status).toBe(429);
		// Admin re-authentication goes through the same rule (no RL_AUTH binding needed).
		expect(
			await reauthenticate(
				{
					db: env.DB,
					auth: h.auth,
					headers: client.headers(),
					user: { id, twoFactorEnabled: true }
				},
				await totpCode(h, secret)
			)
		).toEqual({ ok: false, code: 'RATE_LIMITED' });
	});

	it('the sign-in challenge (no session) is not touched by the per-user rule', async () => {
		const h = harness();
		const email = uniqueEmail('hard-challenge');
		const id = await createVerifiedUser(h, email);
		const secret = await enableTotp(h, await signedIn(h, email));
		await exhaustFailures('second-factor', id);
		const client = h.client();
		expect((await client.signIn(email)).status).toBe(200);
		const ok = await client.post('/two-factor/verify-totp', { code: await totpCode(h, secret) });
		expect(ok.status).toBe(200);
	});

	it('change-password: 5 attempts per 5 min, wrong passwords counted', async () => {
		const h = harness();
		const email = uniqueEmail('hard-pw');
		const id = await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		for (let index = 0; index < 5; index += 1) {
			const wrong = await client.post('/change-password', {
				currentPassword: `wrong password ${index} xx`,
				newPassword: NEW_PASSWORD
			});
			expect(wrong.status).toBe(400);
		}
		expect(await failures('password', id)).toBe(5);
		const blocked = await client.post('/change-password', {
			currentPassword: PASSWORD,
			newPassword: NEW_PASSWORD
		});
		expect(blocked.status).toBe(429);
		expect((await h.client().signIn(email, PASSWORD)).status).toBe(200);
	});

	it('password lockout covers 2FA enable, account deletion and the /conta e-mail form', async () => {
		const h = harness();
		const email = uniqueEmail('hard-pwlock');
		const id = await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		const wrongDelete = await client.post('/delete-user', { password: 'not my password 00' });
		expect(wrongDelete.status).toBe(400);
		expect(await failures('password', id)).toBe(1);

		await exhaustFailures('password', id);
		expect((await client.post('/two-factor/enable', { password: PASSWORD })).status).toBe(429);
		expect(
			(await client.post('/delete-user', { password: PASSWORD, callbackURL: '/' })).status
		).toBe(429);
		const now = Date.now();
		const result = await requestEmailChange(h.auth.api, client.headers({ origin: h.origin }), {
			db: env.DB,
			userId: id,
			currentEmail: email,
			session: sessionFor(id, new Date(now - 20 * MINUTE)),
			newEmail: uniqueEmail('hard-pwlock-to'),
			password: PASSWORD,
			turnstileToken: h.turnstileToken('/change-email') ?? '',
			now
		});
		expect(result).toMatchObject({ ok: false, code: 'RATE_LIMITED', status: 429 });
		await h.flush();
		expect(h.mails(email, 'confirm-account-deletion')).toHaveLength(0);
		expect(h.mails(email, 'confirm-email-change')).toHaveLength(0);
	});
});

describe('Q3-2: no lockout without Turnstile', () => {
	it("token-less or invalid-token sign-ins never spend the victim's per-e-mail window", async () => {
		const h = harness();
		const email = uniqueEmail('hard-dos');
		await createVerifiedUser(h, email);
		// 24 attempts from 24 addresses: the per-e-mail rule (10 per 5 min) would have locked.
		for (let index = 0; index < 12; index += 1) {
			const none = await h
				.client()
				.post('/sign-in/email', { email, password: 'guess guess 123' }, { turnstile: null });
			expect(none.status).toBe(400);
			const bad = await h
				.client()
				.post('/sign-in/email', { email, password: 'guess guess 123' }, { turnstile: 'bad' });
			expect(bad.status).toBe(403);
		}
		expect((await h.client().signIn(email)).status).toBe(200);
	});

	it("token-less reset requests never spend the victim's per-e-mail reset budget", async () => {
		const h = harness();
		const email = uniqueEmail('hard-dos-reset');
		await createVerifiedUser(h, email);
		for (let index = 0; index < 8; index += 1) {
			const none = await h.client().post('/request-password-reset', { email }, { turnstile: null });
			expect(none.status).toBe(400);
		}
		expect((await h.client().post('/request-password-reset', { email })).status).toBe(200);
		await h.flush();
		expect(h.mails(email, 'reset-password')).toHaveLength(1);
	});
});

describe('Q3-4: change-email links and resend budget', () => {
	it('each link works once; the final mails are keyed on the pending request', async () => {
		const h = harness();
		const email = uniqueEmail('hard-link');
		const id = await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		const target = uniqueEmail('hard-link-to');
		const callbackURL = '/conta?email=alterado';
		expect((await client.post('/change-email', { newEmail: target, callbackURL })).status).toBe(
			200
		);
		const requestedAt = Date.now();
		await recordEmailChangeRequest(env.DB, id, target, requestedAt);
		await h.flush();

		const first = linkOf(h.mail(email, 'confirm-email-change'));
		const opened = await h.client().get(first);
		expect(opened.status).toBe(302);
		expect(opened.headers.get('location') ?? '').not.toContain('error=');
		await h.flush();
		expect(h.mails(target, 'confirm-new-email')).toHaveLength(1);
		expect(h.mails(email, 'email-change-notice')).toHaveLength(1);

		for (let index = 0; index < 3; index += 1) {
			const again = await h.client().get(first);
			expect(again.status).toBe(302);
			expect(again.headers.get('location')).toBe(`${callbackURL}&error=LINK_ALREADY_USED`);
		}
		await h.flush();
		expect(h.mails(target, 'confirm-new-email')).toHaveLength(1);
		expect(h.mails(email, 'email-change-notice')).toHaveLength(1);

		const expected = await buildIdempotencyKey(
			'confirm-new-email',
			id,
			target,
			String(requestedAt)
		);
		expect(keys.filter((entry) => entry.to === target).map((entry) => entry.key)).toEqual([
			expected
		]);

		const final = linkOf(h.mail(target, 'confirm-new-email'));
		const switched = await h.client().get(final);
		expect(switched.status).toBe(302);
		const row = await env.DB.prepare('SELECT email FROM "user" WHERE id = ?')
			.bind(id)
			.first<{ email: string }>();
		expect(row?.email).toBe(target);

		// Replays change nothing (the token's old address no longer exists: Better Auth refuses it
		// before the claim matters) and sign nobody in.
		const replay = await h.client().get(final);
		expect(replay.headers.get('location') ?? '').toMatch(/error=/);
		expect(replay.headers.getSetCookie().some((line) => line.includes('session_token='))).toBe(
			false
		);
	});

	it('a link opened in a browser signed in as someone else is not spent', async () => {
		const h = harness();
		const email = uniqueEmail('hard-link-wrong');
		await createVerifiedUser(h, email);
		const owner = await signedIn(h, email);
		const otherEmail = uniqueEmail('hard-link-other');
		await createVerifiedUser(h, otherEmail);
		const other = await signedIn(h, otherEmail);
		const target = uniqueEmail('hard-link-wrong-to');
		expect((await owner.post('/change-email', { newEmail: target, callbackURL: '/' })).status).toBe(
			200
		);
		await h.flush();
		const link = linkOf(h.mail(email, 'confirm-email-change'));
		const wrong = await other.get(link);
		expect(wrong.headers.get('location') ?? '').not.toContain('LINK_ALREADY_USED');
		const right = await owner.get(link);
		expect(right.status).toBe(302);
		expect(right.headers.get('location') ?? '').not.toContain('error=');
		await h.flush();
		expect(h.mails(target, 'confirm-new-email')).toHaveLength(1);
	});

	it('resend verification: at most 10 per address per day, across IPs and windows', async () => {
		const DAY = 86_400_000;
		// Early in the current UTC day, so the daily salt and window never change during the test.
		const base = Math.floor(Date.now() / DAY) * DAY + MINUTE;
		let now = base;
		const guard = createAuthGuard({
			env: getServerEnv({ env }),
			verifyTurnstile: async () => ({ ok: true }),
			log: () => undefined,
			now: () => new Date(now)
		});
		const email = uniqueEmail('hard-resend');
		const outcomes: boolean[] = [];
		let ip = 0;
		for (const step of [0, 11, 22, 33]) {
			now = base + step * MINUTE;
			for (let index = 0; index < 3; index += 1) {
				ip += 1;
				const result = await guard({
					path: '/send-verification-email',
					ip: `198.18.${Math.floor(ip / 250)}.${ip % 250}`,
					email
				});
				outcomes.push(result.ok);
			}
		}
		expect(outcomes.slice(0, 10).every(Boolean)).toBe(true);
		expect(outcomes.slice(10)).toEqual([false, false]);
	});
});

describe('Q3-5: freshness of sensitive endpoints over HTTP', () => {
	it('/change-email from a stale session needs the correct password', async () => {
		const h = harness();
		const email = uniqueEmail('hard-stale');
		const id = await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		await makeStale(id);
		const target = uniqueEmail('hard-stale-to');

		const stale = await client.post('/change-email', { newEmail: target, callbackURL: '/' });
		expect(stale.status).toBe(403);
		expect(await errorCode(stale)).toBe('SESSION_NOT_FRESH');
		const wrong = await client.post('/change-email', {
			newEmail: target,
			callbackURL: '/',
			password: 'not my password 00'
		});
		expect(wrong.status).toBe(400);
		expect(await errorCode(wrong)).toBe('INVALID_PASSWORD');
		await h.flush();
		expect(h.mails(email, 'confirm-email-change')).toHaveLength(0);

		const ok = await client.post('/change-email', {
			newEmail: target,
			callbackURL: '/',
			password: PASSWORD
		});
		expect(ok.status).toBe(200);
		await h.flush();
		expect(h.mails(email, 'confirm-email-change')).toHaveLength(1);
	});

	it('an admin with 2FA needs the 2FA marker to disable it', async () => {
		const h = harness();
		const email = uniqueEmail('hard-admin2fa');
		const id = await createVerifiedUser(h, email);
		await makeAdmin(id);
		const client = await signedIn(h, email);
		await enableTotp(h, client);
		await env.DB.prepare('UPDATE "session" SET "twoFactorVerifiedAt" = NULL WHERE "userId" = ?')
			.bind(id)
			.run();
		const response = await client.post('/two-factor/disable', { password: PASSWORD });
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe('TWO_FACTOR_REQUIRED');
		const row = await env.DB.prepare('SELECT "twoFactorEnabled" AS on2fa FROM "user" WHERE id = ?')
			.bind(id)
			.first<{ on2fa: number }>();
		expect(row?.on2fa).toBe(1);
	});
});

describe('Q3-7: unused endpoints and the name field', () => {
	it('answer 404 over HTTP for a signed-in user', async () => {
		const h = harness();
		const email = uniqueEmail('hard-closed');
		await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		const GET_ONLY = new Set(['/list-sessions', '/list-accounts', '/account-info']);
		for (const path of CLOSED_AUTH_PATHS) {
			const concrete = path.replace(':id', 'github').replace(':token', 'some-token');
			const response =
				GET_ONLY.has(path) || path === '/reset-password/:token'
					? await client.get(concrete)
					: await client.post(concrete, { password: PASSWORD, code: '123456', name: 'x' });
			expect(response.status, path).toBe(404);
		}
		expect((await client.post('/is-username-available', { username: 'admin' })).status).toBe(404);
		expect((await client.get('/callback/github?code=x&state=y')).status).toBe(404);
	});

	it('refuses an over-long name or one with control / bidi characters at sign-up', async () => {
		const h = harness();
		for (const name of ['x'.repeat(65), 'Evil\u202Egnp.exe', 'line\nbreak']) {
			const email = uniqueEmail('hard-name');
			const response = await h.client().signUp(email, { name });
			expect(response.status).toBe(400);
			expect(await errorCode(response)).toBe('INVALID_NAME');
			const row = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?').bind(email).first();
			expect(row).toBeNull();
		}
		expect(
			(await h.client().signUp(uniqueEmail('hard-name-ok'), { name: 'Zoë Ñúñez' })).status
		).toBe(200);
	});
});

describe('Q3-9: e-mail locale', () => {
	it('a malformed oa_lang cookie falls back instead of throwing, and the mail still goes out', async () => {
		const request = (headers: Record<string, string>) =>
			new Request('https://auri.example/', { headers });
		expect(emailLocaleFromRequest(request({ cookie: 'oa_lang=%' }))).toBe('pt-BR');
		expect(
			emailLocaleFromRequest(request({ cookie: 'oa_lang=%E0%A4%A', 'accept-language': 'en-US' }))
		).toBe('en-US');

		const h = harness();
		const email = uniqueEmail('hard-lang');
		await createVerifiedUser(h, email);
		const client = h.client();
		client.cookies.set('oa_lang', '%');
		const response = await client.post('/request-password-reset', { email });
		expect(response.status).toBe(200);
		await h.flush();
		expect(h.mails(email, 'reset-password')).toHaveLength(1);
	});

	it('/conta actions mail in the locale of the page request', async () => {
		const h = harness();
		const origin = h.origin;

		const pwEmail = uniqueEmail('hard-locale-pw');
		await createVerifiedUser(h, pwEmail);
		const pwClient = await signedIn(h, pwEmail);
		pwClient.cookies.set('oa_lang', 'en-US');
		expect(
			await changeAccountPassword(h.auth.api, pwClient.headers({ origin }), {
				currentPassword: PASSWORD,
				newPassword: NEW_PASSWORD,
				confirmPassword: NEW_PASSWORD,
				revokeOtherSessions: false
			})
		).toEqual({ ok: true });

		const mailEmail = uniqueEmail('hard-locale-mail');
		const mailId = await createVerifiedUser(h, mailEmail);
		const mailClient = await signedIn(h, mailEmail);
		const now = Date.now();
		expect(
			await requestEmailChange(
				h.auth.api,
				mailClient.headers({ origin, 'accept-language': 'en-US,en;q=0.9' }),
				{
					db: env.DB,
					userId: mailId,
					currentEmail: mailEmail,
					session: sessionFor(mailId, new Date(now)),
					newEmail: uniqueEmail('hard-locale-to'),
					password: '',
					turnstileToken: h.turnstileToken('/change-email') ?? '',
					now
				}
			)
		).toMatchObject({ ok: true });

		const closeEmail = uniqueEmail('hard-locale-close');
		const closeId = await createVerifiedUser(h, closeEmail);
		const closeClient = await signedIn(h, closeEmail);
		closeClient.cookies.set('oa_lang', 'en-US');
		expect(
			await requestAccountClosure(h.auth.api, closeClient.headers({ origin }), {
				db: env.DB,
				userId: closeId,
				password: PASSWORD,
				mode: 'anonymize',
				acknowledged: true,
				now: Date.now()
			})
		).toEqual({ ok: true });

		// Control: no cookie, no Accept-Language → pt-BR.
		const ptEmail = uniqueEmail('hard-locale-pt');
		await createVerifiedUser(h, ptEmail);
		const ptClient = await signedIn(h, ptEmail);
		await changeAccountPassword(h.auth.api, ptClient.headers({ origin }), {
			currentPassword: PASSWORD,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD,
			revokeOtherSessions: false
		});

		await h.flush();
		const url = `${origin}/x`;
		expect(h.mail(pwEmail, 'password-changed').subject).toBe(
			passwordChanged('en-US', { origin, url, name: null }).subject
		);
		expect(h.mail(mailEmail, 'confirm-email-change').subject).toBe(
			confirmEmailChange('en-US', { origin, url }).subject
		);
		expect(h.mail(closeEmail, 'confirm-account-deletion').subject).toBe(
			confirmAccountDeletion('en-US', { origin, url, name: null, expiresInMinutes: 60 }).subject
		);
		expect(h.mail(ptEmail, 'password-changed').subject).toBe(
			passwordChanged('pt-BR', { origin, url, name: null }).subject
		);
		expect(passwordChanged('pt-BR', { origin, url, name: null }).subject).not.toBe(
			passwordChanged('en-US', { origin, url, name: null }).subject
		);
	});
});
