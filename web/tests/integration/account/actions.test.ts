// /conta actions that go through Better Auth (password, e-mail) and the signed-in policy
// acknowledgement endpoint.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLICY_VERSION } from '#lib/content/legal/version.ts';
import {
	changeAccountPassword,
	EMAIL_CHANGE_CALLBACK,
	requestEmailChange
} from '#lib/server/account/auth-actions.ts';
import {
	EMAIL_CHANGE_PENDING_MS,
	pendingEmailChange,
	recordEmailChangeRequest
} from '#lib/server/account/email-change.ts';
import { handlePolicyRequest } from '#lib/server/account/endpoints.ts';
import { acceptCurrentPolicy, policyBannerState } from '#lib/server/account/policy.ts';
import { latestAcceptedVersion } from '#lib/server/legal/acceptance.ts';
import {
	createVerifiedUser,
	Harness,
	linkOf,
	mockNetwork,
	NEW_PASSWORD,
	PASSWORD,
	signedIn,
	uniqueEmail
} from '../auth/harness.ts';
import { ANONYMOUS, authSession, count, locals, origin, seedSession, seedUser } from './helpers.ts';
import { verifyCurrentPassword } from './verify-password.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

function harness(): Harness {
	network.resetHandlers();
	mockNetwork(network);
	return new Harness();
}

const MINUTE = 60 * 1000;

