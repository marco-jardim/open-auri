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
	READ_ONLY_HTML_CSP,
	READ_ONLY_KEY,
	setReadOnly
} from '#lib/server/admin/read-only.ts';
import { applySecurityHeaders } from '#lib/server/security/headers.ts';

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
			['POST', '/api/webhooks/resend/'],
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
			['POST', '/api/webhooks/resend'],
			['POST', '/admin'],
			['POST', '/admin/usuarios']
		] as const) {
			expect(await enforceWritable(request(method, path), target), `${method} ${path}`).toBeNull();
		}

		await setReadOnly(target, false, `admin-${crypto.randomUUID()}`);
		expect(await enforceWritable(request('POST', '/api/curvas'), target)).toBeNull();
	});

	it('blocks the state-changing Better Auth GET links while on, and only those', async () => {
		const links = [
			'/api/auth/verify-email?token=abc&callbackURL=%2Fconta',
			'/api/auth/delete-user/callback?token=abc',
			'/api/auth/verify-email/',
			'/api/auth//verify-email',
			'/API/Auth/Verify-Email',
			'/api/auth/verify%2Demail',
			'/api/auth/x/%2e%2e/delete-user/callback'
		];
		// Off: the links work (and no KV-free shortcut hides a bug: the switch is really read).
		for (const path of links) {
			expect(await enforceWritable(request('GET', path), target), path).toBeNull();
		}

		await setReadOnly(target, true, `admin-${crypto.randomUUID()}`);
		for (const method of ['GET', 'HEAD'] as const) {
			for (const path of links) {
				const response = await enforceWritable(request(method, path), target);
				expect(response?.status, `${method} ${path}`).toBe(503);
				expect(response?.headers.get('x-error-code')).toBe(READ_ONLY_CODE);
				expect(response?.headers.get('retry-after')).toBe('300');
				expect(response?.headers.get('cache-control')).toBe('no-store');
			}
		}
		const json = await enforceWritable(request('GET', links[0] ?? ''), target);
		expect(((await json?.json()) as { code?: string }).code).toBe(READ_ONLY_CODE);

		// Other GETs, OPTIONS on the links and sibling paths stay readable.
		for (const [method, path] of [
			['OPTIONS', '/api/auth/verify-email'],
			['GET', '/api/auth/get-session'],
			['GET', '/api/auth/verify-email-x'],
			['GET', '/api/auth/delete-user'],
			['GET', '/redefinir-senha?token=abc']
		] as const) {
			expect(await enforceWritable(request(method, path), target), `${method} ${path}`).toBeNull();
		}
	});

	it('answers browser navigations with a small HTML page that keeps the code', async () => {
		await setReadOnly(target, true, `admin-${crypto.randomUUID()}`);
		const navigation = new Request(`${ORIGIN}/api/auth/verify-email?token=abc`, {
			headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
		});
		const response = await enforceWritable(navigation, target);
		expect(response?.status).toBe(503);
		expect(response?.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(response?.headers.get('x-error-code')).toBe(READ_ONLY_CODE);
		const html = (await response?.text()) ?? '';
		expect(html).toContain(`data-code="${READ_ONLY_CODE}"`);
		expect(html).toContain('somente leitura');
		expect(html).not.toContain('abc');
		expect(html).not.toContain('<script');
		// The page loads nothing; the security-header step keeps this policy (it has frame-ancestors).
		expect(response?.headers.get('content-security-policy')).toBe(READ_ONLY_HTML_CSP);
		const secured = applySecurityHeaders(response as Response, { origin: ORIGIN });
		expect(secured.headers.get('content-security-policy')).toBe(READ_ONLY_HTML_CSP);
		expect(secured.headers.get('x-frame-options')).toBe('DENY');
		// The JSON answer gets the generic non-HTML policy from the security-header step.
		const json = await enforceWritable(request('GET', '/api/auth/verify-email?token=abc'), target);
		expect(json?.headers.get('content-security-policy')).toBeNull();

		const form = new Request(`${ORIGIN}/conta`, {
			method: 'POST',
			headers: { 'sec-fetch-mode': 'navigate' },
			body: 'a=1'
		});
		const formResponse = await enforceWritable(form, target);
		expect(formResponse?.headers.get('content-type')).toBe('text/html; charset=utf-8');
	});

	it('keeps the LGPD export available while on', async () => {
		await setReadOnly(target, true, `admin-${crypto.randomUUID()}`);
		expect(await enforceWritable(request('POST', '/conta/exportar'), target)).toBeNull();
		expect((await enforceWritable(request('POST', '/conta/politica'), target))?.status).toBe(503);
		expect((await enforceWritable(request('POST', '/conta/exportar/x'), target))?.status).toBe(503);
	});

	it('matches the allowlist exactly', () => {
		expect(isWriteAllowlisted('/admin')).toBe(true);
		expect(isWriteAllowlisted('/conta/exportar')).toBe(true);
		expect(isWriteAllowlisted('/conta/exportar/')).toBe(false);
		expect(isWriteAllowlisted('/api/webhooks/resend')).toBe(true);
		expect(isWriteAllowlisted('/api/webhooks/resend/x')).toBe(false);
		expect(isWriteAllowlisted('/admin/auditoria')).toBe(true);
		expect(isWriteAllowlisted('/admin.json')).toBe(false);
		expect(isWriteAllowlisted('/api/auth/sign-in/email/')).toBe(false);
		expect(isWriteAllowlisted('/API/AUTH/SIGN-OUT')).toBe(false);
	});
});
