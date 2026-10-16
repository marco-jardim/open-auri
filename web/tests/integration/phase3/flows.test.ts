// T3.T full account life cycle with the captured mailbox, once per closure policy:
// sign-up → verify (link) → sign-in → change password → sign out other sessions → change e-mail
// (both links) → export → close account (link). A console spy runs over the whole flow: no line
// may carry an e-mail, an IP, a token, a password or the session cookie.
import { setupNetwork } from '@msw/cloudflare';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	changeAccountPassword,
	requestAccountClosure,
	requestEmailChange
} from '#lib/server/account/auth-actions.ts';
import { accountDeletionHook, type DeletionMode } from '#lib/server/account/deletion.ts';
import { handleExportRequest } from '#lib/server/account/endpoints.ts';
import { toAuthLocals } from '#lib/server/auth.ts';
import {
	Harness,
	linkOf,
	mockNetwork,
	NEW_PASSWORD,
	PASSWORD,
	testEnv,
	uniqueEmail,
	uniqueUsername,
	type Client,
	type SentEmail
} from '../auth/harness.ts';
import { count } from './helpers.ts';

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

/**
 * The browser of the server-side `auth.api.*` call in progress (the /conta actions). In production
 * `sveltekitCookies(getRequestEvent)` copies the Set-Cookie of such calls onto the response; here
 * the same plugin writes into this client's jar. Without it a password change with
 * `revokeOtherSessions` (which rotates the current session) would leave the client on a deleted
 * session token.
 */
let cookieTarget: Client | null = null;

const fakeRequestEvent = {
	cookies: {
		set(name: string, value: string, options: { maxAge?: number; expires?: Date } = {}) {
			const expired =
				value === '' ||
				options.maxAge === 0 ||
				(options.expires !== undefined && options.expires.getTime() <= Date.now());
			if (expired) cookieTarget?.cookies.delete(name);
			else cookieTarget?.cookies.set(name, value);
		}
	}
};

/** Runs a server-side auth call as `client` (its Set-Cookie lands in the client's jar). */
async function as<T>(client: Client, run: () => Promise<T>): Promise<T> {
	cookieTarget = client;
	try {
		return await run();
	} finally {
		cookieTarget = null;
	}
}

/**
 * Harness wired like hooks.server.ts: the T3.7 deletion hook decides the closure policy and
 * sveltekitCookies is the last plugin.
 */
function productionLikeHarness(): Harness {
	network.resetHandlers();
	mockNetwork(network);
	return new Harness(
		{},
		{
			beforeDeleteUser: accountDeletionHook(testEnv()),
			plugins: [sveltekitCookies(() => (cookieTarget ? fakeRequestEvent : undefined) as never)]
		}
	);
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** Captures every console line (args serialized) until afterEach restores the mocks. */
function captureConsole(): { lines: string[] } {
	const lines: string[] = [];
	for (const method of CONSOLE_METHODS) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			lines.push(
				args
					.map((arg) => {
						if (arg instanceof Error) return `${arg.name}: ${arg.message} ${arg.stack ?? ''}`;
						if (typeof arg === 'string') return arg;
						try {
							return JSON.stringify(arg);
						} catch {
							return String(arg);
						}
					})
					.join(' ')
			);
		});
	}
	return { lines };
}

function tokenOf(mail: SentEmail): string {
	const link = linkOf(mail);
	return link.searchParams.get('token') ?? link.pathname.split('/').pop() ?? '';
}

async function userId(email: string): Promise<string | null> {
	const row = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ id: string }>();
	return row?.id ?? null;
}

async function locals(client: Client) {
	const current = toAuthLocals(await client.session());
	if (!current) throw new Error('signed out');
	return current;
}

