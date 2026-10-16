// Dev mail capture (EMAIL_TRANSPORT=capture): accepted only on a localhost origin, stores messages
// in D1 instead of calling Resend, serves them on GET /api/dev/mailbox, and 404s everywhere else.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from '#lib/server/auth.ts';
import {
	createCaptureProvider,
	DEV_MAILBOX_PATH,
	readMailbox,
	respondToMailboxRequest
} from '#lib/server/email/capture.ts';
import {
	createEmailProvider,
	isEmailError,
	RESEND_ENDPOINT,
	SuppressionList
} from '#lib/server/email/index.ts';
import { getServerEnv, isLocalOrigin, ServerEnvError } from '#lib/server/env.ts';
import { DUMMY_TURNSTILE_TOKEN, SITEVERIFY_URL } from '#lib/server/security/turnstile.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

const KEYS = [
	'DB',
	'CONFIG',
	'MEDIA',
	'ACCESS_LOG_QUEUE',
	'RL_AUTH',
	'RL_API',
	'RL_WRITE',
	'PUBLIC_ORIGIN',
	'GITHUB_URL',
	'RESEND_FROM',
	'ACCESS_LOG_ENABLED',
	'SIGNUP_ENABLED',
	'ADMIN_2FA_REQUIRED',
	'BETTER_AUTH_SECRET',
	'RESEND_API_KEY',
	'TURNSTILE_SECRET',
	'IPHASH_PEPPER',
	'ACCESS_LOG_KEY'
] as const;

function envWith(overrides: Record<string, string | undefined>): Record<string, unknown> {
	const copy: Record<string, unknown> = {};
	for (const key of KEYS) copy[key] = Reflect.get(env, key);
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete copy[key];
		else copy[key] = value;
	}
	return copy;
}

const LOCAL = 'http://localhost:4173';
const message = (to: string, key = crypto.randomUUID()) => ({
	to,
	subject: 'Subject',
	text: `Open ${LOCAL}/verificar?token=t`,
	html: '<p>Open</p>',
	idempotencyKey: `test:${key}`
});

describe('getServerEnv and EMAIL_TRANSPORT', () => {
	it('defaults to resend (missing) and keeps the rendered config on resend', () => {
		expect(getServerEnv({ env: envWith({ EMAIL_TRANSPORT: undefined }) }).emailTransport).toBe(
			'resend'
		);
		expect(getServerEnv({ env }).emailTransport).toBe('resend');
	});

	it('refuses capture on any non-local origin (production, staging, look-alikes)', () => {
		for (const origin of [
			'https://open-auri.example.org',
			'https://open-auri-staging.someone.workers.dev',
			'https://localhost.evil.example',
			'https://127.0.0.1.nip.io'
		]) {
			let caught: unknown;
			try {
				getServerEnv({ env: envWith({ EMAIL_TRANSPORT: 'capture', PUBLIC_ORIGIN: origin }) });
			} catch (error) {
				caught = error;
			}
			expect(caught, origin).toBeInstanceOf(ServerEnvError);
			const issues = caught instanceof ServerEnvError ? caught.issues : [];
			expect(issues.join(' '), origin).toMatch(/^EMAIL_TRANSPORT:/);
			expect(issues.join(' '), origin).not.toContain(origin);
		}
	});

	it('accepts capture on localhost and 127.0.0.1 only, and rejects unknown transports', () => {
		for (const origin of [LOCAL, 'http://127.0.0.1:8787']) {
			const local = getServerEnv({
				env: envWith({ EMAIL_TRANSPORT: 'capture', PUBLIC_ORIGIN: origin })
			});
			expect(local.emailTransport).toBe('capture');
		}
		expect(() => getServerEnv({ env: envWith({ EMAIL_TRANSPORT: 'smtp' }) })).toThrow(
			/EMAIL_TRANSPORT/
		);
		expect(isLocalOrigin('http://localhost')).toBe(true);
		expect(isLocalOrigin('https://example.org')).toBe(false);
		expect(isLocalOrigin('not a url')).toBe(false);
	});
});

