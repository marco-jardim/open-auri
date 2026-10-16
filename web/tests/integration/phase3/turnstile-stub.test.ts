// The local Turnstile stub of the e2e suite (security/turnstile.ts localTestTurnstile) is reachable
// only with EMAIL_TRANSPORT=capture on a localhost origin. Everywhere else the guard keeps calling
// Siteverify, so the Cloudflare dummy token gets no special treatment in production.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getServerEnv, type ServerEnv } from '#lib/server/env.ts';
import { createAuthGuard } from '#lib/server/security/auth-guard.ts';
import {
	DUMMY_TURNSTILE_TOKEN,
	localTestTurnstile,
	SITEVERIFY_URL
} from '#lib/server/security/turnstile.ts';
import { rawEnv } from './helpers.ts';

const network = setupNetwork();
let siteverifyCalls = 0;

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});
beforeEach(() => {
	siteverifyCalls = 0;
	network.resetHandlers();
	network.use(
		http.post(SITEVERIFY_URL, () => {
			siteverifyCalls += 1;
			// What Siteverify answers a dummy token checked with a real secret.
			return HttpResponse.json({ success: false, 'error-codes': ['invalid-input-response'] });
		})
	);
});

const LOCAL = 'http://localhost:4173';

function randomIp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return `10.${bytes[0]}.${bytes[1]}.${bytes[2]}`;
}

function guardFor(serverEnv: ServerEnv) {
	const guard = createAuthGuard({ env: serverEnv, log: () => undefined });
	return (token: string | null) =>
		guard({
			path: '/sign-in/email',
			ip: randomIp(),
			email: `stub-${crypto.randomUUID()}@example.test`,
			turnstileToken: token
		});
}

describe('localTestTurnstile', () => {
	it('exists only for capture on localhost / 127.0.0.1', () => {
		for (const [emailTransport, publicOrigin] of [
			['resend', LOCAL],
			[undefined, LOCAL],
			['capture', 'https://open-auri.example.org'],
			['capture', 'https://localhost.evil.example'],
			['capture', 'https://127.0.0.1.nip.io'],
			['capture', 'not a url']
		] as const) {
			expect(localTestTurnstile({ emailTransport, publicOrigin }), publicOrigin).toBeNull();
		}
		expect(localTestTurnstile({ emailTransport: 'capture', publicOrigin: LOCAL })).not.toBeNull();
		expect(
			localTestTurnstile({ emailTransport: 'capture', publicOrigin: 'http://127.0.0.1:8787' })
		).not.toBeNull();
	});

	it('accepts only the dummy token and still requires one', async () => {
		const verify = localTestTurnstile({ emailTransport: 'capture', publicOrigin: LOCAL });
		if (!verify) throw new Error('stub missing');
		const base = { action: 'sign-in', hostname: 'localhost', secret: 'x' };
		expect(await verify({ ...base, token: DUMMY_TURNSTILE_TOKEN })).toEqual({ ok: true });
		expect(await verify({ ...base, token: '' })).toEqual({ ok: false, reason: 'missing' });
		expect(await verify({ ...base, token: null })).toEqual({ ok: false, reason: 'missing' });
		expect(await verify({ ...base, token: 'ok:sign-in:localhost' })).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(siteverifyCalls).toBe(0);
	});
});

describe('auth guard', () => {
	it('production config: the dummy token goes to Siteverify and fails', async () => {
		const check = guardFor(getServerEnv({ env }));
		expect(await check(DUMMY_TURNSTILE_TOKEN)).toMatchObject({
			ok: false,
			status: 403,
			code: 'TURNSTILE_FAILED'
		});
		expect(siteverifyCalls).toBe(1);
	});

	it('a forged env (capture flag on a public origin) still goes to Siteverify', async () => {
		const forged = { ...getServerEnv({ env }), emailTransport: 'capture' as const };
		const check = guardFor(forged);
		expect((await check(DUMMY_TURNSTILE_TOKEN)).ok).toBe(false);
		expect(siteverifyCalls).toBe(1);
	});

	it('local capture config: dummy token passes offline; none or another token fails', async () => {
		const local = getServerEnv({
			env: rawEnv({ EMAIL_TRANSPORT: 'capture', PUBLIC_ORIGIN: LOCAL })
		});
		const check = guardFor(local);
		expect(await check(DUMMY_TURNSTILE_TOKEN)).toEqual({ ok: true });
		expect(await check(null)).toMatchObject({ ok: false, status: 400, code: 'TURNSTILE_REQUIRED' });
		expect(await check('anything-else')).toMatchObject({
			ok: false,
			status: 403,
			code: 'TURNSTILE_FAILED'
		});
		expect(siteverifyCalls).toBe(0);
	});
});
