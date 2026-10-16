import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	computeSvixSignature,
	parseSvixSecret,
	suppressionIntent,
	verifySvixSignature
} from '#lib/server/email/webhook.ts';

const KEY_BASE64 = Buffer.from('unit-test-only-webhook-signing-key').toString('base64');
const SECRET = `whsec_${KEY_BASE64}`;
const ID = 'msg_2abcDEF123';
const NOW_MS = 1_792_152_000_000;
const TIMESTAMP = String(NOW_MS / 1000);
const BODY = JSON.stringify({ type: 'email.bounced', data: { to: ['x@example.com'] } });

/** Independent reference implementation (node:crypto), not the module under test. */
function nodeSign(id: string, timestamp: string, body: string): string {
	return createHmac('sha256', Buffer.from(KEY_BASE64, 'base64'))
		.update(`${id}.${timestamp}.${body}`)
		.digest('base64');
}

function input(overrides: Partial<Parameters<typeof verifySvixSignature>[0]> = {}) {
	return {
		secret: SECRET,
		id: ID,
		timestamp: TIMESTAMP,
		signature: `v1,${nodeSign(ID, TIMESTAMP, BODY)}`,
		body: BODY,
		nowMs: NOW_MS,
		...overrides
	};
}

describe('svix signature', () => {
	it('matches an independent HMAC-SHA256 implementation', async () => {
		const key = parseSvixSecret(SECRET);
		expect(key).not.toBeNull();
		if (!key) return;
		const signature = await computeSvixSignature(key, ID, TIMESTAMP, BODY);
		expect(signature).toBe(nodeSign(ID, TIMESTAMP, BODY));
	});

	it('accepts a valid signature, with or without the whsec_ prefix', async () => {
		expect(await verifySvixSignature(input())).toEqual({ ok: true });
		expect(await verifySvixSignature(input({ secret: KEY_BASE64 }))).toEqual({ ok: true });
	});

	it('accepts when any of several v1 signatures matches and ignores other versions', async () => {
		const good = nodeSign(ID, TIMESTAMP, BODY);
		const wrong = Buffer.alloc(32, 7).toString('base64');
		const signature = `v1,${wrong} v2,${good} v1,not-base64! v1,${good}`;
		expect(await verifySvixSignature(input({ signature }))).toEqual({ ok: true });
		expect(await verifySvixSignature(input({ signature: `v2,${good}` }))).toEqual({
			ok: false,
			reason: 'bad-signature'
		});
	});

	it('rejects a tampered body, id or timestamp', async () => {
		expect(await verifySvixSignature(input({ body: `${BODY} ` }))).toEqual({
			ok: false,
			reason: 'bad-signature'
		});
		expect(await verifySvixSignature(input({ id: 'msg_other' }))).toEqual({
			ok: false,
			reason: 'bad-signature'
		});
		const shifted = String(Number(TIMESTAMP) + 1);
		expect(await verifySvixSignature(input({ timestamp: shifted }))).toEqual({
			ok: false,
			reason: 'bad-signature'
		});
	});

	it('rejects a signature made with another key', async () => {
		const otherKey = Buffer.from('another-key').toString('base64');
		expect(await verifySvixSignature(input({ secret: `whsec_${otherKey}` }))).toEqual({
			ok: false,
			reason: 'bad-signature'
		});
	});

	it('enforces the 5 minute tolerance in both directions', async () => {
		for (const offset of [-300, 300]) {
			const timestamp = String(Number(TIMESTAMP) + offset);
			const signature = `v1,${nodeSign(ID, timestamp, BODY)}`;
			expect(await verifySvixSignature(input({ timestamp, signature }))).toEqual({ ok: true });
		}
		for (const offset of [-301, 301]) {
			const timestamp = String(Number(TIMESTAMP) + offset);
			const signature = `v1,${nodeSign(ID, timestamp, BODY)}`;
			expect(await verifySvixSignature(input({ timestamp, signature }))).toEqual({
				ok: false,
				reason: 'stale'
			});
		}
	});

	it('reports missing or malformed headers and secrets', async () => {
		for (const overrides of [
			{ id: null },
			{ timestamp: null },
			{ signature: null },
			{ id: 'bad id with spaces' },
			{ timestamp: '12.5' }
		]) {
			expect(await verifySvixSignature(input(overrides))).toEqual({
				ok: false,
				reason: 'missing-headers'
			});
		}
		expect(await verifySvixSignature(input({ secret: 'whsec_***' }))).toEqual({
			ok: false,
			reason: 'bad-secret'
		});
	});
});

describe('suppressionIntent', () => {
	const bounced = (bounce: unknown, to: unknown = ['a@example.com']) => ({
		type: 'email.bounced',
		data: { to, bounce }
	});

	it('suppresses permanent bounces and bounces without a classification', () => {
		expect(suppressionIntent(bounced({ type: 'Permanent', subType: 'General' }))).toEqual({
			reason: 'bounce',
			addresses: ['a@example.com']
		});
		expect(suppressionIntent(bounced(undefined))).toEqual({
			reason: 'bounce',
			addresses: ['a@example.com']
		});
	});

	it('ignores transient and undetermined bounces', () => {
		expect(suppressionIntent(bounced({ type: 'Transient' }))).toBeNull();
		expect(suppressionIntent(bounced({ type: 'Undetermined' }))).toBeNull();
	});

	it('suppresses complaints', () => {
		const complaint = { type: 'email.complained', data: { to: 'b@example.com' } };
		expect(suppressionIntent(complaint)).toEqual({
			reason: 'complaint',
			addresses: ['b@example.com']
		});
	});

	it('ignores other events and malformed payloads', () => {
		const delivered = { type: 'email.delivered', data: { to: ['a@example.com'] } };
		expect(suppressionIntent(delivered)).toBeNull();
		expect(suppressionIntent({ type: 'email.bounced' })).toBeNull();
		expect(suppressionIntent(null)).toBeNull();
		expect(suppressionIntent('email.bounced')).toBeNull();
	});

	it('keeps only plausible addresses, capped at 50', () => {
		const many = Array.from({ length: 60 }, (_, i) => `u${i}@example.com`);
		const intent = suppressionIntent(bounced({ type: 'Permanent' }, [42, 'no-at-sign', ...many]));
		expect(intent?.addresses).toHaveLength(50);
		expect(intent?.addresses[0]).toBe('u0@example.com');
	});
});
