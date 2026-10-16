// Resend webhook against the local D1: svix verification, suppression rows, replay protection,
// missing secret, PII-free logs. Fixtures are signed here with WebCrypto, independently of the
// module under test.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuppressionList } from '#lib/server/email/suppression.ts';
import { respondToResendWebhook } from '#lib/server/email/webhook.ts';
import { getServerEnv, type ServerEnv } from '#lib/server/env.ts';

const URL_ = 'https://open-auri.example/api/webhooks/resend';
const NOW_MS = Date.UTC(2026, 9, 16, 12, 0, 0);
const NOW_S = String(NOW_MS / 1000);

function serverEnv(): ServerEnv {
	return getServerEnv({ env });
}

function webhookSecret(): string {
	const secret = env.RESEND_WEBHOOK_SECRET;
	if (!secret) throw new Error('integration config must set RESEND_WEBHOOK_SECRET');
	return secret;
}

async function sign(id: string, timestamp: string, body: string, secret = webhookSecret()) {
	const raw = atob(secret.replace(/^whsec_/, ''));
	const keyBytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
	const algorithm = { name: 'HMAC', hash: 'SHA-256' };
	const key = await crypto.subtle.importKey('raw', keyBytes, algorithm, false, ['sign']);
	const data = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
	return btoa(String.fromCharCode(...mac));
}

interface Delivery {
	id: string;
	body: string;
	timestamp?: string;
	signature?: string;
	headers?: Record<string, string>;
	method?: string;
}

async function deliver(delivery: Delivery, target: ServerEnv = serverEnv()): Promise<Response> {
	const timestamp = delivery.timestamp ?? NOW_S;
	const signature = delivery.signature ?? `v1,${await sign(delivery.id, timestamp, delivery.body)}`;
	const request = new Request(URL_, {
		method: delivery.method ?? 'POST',
		headers: {
			'content-type': 'application/json',
			'svix-id': delivery.id,
			'svix-timestamp': timestamp,
			'svix-signature': signature,
			...delivery.headers
		},
		...(delivery.method && delivery.method !== 'POST' ? {} : { body: delivery.body })
	});
	return respondToResendWebhook(request, target, { now: () => NOW_MS });
}

function bounced(to: string, type = 'Permanent'): string {
	return JSON.stringify({
		type: 'email.bounced',
		created_at: '2026-10-16T12:00:00.000Z',
		data: {
			email_id: 'e_1',
			from: 'open-auri <noreply@open-auri.example>',
			to: [to],
			subject: 'Confirme seu e-mail no open-auri',
			bounce: { message: `550 mailbox ${to} unavailable`, subType: 'General', type }
		}
	});
}

function complained(to: string): string {
	return JSON.stringify({
		type: 'email.complained',
		created_at: '2026-10-16T12:00:00.000Z',
		data: { email_id: 'e_2', to: [to], subject: 'x' }
	});
}

async function suppression(address: string) {
	const target = serverEnv();
	const hash = await new SuppressionList(target.db, target.secrets.betterAuthSecret).hash(address);
	return target.db
		.prepare('SELECT reason, event_id FROM email_suppressions WHERE address_hash = ?')
		.bind(hash)
		.first<{ reason: string; event_id: string | null }>();
}

