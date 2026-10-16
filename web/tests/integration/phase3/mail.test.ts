// T3.T transactional e-mail properties across the auth flows:
//   - idempotency: every Resend call carries an Idempotency-Key `<template>:<sha256>` that never
//     contains the address, and the same logical message keeps the same key on re-send;
//   - suppression: once a signed bounce webhook suppresses an address, flows answer exactly the
//     same but nothing is sent to it.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { http } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthMailer } from '#lib/server/auth/emails.ts';
import { createCaptureProvider, readMailbox } from '#lib/server/email/capture.ts';
import { RESEND_ENDPOINT } from '#lib/server/email/index.ts';
import {
	computeSvixSignature,
	parseSvixSecret,
	respondToResendWebhook
} from '#lib/server/email/webhook.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { createVerifiedUser, uniqueEmail } from '../auth/harness.ts';
import { harness, rawEnv } from './helpers.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

describe('idempotency', () => {
	it('every outgoing e-mail has a stable, address-free Idempotency-Key', async () => {
		const h = harness(network);
		const seen: { key: string; to: string; template: string }[] = [];
		// Registered after mockNetwork: msw tries the newest handler first, so it observes and
		// falls through to the harness outbox handler.
		network.use(
			http.post(RESEND_ENDPOINT, async ({ request }) => {
				const body = (await request.clone().json()) as {
					to: string[];
					tags?: { name: string; value: string }[];
				};
				seen.push({
					key: request.headers.get('idempotency-key') ?? '',
					to: body.to[0] ?? '',
					template: body.tags?.find((tag) => tag.name === 'template')?.value ?? ''
				});
				return undefined;
			})
		);
		const email = uniqueEmail('idem');
		await createVerifiedUser(h, email);
		await h.client().post('/request-password-reset', { email });
		await h.flush();
		expect(seen.length).toBeGreaterThanOrEqual(2);
		for (const entry of seen) {
			expect(entry.key).toMatch(/^[a-z0-9-]+:[0-9a-f]{64}$/);
			expect(entry.key.startsWith(`${entry.template}:`)).toBe(true);
			expect(entry.key).not.toContain(entry.to);
			expect(entry.key.toLowerCase()).not.toContain(email.split('@')[0]?.toLowerCase() ?? '@');
		}
		expect(new Set(seen.map((entry) => entry.key)).size).toBe(seen.length);
	});

	it('the same logical message re-sent is delivered once (capture transport mirrors Resend)', async () => {
		const local = getServerEnv({
			env: rawEnv({ EMAIL_TRANSPORT: 'capture', PUBLIC_ORIGIN: 'http://localhost:4173' })
		});
		const pending: Promise<unknown>[] = [];
		const mailer = createAuthMailer({
			provider: createCaptureProvider(local),
			origin: local.publicOrigin,
			waitUntil: (promise) => {
				pending.push(promise);
			}
		});
		const user = { id: `idem-${crypto.randomUUID()}`, email: uniqueEmail('idem-capture') };
		const url = `${local.publicOrigin}/api/auth/verify-email?token=abc`;
		await mailer.verification(user, url, 'token-1');
		await mailer.verification(user, url, 'token-1');
		await Promise.allSettled(pending.splice(0));
		expect(await readMailbox(local, user.email)).toHaveLength(1);
		await mailer.verification(user, url, 'token-2');
		await Promise.allSettled(pending.splice(0));
		expect(await readMailbox(local, user.email)).toHaveLength(2);
	});
});

async function bounce(address: string): Promise<number> {
	const body = JSON.stringify({
		type: 'email.bounced',
		data: { to: [address], bounce: { type: 'Permanent' } }
	});
	const key = parseSvixSecret(String(env.RESEND_WEBHOOK_SECRET));
	if (!key) throw new Error('webhook secret missing');
	const id = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = await computeSvixSignature(key, id, timestamp, body);
	const response = await respondToResendWebhook(
		new Request('https://webhook.invalid/api/webhooks/resend', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'svix-id': id,
				'svix-timestamp': timestamp,
				'svix-signature': `v1,${signature}`
			},
			body
		}),
		getServerEnv({ env }),
		{ logger: { warn: () => undefined, info: () => undefined } }
	);
	return response.status;
}

describe('suppression', () => {
	it('a hard-bounced address gets nothing more, and the flows answer exactly the same', async () => {
		const h = harness(network);
		const bounced = uniqueEmail('suppressed');
		const healthy = uniqueEmail('healthy');
		await createVerifiedUser(h, bounced);
		await createVerifiedUser(h, healthy);
		expect(await bounce(bounced.toUpperCase())).toBe(204);

		const before = h.mails(bounced).length;
		const answers = [];
		for (const email of [bounced, healthy]) {
			const response = await h.client().post('/request-password-reset', { email });
			answers.push({ status: response.status, body: await response.json() });
		}
		expect(answers[0]).toEqual(answers[1]);
		await h.flush();
		expect(h.mails(bounced).length).toBe(before);
		expect(h.mails(healthy, 'reset-password')).toHaveLength(1);
	});
});
