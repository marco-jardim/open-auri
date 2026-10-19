import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { getServerEnv, ServerEnvError } from '#lib/server/env.ts';

const ENV_KEYS = [
	'DB',
	'CONFIG',
	'MEDIA',
	'ACCESS_LOG_QUEUE',
	'RL_AUTH',
	'RL_API',
	'RL_WRITE',
	'METRICS',
	'PUBLIC_ORIGIN',
	'PUBLIC_ANDROID_APP_ID',
	'PUBLIC_ANDROID_CERT_SHA256',
	'GITHUB_URL',
	'RESEND_FROM',
	'ACCESS_LOG_ENABLED',
	'SIGNUP_ENABLED',
	'ADMIN_2FA_REQUIRED',
	'BETTER_AUTH_SECRET',
	'RESEND_API_KEY',
	'TURNSTILE_SECRET',
	'IPHASH_PEPPER',
	'ACCESS_LOG_KEY',
	'RESEND_WEBHOOK_SECRET'
] as const;

/** Plain copy of the runtime env with some entries replaced (or removed with `undefined`). */
function envWith(overrides: Record<string, unknown>): Record<string, unknown> {
	const copy: Record<string, unknown> = {};
	for (const key of ENV_KEYS) copy[key] = Reflect.get(env, key);
	return { ...copy, ...overrides };
}

describe('integration bindings (workerd)', () => {
	it('exposes every binding declared in wrangler.jsonc', () => {
		expect(typeof env.DB.prepare).toBe('function');
		expect(typeof env.CONFIG.get).toBe('function');
		expect(typeof env.MEDIA.put).toBe('function');
		expect(typeof env.ACCESS_LOG_QUEUE.send).toBe('function');
		for (const limiter of [env.RL_AUTH, env.RL_API, env.RL_WRITE]) {
			expect(typeof limiter.limit).toBe('function');
		}
	});

	it('round-trips through the local D1, KV and R2 emulation', async () => {
		const row = await env.DB.prepare('SELECT ? AS value').bind(41).first<{ value: number }>();
		expect(row?.value).toBe(41);

		await env.CONFIG.put('t3.1:probe', 'kv-ok');
		expect(await env.CONFIG.get('t3.1:probe')).toBe('kv-ok');
		await env.CONFIG.delete('t3.1:probe');

		await env.MEDIA.put('t3.1/probe.txt', 'r2-ok');
		const object = await env.MEDIA.get('t3.1/probe.txt');
		expect(await object?.text()).toBe('r2-ok');
		await env.MEDIA.delete('t3.1/probe.txt');
	});

	it('answers rate limit checks locally', async () => {
		const outcome = await env.RL_API.limit({ key: 't3.1:probe' });
		expect(outcome.success).toBe(true);
	});
});