describe.each<DeletionMode>(['anonymize', 'delete-all'])('account life cycle (%s)', (mode) => {
	it('runs end to end with captured links, and logs nothing personal', async () => {
		const h = productionLikeHarness();
		const { lines } = captureConsole();
		const email = uniqueEmail(`life-${mode}`);
		const newEmail = uniqueEmail(`life-${mode}-moved`);
		const username = uniqueUsername('life');
		const secrets: string[] = [email, newEmail, PASSWORD, NEW_PASSWORD];
		const clients: Client[] = [];
		const client = (): Client => {
			const created = h.client();
			clients.push(created);
			return created;
		};

		// 1. Sign-up, then the verification link.
		const signUpClient = client();
		expect((await signUpClient.signUp(email, { username })).status).toBe(200);
		await h.flush();
		const verifyMail = h.mail(email, 'verify-email');
		secrets.push(tokenOf(verifyMail));
		// Not verified yet: sign-in refused.
		expect((await client().signIn(email)).status).toBe(403);
		const verified = await client().get(linkOf(verifyMail));
		expect(verified.status).toBe(302);
		// The link is single use in effect: it signs nobody in.
		expect(verified.headers.getSetCookie().some((line) => line.includes('session_token'))).toBe(
			false
		);

		// 2. Sign-in on two devices.
		const here = client();
		expect((await here.signIn(email)).status).toBe(200);
		const elsewhere = client();
		expect((await elsewhere.signIn(email)).status).toBe(200);
		const id = await userId(email);
		if (!id) throw new Error('user missing');

		// 3. Change password, signing the other device out.
		const changed = await as(here, () =>
			changeAccountPassword(h.auth.api, here.headers({ origin: h.origin }), {
				currentPassword: PASSWORD,
				newPassword: NEW_PASSWORD,
				confirmPassword: NEW_PASSWORD,
				revokeOtherSessions: true
			})
		);
		expect(changed).toEqual({ ok: true });
		expect(await elsewhere.session()).toBeNull();
		// The current device stays signed in (its session was rotated, not lost).
		expect((await here.session())?.user.email).toBe(email);
		expect((await client().signIn(email, PASSWORD)).status).toBe(401);
		await h.flush();
		expect(h.mails(email, 'password-changed')).toHaveLength(1);

		// 4. A third device signs in; "sign out the other sessions" from here.
		const third = client();
		expect((await third.signIn(email, NEW_PASSWORD)).status).toBe(200);
		const revoked = await here.post('/revoke-other-sessions', {});
		expect(revoked.status).toBe(200);
		expect(await third.session()).toBeNull();
		expect((await here.session())?.user.email).toBe(email);

		// 5. Change e-mail: current address confirms, then the new one verifies.
		const current = await locals(here);
		const requested = await as(here, () =>
			requestEmailChange(h.auth.api, here.headers({ origin: h.origin }), {
				db: env.DB,
				userId: id,
				currentEmail: email,
				session: current.session,
				newEmail,
				password: '',
				turnstileToken: h.turnstileToken('/change-email') ?? '',
				now: Date.now()
			})
		);
		expect(requested.ok).toBe(true);
		await h.flush();
		const confirmMail = h.mail(email, 'confirm-email-change');
		secrets.push(tokenOf(confirmMail));
		expect(h.mails(newEmail)).toHaveLength(0);
		expect((await client().get(linkOf(confirmMail))).status).toBe(302);
		await h.flush();
		const newAddressMail = h.mail(newEmail, 'confirm-new-email');
		secrets.push(tokenOf(newAddressMail));
		expect(h.mails(email, 'email-change-notice')).toHaveLength(1);
		expect(await userId(email)).toBe(id);
		expect((await client().get(linkOf(newAddressMail))).status).toBe(302);
		expect(await userId(newEmail)).toBe(id);
		expect(await userId(email)).toBeNull();

		// 6. Export: the new address, no secrets.
		const signedIn = await locals(here);
		const exported = await handleExportRequest({
			request: new Request(`${h.origin}/conta/exportar`, {
				method: 'POST',
				headers: { origin: h.origin }
			}),
			locals: signedIn,
			db: env.DB,
			publicOrigin: h.origin
		});
		expect(exported.status).toBe(200);
		const document = await exported.text();
		expect(document).toContain(newEmail);
		expect(document).not.toMatch(/scrypt\$/);
		const sessionToken = await env.DB.prepare('SELECT token FROM "session" WHERE userId = ?')
			.bind(id)
			.first<{ token: string }>();
		if (sessionToken) {
			secrets.push(sessionToken.token);
			expect(document).not.toContain(sessionToken.token);
		}

		// 7. Close the account with the chosen policy; the mailed link (to the new address) deletes.
		const closure = await as(here, () =>
			requestAccountClosure(h.auth.api, here.headers({ origin: h.origin }), {
				db: env.DB,
				userId: id,
				password: NEW_PASSWORD,
				mode,
				acknowledged: true,
				now: Date.now()
			})
		);
		expect(closure).toEqual({ ok: true });
		await h.flush();
		const deletionMail = h.mail(newEmail, 'confirm-account-deletion');
		secrets.push(tokenOf(deletionMail));
		expect(await userId(newEmail)).toBe(id);
		expect((await here.get(linkOf(deletionMail))).status).toBe(302);
		expect(await userId(newEmail)).toBeNull();
		expect(await count('SELECT count(*) AS n FROM "session" WHERE userId = ?', id)).toBe(0);
		expect(await count('SELECT count(*) AS n FROM account WHERE userId = ?', id)).toBe(0);
		expect(
			await count('SELECT count(*) AS n FROM account_deletion_requests WHERE user_id = ?', id)
		).toBe(0);
		const held = await count(
			'SELECT count(*) AS n FROM username_holds WHERE username = ? AND user_id IS NULL',
			username
		);
		expect(held).toBe(mode === 'anonymize' ? 1 : 0);
		await h.flush();
		expect(h.mails(newEmail, 'account-deleted')).toHaveLength(1);

		// The nickname: held (looks taken) after anonymize, free at once after delete-all.
		const again = await client().signUp(uniqueEmail('life-again'), { username });
		expect(again.status).toBe(mode === 'anonymize' ? 400 : 200);

		// No personal data in any log line of the whole flow.
		const ips = clients.map((created) => created.ip);
		const cookies = clients.flatMap((created) => [...created.cookies.values()]);
		const log = lines.join('\n');
		for (const value of [...secrets, ...ips, ...cookies].filter((v) => v.length >= 6)) {
			expect(log, 'a log line leaked personal data or a secret').not.toContain(value);
		}
		expect(log).not.toContain('@example.com');
	});
});

describe('e-mail locale', () => {
	it('follows the oa_lang cookie (en-US) and falls back to pt-BR', async () => {
		const h = productionLikeHarness();
		const pt = uniqueEmail('locale-pt');
		const en = uniqueEmail('locale-en');
		expect((await h.client().signUp(pt)).status).toBe(200);
		const english = h.client();
		english.cookies.set('oa_lang', 'en-US');
		expect((await english.signUp(en)).status).toBe(200);
		await h.flush();
		const ptMail = h.mail(pt, 'verify-email');
		const enMail = h.mail(en, 'verify-email');
		expect(ptMail.subject).not.toBe(enMail.subject);
		expect(ptMail.text).not.toBe(enMail.text.replace(en, pt));
	});
});
