import { describe, expect, it, vi } from 'vitest';
import { EmailError, type EmailMessage } from '#lib/server/email/provider.ts';
import {
	parseRetryAfter,
	RESEND_ENDPOINT,
	ResendProvider,
	type FetchInit,
	type FetchResponse
} from '#lib/server/email/resend.ts';

const ADDRESS = 'pessoa.teste@example.com';

const message: EmailMessage = {
	to: ADDRESS,
	subject: 'Assunto',
	html: '<p>oi</p>',
	text: 'oi',
	idempotencyKey: 'verify-email:abc123',
	tags: [{ name: 'template', value: 'verify-email' }]
};

type Step = () => FetchResponse | Promise<FetchResponse>;

function reply(status: number, body: unknown = {}, headers: Record<string, string> = {}): Step {
	return () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json', ...headers }
		});
}

function scripted(...steps: Step[]) {
	const calls: { url: string; init: FetchInit }[] = [];
	const fetch = async (url: string, init: FetchInit): Promise<FetchResponse> => {
		calls.push({ url, init });
		const step = steps[calls.length - 1];
		if (!step) throw new Error('unexpected extra request');
		return step();
	};
	const sleeps: number[] = [];
	const sleep = async (ms: number) => {
		sleeps.push(ms);
	};
	const provider = new ResendProvider({
		apiKey: 're_unit_test',
		from: 'open-auri <noreply@open-auri.example>',
		userAgent: 'open-auri-web/test',
		fetch,
		sleep,
		random: () => 0.5
	});
	return { provider, calls, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<EmailError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof EmailError) return error;
		throw error;
	}
	throw new Error('expected the send to fail');
}

