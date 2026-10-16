// Request-level protections of the auth endpoints: T3.3 rate limit and Turnstile through
// hooks.before, origin checks, cookie attributes, nickname rules and logs without personal data.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	createVerifiedUser,
	errorCode,
	Harness,
	mockNetwork,
	PASSWORD,
	signedIn,
	uniqueEmail,
	uniqueUsername
} from './harness.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterEach(() => {
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

describe('rate limit (T3.3 rules in hooks.before)', () => {
	it('blocks the 4th sign-in attempt within 10 s with 429 and Retry-After', async () => {
		const h = harness();
		const email = uniqueEmail('rl');
		await createVerifiedUser(h, email);
		const client = h.client();
		const statuses: number[] = [];
		for (let i = 0; i < 3; i += 1) {
			statuses.push((await client.signIn(email, 'wrong password attempt')).status);
		}
		expect(statuses).toEqual([401, 401, 401]);
		const fourth = await client.signIn(email, PASSWORD);
		expect(fourth.status).toBe(429);
		expect(await errorCode(fourth)).toBe('RATE_LIMITED');
		expect(Number(fourth.headers.get('retry-after'))).toBeGreaterThan(0);
	});
});

describe('Turnstile (x-turnstile-token header)', () => {
	it('requires a token on guarded endpoints', async () => {
		const h = harness();
		const response = await h
			.client()
			.post('/sign-in/email', { email: uniqueEmail(), password: PASSWORD }, { turnstile: null });
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe('TURNSTILE_REQUIRED');
	});

	it('rejects a token Siteverify refuses', async () => {
		const h = harness();
		const response = await h
			.client()
			.post('/sign-in/email', { email: uniqueEmail(), password: PASSWORD }, { turnstile: 'bad' });
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe('TURNSTILE_FAILED');
	});

	it('rejects a token issued for another action', async () => {
		const h = harness();
		const response = await h
			.client()
			.post(
				'/request-password-reset',
				{ email: uniqueEmail() },
				{ turnstile: `ok:sign-in:${h.hostname}` }
			);
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe('TURNSTILE_FAILED');
	});

	it('guards sign-up too', async () => {
		const h = harness();
		const email = uniqueEmail('ts-signup');
		const response = await h
			.client()
			.post('/sign-up/email', { name: 'Test', email, password: PASSWORD }, { turnstile: null });
		expect(response.status).toBe(400);
		const row = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?').bind(email).first();
		expect(row).toBeNull();
	});
});

describe('origin', () => {
	it('rejects a state-changing request from another origin', async () => {
		const h = harness();
		const response = await h
			.client()
			.post(
				'/sign-in/email',
				{ email: uniqueEmail(), password: PASSWORD },
				{ origin: 'https://evil.example' }
			);
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe('INVALID_ORIGIN');
	});

	it('rejects a state-changing request without Origin or Referer', async () => {
		const h = harness();
		const response = await h
			.client()
			.post('/sign-in/email', { email: uniqueEmail(), password: PASSWORD }, { origin: null });
		expect(response.status).toBe(403);
	});

	it('rejects a cross-origin request that carries the session cookie', async () => {
		const h = harness();
		const email = uniqueEmail('csrf');
		await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		const response = await client.post(
			'/change-password',
			{ currentPassword: PASSWORD, newPassword: 'attacker chosen 1234' },
			{ origin: 'https://evil.example' }
		);
		expect(response.status).toBe(403);
		expect((await h.client().signIn(email, PASSWORD)).status).toBe(200);
	});

	it('rejects an untrusted callbackURL', async () => {
		const h = harness();
		const response = await h.client().post('/request-password-reset', {
			email: uniqueEmail(),
			redirectTo: 'https://evil.example/x'
		});
		expect(response.status).toBe(403);
	});
});

