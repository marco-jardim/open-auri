// Resend adapter + D1 suppression inside workerd. Resend is mocked with @msw/cloudflare; any
// request without a handler fails instead of reaching the network.
import { setupNetwork } from '@msw/cloudflare';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { run } from '#lib/server/db.ts';
import {
	buildIdempotencyKey,
	createEmailProvider,
	EmailError,
	queueEmail,
	RESEND_ENDPOINT,
	SuppressionList,
	verifyEmail,
	type EmailMessage
} from '#lib/server/email/index.ts';
import { getServerEnv } from '#lib/server/env.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});

afterEach(() => {
	network.resetHandlers();
	vi.restoreAllMocks();
});

afterAll(async () => {
	await network.disable();
});

interface Captured {
	headers: Record<string, string>;
	body: unknown;
}

interface Reply {
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
}

/** Answers each Resend request with the next reply (500 once they run out), recording requests. */
function resendReplies(...replies: Reply[]) {
	const captured: Captured[] = [];
	network.use(
		http.post(RESEND_ENDPOINT, async ({ request }) => {
			captured.push({
				headers: Object.fromEntries(request.headers.entries()),
				body: await request.json()
			});
			const next = replies[captured.length - 1] ?? { status: 500 };
			return HttpResponse.json(next.body ?? {}, { status: next.status, headers: next.headers });
		})
	);
	return captured;
}

let counter = 0;
async function message(to: string): Promise<EmailMessage> {
	counter += 1;
	const rendered = verifyEmail('pt-BR', {
		origin: 'https://open-auri.example',
		url: `https://open-auri.example/verificar-email?token=tok_${counter}`,
		expiresInMinutes: 60
	});
	return {
		to,
		...rendered,
		idempotencyKey: await buildIdempotencyKey(
			'verify-email',
			`user_${counter}`,
			`token_${counter}`
		),
		tags: [{ name: 'template', value: 'verify-email' }]
	};
}

function provider() {
	const sleeps: number[] = [];
	const instance = createEmailProvider(getServerEnv({ env }), {
		sleep: async (ms) => {
			sleeps.push(ms);
		}
	});
	return { provider: instance, sleeps };
}

async function rejection(promise: Promise<unknown>): Promise<EmailError> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e
	);
	if (!(error instanceof EmailError)) throw new Error('expected an EmailError');
	return error;
}

describe('Resend adapter (mocked network)', () => {
	it('sends the idempotency key, keeps it stable across retries, and returns the id', async () => {
		const captured = resendReplies({ status: 500 }, { status: 200, body: { id: 're_msg_1' } });
		const { provider: email, sleeps } = provider();
		const msg = await message('idem@example.com');

		await expect(email.send(msg)).resolves.toEqual({ id: 're_msg_1' });
		expect(captured).toHaveLength(2);
		for (const request of captured) {
			expect(request.headers['idempotency-key']).toBe(msg.idempotencyKey);
			expect(request.headers['authorization']).toBe(`Bearer ${env.RESEND_API_KEY}`);
			expect(request.headers['user-agent']).toBe('open-auri-web/1');
			expect(request.headers['content-type']).toBe('application/json');
			expect(request.body).toMatchObject({
				from: env.RESEND_FROM,
				to: ['idem@example.com'],
				subject: msg.subject,
				tags: [{ name: 'template', value: 'verify-email' }]
			});
		}
		expect(sleeps).toHaveLength(1);
	});

	it('retries 429 honoring Retry-After, then succeeds', async () => {
		const captured = resendReplies(
			{ status: 429, body: { name: 'rate_limit_exceeded' }, headers: { 'Retry-After': '1' } },
			{ status: 200, body: { id: 're_msg_2' } }
		);
		const { provider: email, sleeps } = provider();
		await expect(email.send(await message('throttled@example.com'))).resolves.toEqual({
			id: 're_msg_2'
		});
		expect(captured).toHaveLength(2);
		expect(sleeps).toEqual([1000]);
	});

	it('gives up after three 5xx answers', async () => {
		const captured = resendReplies({ status: 500 }, { status: 502 }, { status: 503 });
		const { provider: email } = provider();
		const error = await rejection(email.send(await message('down@example.com')));
		expect(error.kind).toBe('unavailable');
		expect(captured).toHaveLength(3);
	});

	it.each([400, 422])('does not retry %i', async (status) => {
		const captured = resendReplies({
			status,
			body: { name: 'validation_error', message: 'Invalid `to` field: no-retry@example.com' }
		});
		const { provider: email, sleeps } = provider();
		const error = await rejection(email.send(await message('no-retry@example.com')));
		expect(error.kind).toBe('invalid');
		expect(error.message).not.toContain('no-retry@example.com');
		expect(captured).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});
});

describe('suppression list (D1)', () => {
	it('blocks suppressed addresses before any request, whatever their case', async () => {
		const captured = resendReplies({ status: 200, body: { id: 'never' } });
		const serverEnv = getServerEnv({ env });
		const list = new SuppressionList(serverEnv.db, serverEnv.secrets.betterAuthSecret);
		await run(await list.suppressStatement('Bounced@Example.com', 'bounce', Date.now(), null));

		const { provider: email } = provider();
		const error = await rejection(email.send(await message('  bounced@example.COM ')));
		expect(error.kind).toBe('suppressed');
		expect(captured).toHaveLength(0);

		// Only the hash is stored.
		const rows = await serverEnv.db
			.prepare('SELECT address_hash, reason FROM email_suppressions')
			.all<{ address_hash: string; reason: string }>();
		expect(rows.results.some((row) => row.address_hash.includes('@'))).toBe(false);
		expect(JSON.stringify(rows.results)).not.toContain('bounced');
	});

	it('still sends to addresses that are not suppressed', async () => {
		const captured = resendReplies({ status: 200, body: { id: 're_msg_ok' } });
		const { provider: email } = provider();
		await expect(email.send(await message('fine@example.com'))).resolves.toEqual({
			id: 're_msg_ok'
		});
		expect(captured).toHaveLength(1);
	});
});

describe('queueEmail (waitUntil)', () => {
	it('sends in the background and logs failures without personal data', async () => {
		const address = 'queued.person@example.com';
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
			vi.spyOn(console, method).mockImplementation(() => undefined)
		);
		const captured = resendReplies({ status: 503 }, { status: 503 }, { status: 503 });
		const ctx = createExecutionContext();
		const { provider: email } = provider();
		const msg = await message(address);

		queueEmail(ctx, email, { templateId: 'verify-email', message: msg });
		expect(captured).toHaveLength(0);
		await waitOnExecutionContext(ctx);

		expect(captured).toHaveLength(3);
		const warn = spies[2];
		expect(warn).toHaveBeenCalledWith('email.send failed', {
			template: 'verify-email',
			kind: 'unavailable',
			status: 503
		});
		const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
		for (const secret of [address, msg.subject, msg.idempotencyKey, 'tok_']) {
			expect(logged).not.toContain(secret);
		}
	});

	it('delivers once the context settles', async () => {
		const captured = resendReplies({ status: 200, body: { id: 're_msg_bg' } });
		const ctx = createExecutionContext();
		const { provider: email } = provider();
		const task = queueEmail(ctx, email, {
			templateId: 'verify-email',
			message: await message('background@example.com')
		});
		await waitOnExecutionContext(ctx);
		await expect(task).resolves.toBeUndefined();
		expect(captured).toHaveLength(1);
	});
});