describe('ResendProvider', () => {
	it('posts the message with auth, user agent and idempotency headers', async () => {
		const { provider, calls } = scripted(reply(200, { id: 'msg_1' }));
		await expect(provider.send(message)).resolves.toEqual({ id: 'msg_1' });

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.url).toBe(RESEND_ENDPOINT);
		expect(call?.init.method).toBe('POST');
		expect(call?.init.headers).toEqual({
			Authorization: 'Bearer re_unit_test',
			'Content-Type': 'application/json',
			'User-Agent': 'open-auri-web/test',
			'Idempotency-Key': 'verify-email:abc123'
		});
		expect(JSON.parse(call?.init.body ?? '')).toEqual({
			from: 'open-auri <noreply@open-auri.example>',
			to: [ADDRESS],
			subject: 'Assunto',
			html: '<p>oi</p>',
			text: 'oi',
			tags: [{ name: 'template', value: 'verify-email' }]
		});
	});

	it('retries 5xx with exponential backoff and jitter, keeping the idempotency key', async () => {
		const { provider, calls, sleeps } = scripted(
			reply(500),
			reply(502),
			reply(200, { id: 'msg_2' })
		);
		await expect(provider.send(message)).resolves.toEqual({ id: 'msg_2' });
		expect(calls).toHaveLength(3);
		expect(new Set(calls.map((c) => c.init.headers['Idempotency-Key']))).toEqual(
			new Set(['verify-email:abc123'])
		);
		// base 300 ms, equal jitter with random() = 0.5: 150 + 75, then 300 + 150.
		expect(sleeps).toEqual([225, 450]);
	});

	it('honors Retry-After on 429', async () => {
		const { provider, sleeps } = scripted(
			reply(429, { name: 'rate_limit_exceeded' }, { 'Retry-After': '2' }),
			reply(200, { id: 'msg_3' })
		);
		await expect(provider.send(message)).resolves.toEqual({ id: 'msg_3' });
		expect(sleeps).toEqual([2000]);
	});

	it('gives up at once when Retry-After exceeds the delay budget', async () => {
		const { provider, calls, sleeps } = scripted(
			reply(429, { name: 'daily_quota_exceeded' }, { 'Retry-After': '3600' })
		);
		const error = await failure(provider.send(message));
		expect(error.kind).toBe('rate-limited');
		expect(error.code).toBe('daily_quota_exceeded');
		expect(calls).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	it('stops after three attempts', async () => {
		const { provider, calls, sleeps } = scripted(reply(503), reply(503), reply(503));
		const error = await failure(provider.send(message));
		expect(error.kind).toBe('unavailable');
		expect(error.status).toBe(503);
		expect(calls).toHaveLength(3);
		expect(sleeps).toHaveLength(2);

		const limited = scripted(reply(429), reply(429), reply(429));
		expect((await failure(limited.provider.send(message))).kind).toBe('rate-limited');
		expect(limited.calls).toHaveLength(3);
	});

	it.each([
		[400, 'invalid'],
		[422, 'invalid'],
		[404, 'invalid'],
		[401, 'rejected'],
		[403, 'rejected']
	] as const)('does not retry %i', async (status, kind) => {
		const { provider, calls, sleeps } = scripted(reply(status, { name: 'validation_error' }));
		const error = await failure(provider.send(message));
		expect(error.kind).toBe(kind);
		expect(error.status).toBe(status);
		expect(calls).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	it('retries 409 concurrent_idempotent_requests but not invalid_idempotent_request', async () => {
		const concurrent = scripted(
			reply(409, { name: 'concurrent_idempotent_requests' }),
			reply(200, { id: 'msg_4' })
		);
		await expect(concurrent.provider.send(message)).resolves.toEqual({ id: 'msg_4' });
		expect(concurrent.calls).toHaveLength(2);

		const conflict = scripted(reply(409, { name: 'invalid_idempotent_request' }));
		const error = await failure(conflict.provider.send(message));
		expect(error.kind).toBe('invalid');
		expect(error.code).toBe('invalid_idempotent_request');
		expect(conflict.calls).toHaveLength(1);
	});

	it('retries network failures (the idempotency key makes a duplicate harmless)', async () => {
		const { provider, calls } = scripted(
			() => {
				throw new TypeError('network down');
			},
			reply(200, { id: 'msg_5' })
		);
		await expect(provider.send(message)).resolves.toEqual({ id: 'msg_5' });
		expect(calls).toHaveLength(2);
	});

	it('treats a success without an id as unavailable, without retrying', async () => {
		const { provider, calls } = scripted(reply(200, {}));
		expect((await failure(provider.send(message))).kind).toBe('unavailable');
		expect(calls).toHaveLength(1);
	});

	it('never puts the address, the subject or the vendor message in the error', async () => {
		const { provider } = scripted(
			reply(422, { name: 'validation_error', message: `Invalid \`to\` field: ${ADDRESS}` })
		);
		const error = await failure(provider.send(message));
		expect(error.message).not.toContain(ADDRESS);
		expect(error.message).not.toContain('Assunto');
		expect(error.message).not.toContain('Invalid');
		expect(error.message).toContain('validation_error');
	});

	it.each([
		['empty', ''],
		['too long', 'k'.repeat(257)],
		['with spaces', 'verify email'],
		['non-ASCII', 'verificação']
	])('rejects an idempotency key that is %s before any request', async (_label, key) => {
		const { provider, calls } = scripted(reply(200, { id: 'never' }));
		const error = await failure(provider.send({ ...message, idempotencyKey: key }));
		expect(error.kind).toBe('invalid');
		expect(calls).toHaveLength(0);
	});

	it('accepts a 256-character idempotency key', async () => {
		const { provider, calls } = scripted(reply(200, { id: 'msg_6' }));
		await provider.send({ ...message, idempotencyKey: 'k'.repeat(256) });
		expect(calls).toHaveLength(1);
	});

	it('rejects malformed tags and recipients before any request', async () => {
		const { provider, calls } = scripted(reply(200, { id: 'never' }));
		const badTag = await failure(
			provider.send({ ...message, tags: [{ name: 'template', value: 'has space' }] })
		);
		expect(badTag.kind).toBe('invalid');
		const badTo = await failure(provider.send({ ...message, to: `${ADDRESS}\r\nBcc: x@y.z` }));
		expect(badTo.kind).toBe('invalid');
		expect(badTo.message).not.toContain(ADDRESS);
		expect(calls).toHaveLength(0);
	});

	it('requires credentials, sender and user agent', () => {
		const base = { apiKey: 'k', from: 'a@b.c', userAgent: 'ua' };
		expect(() => new ResendProvider({ ...base, apiKey: '' })).toThrow(EmailError);
		expect(() => new ResendProvider({ ...base, from: '' })).toThrow(EmailError);
		expect(() => new ResendProvider({ ...base, userAgent: '' })).toThrow(EmailError);
	});

	it('uses the global fetch at call time by default', async () => {
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify({ id: 'msg_global' }), { status: 200 }));
		try {
			const provider = new ResendProvider({ apiKey: 'k', from: 'a@b.c', userAgent: 'ua' });
			await expect(provider.send(message)).resolves.toEqual({ id: 'msg_global' });
			expect(spy).toHaveBeenCalledOnce();
		} finally {
			spy.mockRestore();
		}
	});
});

describe('parseRetryAfter', () => {
	const now = Date.UTC(2026, 9, 16, 12, 0, 0);

	it('reads delta-seconds and HTTP dates', () => {
		expect(parseRetryAfter('3', now)).toBe(3000);
		expect(parseRetryAfter(' 0 ', now)).toBe(0);
		expect(parseRetryAfter(new Date(now + 5000).toUTCString(), now)).toBe(5000);
		expect(parseRetryAfter(new Date(now - 5000).toUTCString(), now)).toBe(0);
	});

	it('ignores absent or malformed values', () => {
		expect(parseRetryAfter(null, now)).toBeNull();
		expect(parseRetryAfter('soon', now)).toBeNull();
	});
});
