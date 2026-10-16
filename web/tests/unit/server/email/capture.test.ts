// Dev mail capture guards (no D1 needed: every refused path must return before touching it).
// The storage itself is covered in tests/integration/email/capture.test.ts.
import { describe, expect, it } from 'vitest';
import {
	createCaptureProvider,
	DEV_MAILBOX_PATH,
	mailboxKey,
	readMailbox,
	respondToMailboxRequest
} from '#lib/server/email/capture.ts';
import { isLocalOrigin, type ServerEnv } from '#lib/server/env.ts';
import { DUMMY_TURNSTILE_TOKEN, localTestTurnstile } from '#lib/server/security/turnstile.ts';

/** A D1 stand-in that fails the test if any refused path reaches the database. */
const untouchableDb = new Proxy(
	{},
	{
		get() {
			throw new Error('the database must not be touched');
		}
	}
) as ServerEnv['db'];

type CaptureEnv = Pick<ServerEnv, 'db' | 'publicOrigin' | 'emailTransport'>;

const env = (emailTransport: ServerEnv['emailTransport'], publicOrigin: string): CaptureEnv => ({
	db: untouchableDb,
	emailTransport,
	publicOrigin
});

describe('isLocalOrigin', () => {
	it('accepts only the loopback hosts', () => {
		for (const origin of ['http://localhost', 'http://localhost:4174', 'http://127.0.0.1:8787']) {
			expect(isLocalOrigin(origin), origin).toBe(true);
		}
		for (const origin of [
			'https://open-auri.example.org',
			'https://localhost.example.org',
			'https://127.0.0.1.nip.io',
			'http://[::1]:4173',
			'http://0.0.0.0:4173',
			'',
			'localhost'
		]) {
			expect(isLocalOrigin(origin), origin).toBe(false);
		}
	});
});

describe('capture provider and mailbox guards', () => {
	it('refuses to build or read outside a local capture env', async () => {
		for (const config of [
			env('resend', 'http://localhost:4173'),
			env('capture', 'https://open-auri.example.org')
		]) {
			expect(() => createCaptureProvider(config)).toThrow(/local origin/);
			await expect(readMailbox(config, 'a@example.test')).rejects.toThrow(/local origin/);
		}
	});

	it('answers an empty 404 unless transport, origin and request host are all local', async () => {
		const query = `${DEV_MAILBOX_PATH}?to=a%40example.test`;
		const cases: [CaptureEnv, string][] = [
			[env('resend', 'http://localhost:4173'), `http://localhost:4173${query}`],
			[env('capture', 'https://open-auri.example.org'), `http://localhost:4173${query}`],
			[env('capture', 'http://localhost:4173'), `https://open-auri.example.org${query}`]
		];
		for (const [config, url] of cases) {
			const response = await respondToMailboxRequest(new Request(url), config);
			expect(response.status, url).toBe(404);
			expect(await response.text()).toBe('');
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
	});

	it('validates the address and the method before reading', async () => {
		const config = env('capture', 'http://localhost:4173');
		const missing = await respondToMailboxRequest(
			new Request(`http://localhost:4173${DEV_MAILBOX_PATH}?to=nope`),
			config
		);
		expect(missing.status).toBe(400);
		const post = await respondToMailboxRequest(
			new Request(`http://localhost:4173${DEV_MAILBOX_PATH}?to=a%40example.test`, {
				method: 'POST'
			}),
			config
		);
		expect(post.status).toBe(405);
	});

	it('keys mailboxes by the normalized address', async () => {
		expect(await mailboxKey(' A@Example.Test ')).toBe(await mailboxKey('a@example.test'));
		expect(await mailboxKey('a@example.test')).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('local Turnstile stub gating', () => {
	it('follows the same rule as the capture transport', async () => {
		expect(
			localTestTurnstile({ emailTransport: 'resend', publicOrigin: 'http://localhost' })
		).toBeNull();
		expect(
			localTestTurnstile({ emailTransport: 'capture', publicOrigin: 'https://example.org' })
		).toBeNull();
		const verify = localTestTurnstile({
			emailTransport: 'capture',
			publicOrigin: 'http://localhost:4174'
		});
		expect(
			await verify?.({
				token: DUMMY_TURNSTILE_TOKEN,
				action: 'sign-in',
				hostname: 'x',
				secret: 'y'
			})
		).toEqual({ ok: true });
	});
});