describe('capture provider', () => {
	const local = () =>
		getServerEnv({ env: envWith({ EMAIL_TRANSPORT: 'capture', PUBLIC_ORIGIN: LOCAL }) });

	it('stores instead of calling Resend, newest first, deduplicated by idempotency key', async () => {
		let resendCalls = 0;
		network.resetHandlers();
		network.use(
			http.post(RESEND_ENDPOINT, () => {
				resendCalls += 1;
				return HttpResponse.json({ id: 'should-not-happen' });
			})
		);
		const to = `capture-${crypto.randomUUID()}@example.test`;
		const provider = createEmailProvider(local());
		const first = await provider.send(message(to, 'one'));
		expect(first.id).toMatch(/^capture_/);
		await provider.send(message(to, 'one'));
		await provider.send({ ...message(to, 'two'), subject: 'Second' });
		const mailbox = await readMailbox(local(), to.toUpperCase());
		expect(mailbox.map((mail) => mail.subject)).toEqual(['Second', 'Subject']);
		expect(mailbox[0]?.to).toBe(to);
		expect(resendCalls).toBe(0);
	});

	it('still honours the suppression list', async () => {
		const to = `capture-suppressed-${crypto.randomUUID()}@example.test`;
		const serverEnv = local();
		const list = new SuppressionList(serverEnv.db, serverEnv.secrets.betterAuthSecret);
		await (await list.suppressStatement(to, 'bounce', Date.now(), null)).run();
		const error = await createEmailProvider(serverEnv)
			.send(message(to))
			.catch((caught: unknown) => caught);
		expect(isEmailError(error) && error.kind).toBe('suppressed');
		expect(await readMailbox(serverEnv, to)).toEqual([]);
	});

	it('cannot be built or read outside a local capture env', async () => {
		const production = getServerEnv({ env });
		expect(() => createCaptureProvider(production)).toThrow(/local origin/);
		// Even a hand-made env that skipped getServerEnv is refused.
		const forged = { ...production, emailTransport: 'capture' as const };
		expect(() => createCaptureProvider(forged)).toThrow(/local origin/);
		await expect(readMailbox(forged, 'a@example.test')).rejects.toThrow(/local origin/);
	});
});

describe('GET /api/dev/mailbox (respondToMailboxRequest)', () => {
	const local = () =>
		getServerEnv({ env: envWith({ EMAIL_TRANSPORT: 'capture', PUBLIC_ORIGIN: LOCAL }) });

	it('is 404 with the production transport, a forged env or a non-loopback request', async () => {
		const query = `${DEV_MAILBOX_PATH}?to=a%40example.test`;
		const production = getServerEnv({ env });
		const forged = { ...production, emailTransport: 'capture' as const };
		for (const [serverEnv, url] of [
			[production, `${production.publicOrigin}${query}`],
			[production, `${LOCAL}${query}`],
			[forged, `${LOCAL}${query}`],
			[local(), `https://open-auri.example.org${query}`]
		] as const) {
			const response = await respondToMailboxRequest(new Request(url), serverEnv);
			expect(response.status, url).toBe(404);
			expect(await response.text()).toBe('');
		}
	});

	it('serves the latest messages of one address, never cached', async () => {
		const serverEnv = local();
		const to = `mailbox-${crypto.randomUUID()}@example.test`;
		await createCaptureProvider(serverEnv).send(message(to));
		await createCaptureProvider(serverEnv).send(message(`other-${to}`));
		const response = await respondToMailboxRequest(
			new Request(`${LOCAL}${DEV_MAILBOX_PATH}?to=${encodeURIComponent(to)}`),
			serverEnv
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = (await response.json()) as { messages: { to: string; text: string }[] };
		expect(body.messages).toHaveLength(1);
		expect(body.messages[0]?.text).toContain('/verificar?token=t');

		const missing = await respondToMailboxRequest(
			new Request(`${LOCAL}${DEV_MAILBOX_PATH}`),
			serverEnv
		);
		expect(missing.status).toBe(400);
		const post = await respondToMailboxRequest(
			new Request(`${LOCAL}${DEV_MAILBOX_PATH}?to=${encodeURIComponent(to)}`, { method: 'POST' }),
			serverEnv
		);
		expect(post.status).toBe(405);
	});

	it('receives the real auth e-mails (sign-up verification) in capture mode', async () => {
		let outbound = 0;
		network.resetHandlers();
		network.use(
			// Capture mode uses the local Turnstile stub: Siteverify must not be called.
			http.post(SITEVERIFY_URL, () => {
				outbound += 1;
				return HttpResponse.json({ success: false, 'error-codes': ['not-expected'] });
			}),
			http.post(RESEND_ENDPOINT, () => {
				outbound += 1;
				return HttpResponse.json({ error: 'not expected' }, { status: 500 });
			})
		);
		const serverEnv = local();
		const pending: Promise<unknown>[] = [];
		const auth = createAuth(
			{ ...serverEnv, flags: { ...serverEnv.flags, signupEnabled: true } },
			{ waitUntil: (promise) => void pending.push(promise) }
		);
		const email = `capture-signup-${crypto.randomUUID()}@example.test`;
		const response = await auth.handler(
			new Request(`${LOCAL}/api/auth/sign-up/email`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: LOCAL,
					'cf-connecting-ip': '10.77.0.1',
					'x-turnstile-token': DUMMY_TURNSTILE_TOKEN
				},
				body: JSON.stringify({ name: '', email, password: 'a long password 123' })
			})
		);
		expect(response.status).toBe(200);
		await Promise.allSettled(pending);
		expect(outbound).toBe(0);
		const mailbox = await readMailbox(serverEnv, email);
		expect(mailbox).toHaveLength(1);
		const link = /https?:\/\/\S+/.exec(mailbox[0]?.text ?? '')?.[0] ?? '';
		expect(new URL(link).origin).toBe(LOCAL);
		expect(new URL(link).searchParams.get('token')).toBeTruthy();
	});
});