describe('cookies', () => {
	function sessionCookie(response: Response): string {
		const line = response.headers.getSetCookie().find((value) => value.includes('session_token='));
		if (!line) throw new Error('no session cookie');
		return line;
	}

	it('sets the session cookie HttpOnly, SameSite=Lax and Secure on an https origin', async () => {
		const h = harness();
		const email = uniqueEmail('cookie');
		await createVerifiedUser(h, email);
		const line = sessionCookie(await h.client().signIn(email));
		expect(line).toMatch(/^__Secure-open-auri\.session_token=/);
		expect(line).toMatch(/;\s*HttpOnly/i);
		expect(line).toMatch(/;\s*SameSite=Lax/i);
		expect(line).toMatch(/;\s*Secure/i);
		expect(line).toMatch(/;\s*Path=\//i);
	});

	it('drops Secure for a plain-http local origin', async () => {
		const h = harness({ publicOrigin: 'http://localhost:5173' });
		const email = uniqueEmail('cookie-http');
		await createVerifiedUser(h, email);
		const line = sessionCookie(await h.client().signIn(email));
		expect(line).toMatch(/^open-auri\.session_token=/);
		expect(line).toMatch(/;\s*HttpOnly/i);
		expect(line).toMatch(/;\s*SameSite=Lax/i);
		expect(line).not.toMatch(/;\s*Secure/i);
	});
});

describe('nickname rules', () => {
	it('normalizes the nickname and keeps the display form', async () => {
		const h = harness();
		const email = uniqueEmail('nick');
		const nick = uniqueUsername('Nick');
		await createVerifiedUser(h, email, { username: nick, displayUsername: nick });
		const row = await env.DB.prepare(
			'SELECT username, displayUsername, usernameSkeleton FROM "user" WHERE email = ?'
		)
			.bind(email)
			.first<{ username: string; displayUsername: string; usernameSkeleton: string }>();
		expect(row?.username).toBe(nick.toLowerCase());
		expect(row?.displayUsername).toBe(nick);
		expect(row?.usernameSkeleton).toBeTruthy();
	});

	it('refuses reserved nicknames and their look-alikes as taken', async () => {
		const h = harness();
		for (const username of ['admin', 'Adm1n', 'open_auri']) {
			const response = await h.client().signUp(uniqueEmail('reserved'), { username });
			expect(response.status).toBe(400);
			expect(await errorCode(response)).toBe('USERNAME_IS_ALREADY_TAKEN');
		}
	});

	it('refuses a nickname whose skeleton is already taken', async () => {
		const h = harness();
		const base = `pau1o${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
		await createVerifiedUser(h, uniqueEmail('skeleton-a'), { username: base });
		const lookalike = base.replace('pau1o', 'paulo');
		const response = await h.client().signUp(uniqueEmail('skeleton-b'), { username: lookalike });
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe('USERNAME_IS_ALREADY_TAKEN');
	});

	it('refuses malformed nicknames and a display form that differs from the nickname', async () => {
		const h = harness();
		const bad = await h.client().signUp(uniqueEmail('badnick'), { username: 'no spaces allowed' });
		expect(bad.status).toBe(400);
		expect(await errorCode(bad)).toBe('INVALID_USERNAME');
		const mismatch = await h.client().signUp(uniqueEmail('mismatch'), {
			username: uniqueUsername('real'),
			displayUsername: 'Admin'
		});
		expect(mismatch.status).toBe(400);
		expect(await errorCode(mismatch)).toBe('DISPLAY_USERNAME_MISMATCH');
	});

	it('signs in with the nickname', async () => {
		const h = harness();
		const email = uniqueEmail('nick-signin');
		const nick = uniqueUsername('login');
		await createVerifiedUser(h, email, { username: nick });
		const response = await h.client().post('/sign-in/username', {
			username: nick.toUpperCase(),
			password: PASSWORD
		});
		expect(response.status).toBe(200);
	});
});

describe('logs', () => {
	it('never print e-mail addresses, passwords, IPs or tokens', async () => {
		const lines: string[] = [];
		const capture = (...args: unknown[]) => {
			lines.push(
				args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
			);
		};
		for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			vi.spyOn(console, method).mockImplementation(capture);
		}
		const h = harness();
		const email = uniqueEmail('pii');
		await createVerifiedUser(h, email);
		const client = h.client();
		await client.signUp(email);
		await client.signIn(email, 'a wrong password value');
		await client.signIn(uniqueEmail('pii-unknown'), 'a wrong password value');
		await client.post('/request-password-reset', { email: uniqueEmail('pii-reset') });
		await client.post(
			'/sign-in/email',
			{ email, password: PASSWORD },
			{ origin: 'https://evil.example' }
		);
		await client.post('/sign-in/email', { email, password: PASSWORD }, { turnstile: 'bad' });
		await h.flush();
		const output = lines.join('\n');
		expect(output).not.toContain(email);
		expect(output).not.toContain('@example.com');
		expect(output).not.toContain(PASSWORD);
		expect(output).not.toContain('a wrong password value');
		expect(output).not.toContain(client.ip);
		expect(output).not.toContain('evil.example');
	});
});
