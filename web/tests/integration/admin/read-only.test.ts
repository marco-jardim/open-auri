// Emergency read-only switch (T3.8): KV CONFIG `mode:read-only`, ≤ 10 s isolate cache, write
// middleware with the allowlist, audited toggle.
import type { KVNamespace } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { listAudit } from '#lib/server/admin/audit.ts';
import {
	enforceWritable,
	forgetReadOnly,
	isReadOnly,
	isWriteAllowlisted,
	READ_ONLY_CACHE_MS,
	READ_ONLY_CODE,
	READ_ONLY_KEY,
	setReadOnly
} from '#lib/server/admin/read-only.ts';

const ORIGIN = 'https://open-auri.test';
const config: KVNamespace = env.CONFIG;
const target = { config, db: env.DB };

function request(method: string, path: string): Request {
	return new Request(`${ORIGIN}${path}`, {
		method,
		body: method === 'GET' || method === 'HEAD' ? null : '{}'
	});
}

beforeEach(async () => {
	await config.delete(READ_ONLY_KEY);
	forgetReadOnly(target);
});

describe('isReadOnly', () => {
	it('is on only for the value "1" and caches for at most 10 s', async () => {
		const t = Date.now();
		expect(await isReadOnly(target, { now: () => t })).toBe(false);

		await config.put(READ_ONLY_KEY, '1');
		// Still the cached "off" inside the window.
		expect(await isReadOnly(target, { now: () => t + READ_ONLY_CACHE_MS - 1 })).toBe(false);
		expect(await isReadOnly(target, { now: () => t + READ_ONLY_CACHE_MS })).toBe(true);

		await config.put(READ_ONLY_KEY, 'true');
		forgetReadOnly(target);
		expect(await isReadOnly(target, { now: () => t })).toBe(false);
	});

	it('keeps the last known value when KV fails, and logs no request data', async () => {
		let failing = false;
		const flaky: KVNamespace = Object.create(config, {
			get: {
				value: async () => {
					if (failing) throw new Error('kv unavailable for 203.0.113.9');
					return '1';
				}
			}
		});
		const lines: string[] = [];
		const deps = (now: number) => ({ now: () => now, log: (line: string) => lines.push(line) });
		const t = Date.now();
		expect(await isReadOnly({ config: flaky }, deps(t))).toBe(true);
		failing = true;
		expect(await isReadOnly({ config: flaky }, deps(t + READ_ONLY_CACHE_MS + 1))).toBe(true);
		expect(lines).toEqual([
			JSON.stringify({ event: 'admin.read_only_lookup_failed', reason: 'Error' })
		]);

		const dead: KVNamespace = Object.create(config, {
			get: {
				value: async () => {
					throw new Error('down');
				}
			}
		});
		expect(await isReadOnly({ config: dead }, deps(t))).toBe(false);
	});
});

describe('setReadOnly', () => {
	it('toggles the KV key, clears the cache and audits both directions', async () => {
		const actor = `admin-${crypto.randomUUID()}`;
		await setReadOnly(target, true, actor);
		expect(await config.get(READ_ONLY_KEY)).toBe('1');
		expect(await isReadOnly(target)).toBe(true);
		await setReadOnly(target, false, actor);
		expect(await config.get(READ_ONLY_KEY)).toBeNull();
		expect(await isReadOnly(target)).toBe(false);

		const trail = await listAudit(env.DB, { targetId: READ_ONLY_KEY });
		const mine = trail.rows.filter((row) => row.actorId === actor);
		expect(mine.map((row) => row.action)).toEqual(['mode.read_only.off', 'mode.read_only.on']);
		expect(mine[0]).toMatchObject({ actorKind: 'admin', targetKind: 'config' });
	});

	it('records the failure when KV rejects the write', async () => {
		const actor = `admin-${crypto.randomUUID()}`;
		const broken: KVNamespace = Object.create(config, {
			put: {
				value: async () => {
					throw new Error('kv write failed');
				}
			}
		});
		await expect(setReadOnly({ config: broken, db: env.DB }, true, actor)).rejects.toThrow(
			'kv write failed'
		);
		const trail = await listAudit(env.DB, { targetId: READ_ONLY_KEY });
		const mine = trail.rows.filter((row) => row.actorId === actor).map((row) => row.action);
		expect(mine.sort()).toEqual(['mode.read_only.on', 'mode.read_only.on.failed']);
		expect(await config.get(READ_ONLY_KEY)).toBeNull();
	});
});

describe('enforceWritable', () => {
	it('lets everything through while the switch is off', async () => {
		expect(await enforceWritable(request('POST', '/api/curvas'), target)).toBeNull();
		expect(await enforceWritable(request('DELETE', '/api/curvas/1'), target)).toBeNull();
	});

	it('blocks writes with 503 READ_ONLY and keeps reads and allowlisted paths working', async () => {
		await setReadOnly(target, true, `admin-${crypto.randomUUID()}`);

		for (const [method, path] of [
			['POST', '/api/curvas'],
			['PUT', '/api/curvas/1'],
			['PATCH', '/conta'],
			['DELETE', '/api/curvas/1'],
			['POST', '/api/auth/sign-up/email'],
			['POST', '/api/auth/change-password'],
			['POST', '/api/webhooks/resend'],
			['POST', '/administrator'],
			['POST', '/adminx/usuarios'],
			['POST', '/api/auth/sign-in/email/../../../conta']
		] as const) {
			const response = await enforceWritable(request(method, path), target);
			expect(response?.status, `${method} ${path}`).toBe(503);
			expect(response?.headers.get('retry-after')).toBe('300');
			expect(response?.headers.get('cache-control')).toBe('no-store');
			expect(((await response?.json()) as { code?: string }).code).toBe(READ_ONLY_CODE);
		}

		for (const [method, path] of [
			['GET', '/api/curvas'],
			['HEAD', '/'],
			['OPTIONS', '/api/curvas'],
			['POST', '/api/auth/sign-in/email'],
			['POST', '/api/auth/sign-in/username'],
			['POST', '/api/auth/two-factor/verify-totp'],
			['POST', '/api/auth/two-factor/verify-backup-code'],
			['POST', '/api/auth/sign-out'],
			['POST', '/admin'],
			['POST', '/admin/usuarios']
		] as const) {
			expect(await enforceWritable(request(method, path), target), `${method} ${path}`).toBeNull();
		}

		await setReadOnly(target, false, `admin-${crypto.randomUUID()}`);
		expect(await enforceWritable(request('POST', '/api/curvas'), target)).toBeNull();
	});

	it('matches the allowlist exactly', () => {
		expect(isWriteAllowlisted('/admin')).toBe(true);
		expect(isWriteAllowlisted('/admin/auditoria')).toBe(true);
		expect(isWriteAllowlisted('/admin.json')).toBe(false);
		expect(isWriteAllowlisted('/api/auth/sign-in/email/')).toBe(false);
		expect(isWriteAllowlisted('/API/AUTH/SIGN-OUT')).toBe(false);
	});
});