describe('getServerEnv', () => {
	it('validates the rendered configuration and maps it to a typed view', () => {
		const serverEnv = getServerEnv({ env });
		expect(serverEnv.db).toBe(env.DB);
		expect(serverEnv.config).toBe(env.CONFIG);
		expect(serverEnv.media).toBe(env.MEDIA);
		expect(serverEnv.accessLogQueue).toBe(env.ACCESS_LOG_QUEUE);
		expect(serverEnv.rateLimit.auth).toBe(env.RL_AUTH);
		expect(serverEnv.publicOrigin).toBe(new URL(serverEnv.publicOrigin).origin);
		for (const value of Object.values(serverEnv.flags)) expect(typeof value).toBe('boolean');
		expect(getServerEnv({ env })).toBe(serverEnv);
	});

	it('converts flags to booleans and treats the webhook secret as optional', () => {
		const serverEnv = getServerEnv({
			env: envWith({
				SIGNUP_ENABLED: 'true',
				ACCESS_LOG_ENABLED: 'false',
				ADMIN_2FA_REQUIRED: 'true',
				RESEND_WEBHOOK_SECRET: undefined
			})
		});
		expect(serverEnv.flags).toEqual({
			signupEnabled: true,
			accessLogEnabled: false,
			admin2faRequired: true
		});
		expect(serverEnv.secrets.resendWebhookSecret).toBeNull();
	});

	it('defaults public Android configuration to unpublished and parses configured certificates', () => {
		const defaults = getServerEnv({
			env: envWith({ PUBLIC_ANDROID_APP_ID: undefined, PUBLIC_ANDROID_CERT_SHA256: undefined })
		});
		expect(defaults.androidAppId).toBe('com.openauri.app');
		expect(defaults.androidCertSha256).toEqual([]);
		const fingerprint = Array<string>(32).fill('AB').join(':');
		const configured = getServerEnv({
			env: envWith({
				PUBLIC_ANDROID_APP_ID: 'com.example.app',
				PUBLIC_ANDROID_CERT_SHA256: `${fingerprint}, ${'ab'.repeat(32)}`
			})
		});
		expect(configured.androidAppId).toBe('com.example.app');
		expect(configured.androidCertSha256).toEqual([fingerprint]);
		expect(getServerEnv({ env: envWith({ PUBLIC_ANDROID_APP_ID: '' }) }).androidAppId).toBeNull();
	});

	it.each(['ab:cd', `${'ab'.repeat(32)},invalid`, null, 123])(
		'disables malformed fingerprints without invalidating the env or logging values: %j',
		(value) => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			try {
				const configuredEnv = envWith({ PUBLIC_ANDROID_CERT_SHA256: value });
				const serverEnv = getServerEnv({ env: configuredEnv });
				expect(serverEnv.db).toBe(env.DB);
				expect(serverEnv.androidCertSha256).toEqual([]);
				expect(getServerEnv({ env: configuredEnv })).toBe(serverEnv);
				expect(warn).toHaveBeenCalledExactlyOnceWith(
					'PUBLIC_ANDROID_CERT_SHA256: invalid fingerprints; App Links disabled'
				);
			} finally {
				warn.mockRestore();
			}
		}
	);

	it('rejects an invalid package with a name-only schema issue', () => {
		const key = 'PUBLIC_ANDROID_APP_ID';
		const value = 'not-a-package';
		let caught: unknown;
		try {
			getServerEnv({ env: envWith({ [key]: value }) });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ServerEnvError);
		expect(String(caught)).toContain(key);
		expect(String(caught)).not.toContain(value);
	});

	it('lists every problem by name without leaking values', () => {
		const leaks = ['https://leak.invalid/path', 'maybe-leak', 'short-leak'];
		let caught: unknown;
		try {
			getServerEnv({
				env: envWith({
					DB: undefined,
					RL_WRITE: { limit: 'not a function' },
					PUBLIC_ORIGIN: leaks[0],
					SIGNUP_ENABLED: leaks[1],
					IPHASH_PEPPER: leaks[2]
				})
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ServerEnvError);
		const issues = caught instanceof ServerEnvError ? caught.issues : [];
		const message = caught instanceof Error ? caught.message : '';
		expect(issues.map((issue) => issue.split(':')[0])).toEqual(
			expect.arrayContaining(['DB', 'RL_WRITE', 'PUBLIC_ORIGIN', 'SIGNUP_ENABLED', 'IPHASH_PEPPER'])
		);
		for (const leak of leaks) expect(message).not.toContain(leak);
	});

	it('treats the METRICS binding as optional (null when absent) and checks its shape', () => {
		expect(getServerEnv({ env: envWith({ METRICS: undefined }) }).metrics).toBeNull();
		const fake = { writeDataPoint: () => undefined };
		expect(getServerEnv({ env: envWith({ METRICS: fake }) }).metrics).toBe(fake);
		expect(() => getServerEnv({ env: envWith({ METRICS: { writeDataPoint: 1 } }) })).toThrow(
			/METRICS: binding missing or of the wrong type/
		);
	});

	it('fails clearly outside the Workers runtime', () => {
		expect(() => getServerEnv(undefined)).toThrow(ServerEnvError);
		expect(() => getServerEnv({})).toThrow(/platform\.env: missing/);
	});
});
