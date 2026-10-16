import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	buildAccessRecord,
	captureAccess,
	isAccessLogEnabled,
	routeGroup,
	S6_DELAY_SECONDS,
	sealAccessRecord,
	type AccessEventLike,
	type AccessLogFailure
} from '#lib/server/security/access-log.ts';
// The jobs Worker's reader of the same format: proves producer and consumer agree.
import { createAccessLogCrypto } from '../../../../workers/jobs/src/jobs/access-log-crypto.js';

const IP = '203.0.113.9';

function event(routeId: string | null, ip: string | null = IP): AccessEventLike {
	return {
		request: new Request('https://auri.example/u/alguem?token=secret', {
			headers: ip ? { 'cf-connecting-ip': ip } : {}
		}),
		route: { id: routeId }
	};
}

interface Sent {
	body: unknown;
	options: unknown;
}

function recordingQueue(options: { fail?: boolean; gate?: Promise<void> } = {}) {
	const sent: Sent[] = [];
	return {
		sent,
		queue: {
			send: async (body: unknown, sendOptions?: unknown) => {
				await options.gate;
				if (options.fail) throw new TypeError('queue down');
				sent.push({ body, options: sendOptions });
			}
		}
	};
}

describe('access-log capture', () => {
	it('enqueues an encrypted record through waitUntil without blocking the response', async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { queue, sent } = recordingQueue({ gate });
		const ctx = createExecutionContext();

		const returned = captureAccess(event('/u/[apelido]'), {
			queue,
			enabled: true,
			waitUntil: (promise) => ctx.waitUntil(promise),
			key: env.ACCESS_LOG_KEY,
			status: 200,
			userId: 'user_1',
			port: 51234,
			now: () => Date.parse('2026-10-16T13:04:05.123Z')
		});
		// captureAccess returned synchronously; nothing was sent yet.
		expect(returned).toBeInstanceOf(Promise);
		expect(sent).toHaveLength(0);
		release();
		await waitOnExecutionContext(ctx);

		expect(sent).toHaveLength(1);
		const message = sent[0];
		expect(JSON.stringify(message)).not.toContain(IP);
		expect(JSON.stringify(message)).not.toContain('user_1');
		expect(message?.options).toEqual({ contentType: 'json' });

		const record = await createAccessLogCrypto(env.ACCESS_LOG_KEY).openMessage(message?.body);
		expect(record).toEqual({
			v: 1,
			ts: Date.parse('2026-10-16T13:04:05.123Z'),
			ip: IP,
			port: 51234,
			user_id: 'user_1',
			route_group: '/u/[apelido]',
			status: 200
		});
	});

	it('reduces S6 routes to the s6 group, drops the user id and delays the message', async () => {
		const { queue, sent } = recordingQueue();
		await captureAccess(event('/api/s6/[batch]'), {
			queue,
			enabled: true,
			waitUntil: () => undefined,
			key: env.ACCESS_LOG_KEY,
			status: 201,
			userId: 'user_1'
		});
		const options = sent[0]?.options as { delaySeconds?: number };
		expect(options.delaySeconds).toBeGreaterThanOrEqual(S6_DELAY_SECONDS.min);
		expect(options.delaySeconds).toBeLessThanOrEqual(S6_DELAY_SECONDS.max);
		const record = await createAccessLogCrypto(env.ACCESS_LOG_KEY).openMessage(sent[0]?.body);
		expect(record).toMatchObject({ route_group: 's6', user_id: null });
	});

	it('logs failures without PII and never rejects', async () => {
		const failures: AccessLogFailure[] = [];
		const { queue } = recordingQueue({ fail: true });
		await expect(
			captureAccess(event('/'), {
				queue,
				enabled: true,
				waitUntil: () => undefined,
				key: env.ACCESS_LOG_KEY,
				status: 200,
				userId: 'user_1',
				log: (failure) => failures.push(failure)
			})
		).resolves.toBeUndefined();
		expect(failures).toEqual([{ event: 'access_log.enqueue_failed', reason: 'TypeError' }]);
		expect(JSON.stringify(failures)).not.toMatch(/203\.0\.113|user_1|apelido/);
	});

	it('does nothing when disabled and skips requests without a client IP', async () => {
		const { queue, sent } = recordingQueue();
		const failures: AccessLogFailure[] = [];
		const base = {
			queue,
			waitUntil: () => undefined,
			key: env.ACCESS_LOG_KEY,
			status: 200,
			log: (failure: AccessLogFailure) => failures.push(failure)
		};
		await captureAccess(event('/'), { ...base, enabled: false });
		await captureAccess(event('/', null), { ...base, enabled: true });
		expect(sent).toHaveLength(0);
		expect(failures).toEqual([{ event: 'access_log.skipped', reason: 'no-client-ip' }]);
	});

	it('derives route groups from route ids only (no concrete path or query)', () => {
		expect(routeGroup('/u/[apelido]')).toBe('/u/[apelido]');
		expect(routeGroup(null)).toBe('unmatched');
		expect(routeGroup('/s6')).toBe('s6');
		expect(routeGroup('/api/s6/[id]')).toBe('s6');
		expect(routeGroup('/s60')).toBe('/s60');
		const record = buildAccessRecord(event('/u/[apelido]'), { status: 200, ts: 1, port: 70000 });
		expect(JSON.stringify(record)).not.toContain('token=secret');
		expect(record?.port).toBeNull();
	});

	it('parses ACCESS_LOG_ENABLED as on by default', () => {
		expect(isAccessLogEnabled(undefined)).toBe(true);
		expect(isAccessLogEnabled('true')).toBe(true);
		expect(isAccessLogEnabled('false')).toBe(false);
	});

	it('seals with the first key of a keyring and records its key id', async () => {
		const keyring = `k2:${'b'.repeat(40)},k1:${'a'.repeat(40)}`;
		const sealed = await sealAccessRecord(
			{ v: 1, ts: 1, ip: IP, port: null, user_id: null, route_group: '/', status: 200 },
			keyring
		);
		expect(sealed.kid).toBe('k2');
		const reader = createAccessLogCrypto(keyring);
		expect(await reader.openMessage(sealed)).toMatchObject({ ip: IP });
		const oldOnly = createAccessLogCrypto(`k1:${'a'.repeat(40)}`);
		await expect(oldOnly.openMessage(sealed)).rejects.toMatchObject({ code: 'unknown-key' });
	});
});