async function countEvents(id: string): Promise<number> {
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_webhook_events WHERE id = ?')
		.bind(id)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

const ADDRESSES: string[] = [];
function address(label: string): string {
	const value = `${label}.${ADDRESSES.length}@example.com`;
	ADDRESSES.push(value);
	return value;
}

function spyConsole() {
	return (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
		vi.spyOn(console, method).mockImplementation(() => undefined)
	);
}

let spies: ReturnType<typeof spyConsole> = [];

beforeEach(() => {
	spies = spyConsole();
});

afterEach(() => {
	const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
	for (const value of ADDRESSES) expect(logged).not.toContain(value);
	expect(logged).not.toContain(webhookSecret());
	vi.restoreAllMocks();
});

describe('Resend webhook', () => {
	it('suppresses a hard bounce on a valid signature', async () => {
		const to = address('hard-bounce');
		const response = await deliver({ id: 'msg_bounce_1', body: bounced(to) });
		expect(response.status).toBe(204);
		expect(await suppression(to)).toEqual({ reason: 'bounce', event_id: 'msg_bounce_1' });
		expect(await countEvents('msg_bounce_1')).toBe(1);
	});

	it('suppresses a complaint', async () => {
		const to = address('complaint');
		const response = await deliver({ id: 'msg_complaint_1', body: complained(to) });
		expect(response.status).toBe(204);
		expect(await suppression(to)).toEqual({ reason: 'complaint', event_id: 'msg_complaint_1' });
	});

	it('ignores transient bounces and other events', async () => {
		const transient = address('transient');
		const soft = await deliver({ id: 'msg_soft_1', body: bounced(transient, 'Transient') });
		expect(soft.status).toBe(204);
		expect(await suppression(transient)).toBeNull();

		const delivered = JSON.stringify({ type: 'email.delivered', data: { to: [address('ok')] } });
		const other = await deliver({ id: 'msg_delivered_1', body: delivered });
		expect(other.status).toBe(204);
		expect(await countEvents('msg_delivered_1')).toBe(0);
	});

	it('rejects an invalid signature with 401 and writes nothing', async () => {
		const to = address('forged');
		const body = bounced(to);
		const forged = await sign('msg_forged_1', NOW_S, body, 'whsec_d3Jvbmcta2V5LWZvci10ZXN0cw==');
		const response = await deliver({ id: 'msg_forged_1', body, signature: `v1,${forged}` });
		expect(response.status).toBe(401);
		expect(await suppression(to)).toBeNull();
		expect(await countEvents('msg_forged_1')).toBe(0);
	});

	it('rejects a body changed after signing', async () => {
		const to = address('tampered');
		const signature = `v1,${await sign('msg_tamper_1', NOW_S, bounced(address('original')))}`;
		const response = await deliver({ id: 'msg_tamper_1', body: bounced(to), signature });
		expect(response.status).toBe(401);
		expect(await suppression(to)).toBeNull();
	});

	it('rejects a stale timestamp with 401', async () => {
		const to = address('stale');
		const timestamp = String(NOW_MS / 1000 - 6 * 60);
		const response = await deliver({ id: 'msg_stale_1', body: bounced(to), timestamp });
		expect(response.status).toBe(401);
		expect(await suppression(to)).toBeNull();
	});

	it('answers a replayed svix-id without writing again', async () => {
		const to = address('replay');
		const body = bounced(to);
		expect((await deliver({ id: 'msg_replay_1', body })).status).toBe(204);
		expect(await suppression(to)).not.toBeNull();

		// Lift the suppression by hand, then replay the same delivery (fresh timestamp, valid
		// signature): the event is recognized and the row is not recreated.
		const target = serverEnv();
		const hash = await new SuppressionList(target.db, target.secrets.betterAuthSecret).hash(to);
		await env.DB.prepare('DELETE FROM email_suppressions WHERE address_hash = ?').bind(hash).run();

		const later = String(Number(NOW_S) + 60);
		expect((await deliver({ id: 'msg_replay_1', body, timestamp: later })).status).toBe(204);
		expect(await suppression(to)).toBeNull();
		expect(await countEvents('msg_replay_1')).toBe(1);
	});

	it('returns 400 when svix headers are missing', async () => {
		const response = await deliver({
			id: 'msg_headers_1',
			body: bounced(address('headers')),
			headers: { 'svix-signature': '' }
		});
		expect(response.status).toBe(400);
	});

	it('returns 400 for a signed body that is not JSON', async () => {
		expect((await deliver({ id: 'msg_json_1', body: 'not json' })).status).toBe(400);
	});

	it('answers 503 and logs a PII-free warning when the secret is missing', async () => {
		const base = serverEnv();
		const withoutSecret: ServerEnv = {
			...base,
			secrets: { ...base.secrets, resendWebhookSecret: null }
		};
		const to = address('no-secret');
		const response = await deliver({ id: 'msg_nosecret_1', body: bounced(to) }, withoutSecret);
		expect(response.status).toBe(503);
		expect(await suppression(to)).toBeNull();
		const warn = spies[2];
		expect(warn).toHaveBeenCalledWith('email.webhook disabled', {
			reason: 'RESEND_WEBHOOK_SECRET is not set'
		});
	});

	it('refuses other methods and oversized bodies', async () => {
		const get = await deliver({ id: 'msg_get_1', body: '', method: 'GET' });
		expect(get.status).toBe(405);
		const huge = JSON.stringify({ type: 'email.bounced', pad: 'x'.repeat(200 * 1024) });
		expect((await deliver({ id: 'msg_huge_1', body: huge })).status).toBe(413);
	});
});