describe('change password', () => {
	it('validates before calling Better Auth', async () => {
		const h = harness();
		const email = uniqueEmail('pw-check');
		await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		const headers = client.headers({ origin: h.origin });
		const base = { currentPassword: PASSWORD, revokeOtherSessions: true };
		const cases: [Partial<Parameters<typeof changeAccountPassword>[2]>, string][] = [
			[{ newPassword: 'short', confirmPassword: 'short' }, 'too-short'],
			[{ newPassword: 'x'.repeat(129), confirmPassword: 'x'.repeat(129) }, 'too-long'],
			[{ newPassword: NEW_PASSWORD, confirmPassword: `${NEW_PASSWORD}!` }, 'mismatch'],
			[{ newPassword: PASSWORD, confirmPassword: PASSWORD }, 'same-password'],
			[
				{ currentPassword: '', newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
				'wrong-password'
			]
		];
		for (const [input, code] of cases) {
			const result = await changeAccountPassword(h.auth.api, headers, {
				...base,
				newPassword: '',
				confirmPassword: '',
				...input
			});
			expect(result, code).toMatchObject({ ok: false, code });
		}
		expect((await h.client().signIn(email, PASSWORD)).status).toBe(200);
	});

	it('maps a wrong current password', async () => {
		const h = harness();
		const email = uniqueEmail('pw-wrong');
		await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		const result = await changeAccountPassword(h.auth.api, client.headers({ origin: h.origin }), {
			currentPassword: 'definitely not it 0',
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD,
			revokeOtherSessions: true
		});
		expect(result).toEqual({ ok: false, code: 'wrong-password', status: 400 });
	});

	it('changes the password and, by default, signs the other sessions out', async () => {
		const h = harness();
		const email = uniqueEmail('pw-ok');
		const id = await createVerifiedUser(h, email);
		const here = await signedIn(h, email);
		const elsewhere = await signedIn(h, email);
		const result = await changeAccountPassword(h.auth.api, here.headers({ origin: h.origin }), {
			currentPassword: PASSWORD,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD,
			revokeOtherSessions: true
		});
		expect(result).toEqual({ ok: true });
		expect(await elsewhere.session()).toBeNull();
		expect(await verifyCurrentPassword(env.DB, id, NEW_PASSWORD)).toBe(true);
		expect(await verifyCurrentPassword(env.DB, id, PASSWORD)).toBe(false);
		await h.flush();
		expect(h.mails(email, 'password-changed')).toHaveLength(1);
	});

	it('keeps the other sessions when the box is unticked', async () => {
		const h = harness();
		const email = uniqueEmail('pw-keep');
		await createVerifiedUser(h, email);
		const here = await signedIn(h, email);
		const elsewhere = await signedIn(h, email);
		const result = await changeAccountPassword(h.auth.api, here.headers({ origin: h.origin }), {
			currentPassword: PASSWORD,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD,
			revokeOtherSessions: false
		});
		expect(result).toEqual({ ok: true });
		expect((await elsewhere.session())?.user.email).toBe(email);
	});
});

describe('verifyCurrentPassword', () => {
	it('is false for unknown users, empty or over-long passwords', async () => {
		const h = harness();
		const email = uniqueEmail('pw-verify');
		const id = await createVerifiedUser(h, email);
		expect(await verifyCurrentPassword(env.DB, id, PASSWORD)).toBe(true);
		expect(await verifyCurrentPassword(env.DB, id, '')).toBe(false);
		expect(await verifyCurrentPassword(env.DB, id, 'x'.repeat(129))).toBe(false);
		expect(await verifyCurrentPassword(env.DB, 'no-such-user', PASSWORD)).toBe(false);
	});
});

describe('change e-mail', () => {
	async function setup(prefix: string) {
		const h = harness();
		const email = uniqueEmail(prefix);
		const id = await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		const headers = client.headers({ origin: h.origin });
		const now = Date.now();
		const input = {
			db: env.DB,
			userId: id,
			currentEmail: email,
			session: authSession(id, 'session-current', { createdAt: new Date(now) }),
			newEmail: uniqueEmail(`${prefix}-to`),
			password: '',
			turnstileToken: h.turnstileToken('/change-email') ?? '',
			now
		};
		return { h, email, id, headers, input };
	}

	it('a fresh session starts the change without a password and shows it as pending', async () => {
		const { h, email, id, headers, input } = await setup('mail-fresh');
		const result = await requestEmailChange(h.auth.api, headers, input);
		expect(result).toEqual({
			ok: true,
			pending: {
				newEmail: input.newEmail,
				requestedAt: input.now,
				expiresAt: input.now + EMAIL_CHANGE_PENDING_MS
			}
		});
		expect(await pendingEmailChange(env.DB, id, email, input.now + MINUTE)).toMatchObject({
			newEmail: input.newEmail
		});
		await h.flush();
		const confirmation = h.mail(email, 'confirm-email-change');
		expect(decodeURIComponent(linkOf(confirmation).href)).toContain(EMAIL_CHANGE_CALLBACK);
		expect(h.mails(input.newEmail)).toHaveLength(0);
	});

	it('a stale session needs the current password', async () => {
		const { h, id, headers, input } = await setup('mail-stale');
		const stale = {
			...input,
			session: authSession(id, 'session-old', { createdAt: new Date(input.now - 20 * MINUTE) })
		};
		expect(await requestEmailChange(h.auth.api, headers, stale)).toMatchObject({
			ok: false,
			code: 'reauth-required',
			status: 403
		});
		expect(
			await requestEmailChange(h.auth.api, headers, { ...stale, password: 'not my password 00' })
		).toMatchObject({ ok: false, code: 'wrong-password' });
		expect(
			await count('SELECT count(*) AS n FROM email_change_requests WHERE user_id = ?', id)
		).toBe(0);
		expect(
			await requestEmailChange(h.auth.api, headers, { ...stale, password: PASSWORD })
		).toMatchObject({ ok: true });
	});

	it('refuses invalid or unchanged addresses and a missing Turnstile token', async () => {
		const { h, email, id, headers, input } = await setup('mail-bad');
		expect(
			await requestEmailChange(h.auth.api, headers, { ...input, newEmail: 'not-an-email' })
		).toMatchObject({ ok: false, code: 'invalid-email' });
		expect(
			await requestEmailChange(h.auth.api, headers, { ...input, newEmail: email.toUpperCase() })
		).toMatchObject({ ok: false, code: 'same-email' });
		const noToken = await requestEmailChange(h.auth.api, headers, { ...input, turnstileToken: '' });
		expect(noToken.ok).toBe(false);
		expect(await pendingEmailChange(env.DB, id, email, input.now)).toBeNull();
	});

	it('the pending notice ends when it expires or once the address changed', async () => {
		const user = await seedUser();
		const now = Date.now();
		const target = `${crypto.randomUUID()}@example.org`;
		await recordEmailChangeRequest(env.DB, user.id, ` ${target.toUpperCase()} `, now);
		expect(await pendingEmailChange(env.DB, user.id, user.email, now)).toMatchObject({
			newEmail: target
		});
		expect(await pendingEmailChange(env.DB, user.id, target, now)).toBeNull();
		await recordEmailChangeRequest(env.DB, user.id, target, now);
		expect(
			await pendingEmailChange(env.DB, user.id, user.email, now + EMAIL_CHANGE_PENDING_MS)
		).toBeNull();
		// Reading never writes (the /conta page and the export run while read-only is on).
		expect(
			await count('SELECT count(*) AS n FROM email_change_requests WHERE user_id = ?', user.id)
		).toBe(1);
	});

	it('expired requests are pruned by the next recorded request, oldest first', async () => {
		const stale = await seedUser();
		const other = await seedUser();
		const now = Date.now();
		// Expired long ago: the oldest row of the table, so the bounded prune reaches it first.
		await env.DB.prepare(
			'INSERT INTO email_change_requests (user_id, new_email, requested_at, expires_at) ' +
				'VALUES (?, ?, 0, 1)'
		)
			.bind(stale.id, `${crypto.randomUUID()}@example.org`)
			.run();
		await recordEmailChangeRequest(env.DB, other.id, `${crypto.randomUUID()}@example.org`, now);
		expect(
			await count('SELECT count(*) AS n FROM email_change_requests WHERE user_id = ?', stale.id)
		).toBe(0);
		expect(
			await count('SELECT count(*) AS n FROM email_change_requests WHERE user_id = ?', other.id)
		).toBe(1);
	});
});

describe('policy acknowledgement', () => {
	it('records only the published version', async () => {
		const user = await seedUser();
		expect(await policyBannerState(env.DB, user.id)).toEqual({
			version: POLICY_VERSION,
			seenVersion: null
		});
		expect(await acceptCurrentPolicy(env.DB, user.id, '2099-01-01', Date.now())).toEqual({
			ok: false,
			error: 'version'
		});
		expect(await acceptCurrentPolicy(env.DB, user.id, POLICY_VERSION, Date.now())).toEqual({
			ok: true,
			version: POLICY_VERSION
		});
		expect((await policyBannerState(env.DB, user.id)).seenVersion).toBe(POLICY_VERSION);
	});

	function post(body: string, headers: Record<string, string> = {}): Request {
		return new Request(`${origin()}/conta/politica`, {
			method: 'POST',
			headers: { origin: origin(), 'content-type': 'application/json', ...headers },
			body
		});
	}

	it('POST /conta/politica: owner only, same origin only, JSON only, current version only', async () => {
		const user = await seedUser();
		const session = await seedSession(user.id);
		const signedInLocals = locals(user, session.id);
		const base = { db: env.DB, publicOrigin: origin() };
		const body = JSON.stringify({ version: POLICY_VERSION });

		const anonymous = await handlePolicyRequest({
			...base,
			request: post(body),
			locals: ANONYMOUS
		});
		expect(anonymous.status).toBe(401);
		const crossSite = await handlePolicyRequest({
			...base,
			request: post(body, { origin: 'https://evil.example' }),
			locals: signedInLocals
		});
		expect(crossSite.status).toBe(403);
		const form = await handlePolicyRequest({
			...base,
			request: post(`version=${POLICY_VERSION}`, {
				'content-type': 'application/x-www-form-urlencoded'
			}),
			locals: signedInLocals
		});
		expect(form.status).toBe(415);
		const broken = await handlePolicyRequest({
			...base,
			request: post('{'),
			locals: signedInLocals
		});
		expect(broken.status).toBe(400);
		const old = await handlePolicyRequest({
			...base,
			request: post(JSON.stringify({ version: '2020-01-01' })),
			locals: signedInLocals
		});
		expect(old.status).toBe(400);
		expect(await latestAcceptedVersion(env.DB, user.id)).toBeNull();

		const accepted = await handlePolicyRequest({
			...base,
			request: post(body),
			locals: signedInLocals
		});
		expect(accepted.status).toBe(200);
		expect(accepted.headers.get('cache-control')).toBe('no-store');
		expect(await accepted.json()).toEqual({ version: POLICY_VERSION });
		expect(await latestAcceptedVersion(env.DB, user.id)).toBe(POLICY_VERSION);
		// Idempotent.
		const again = await handlePolicyRequest({
			...base,
			request: post(body),
			locals: signedInLocals
		});
		expect(again.status).toBe(200);
		expect(
			await count('SELECT count(*) AS n FROM policy_acceptances WHERE user_id = ?', user.id)
		).toBe(1);
	});
});
