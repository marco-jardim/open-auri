// Optional Cloudflare Access JWT in front of /admin (T3.8): RS256 against the team certs, aud/iss/
// exp checks, fail closed. Test keys are generated here; the certs endpoint is served by msw.
import { setupNetwork } from '@msw/cloudflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
	ACCESS_JWT_HEADER,
	checkAccess,
	clearAccessKeyCache,
	JWKS_TTL_MS,
	readAccessConfig,
	verifyAccessJwt,
	type AccessConfig
} from '#lib/server/admin/access.ts';
import { requireAdmin } from '#lib/server/admin/guard.ts';
import { account, adminRequest, harness, localsOf } from './helpers.ts';

const TEAM = 'open-auri-test.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const CERTS = `${ISSUER}/cdn-cgi/access/certs`;
const AUD = 'aud-0123456789abcdef';
const RAW_ENV = { ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM };
const CONFIG: AccessConfig = { aud: AUD, issuer: ISSUER, certsUrl: CERTS };

const network = setupNetwork();
let certsRequests = 0;

interface TestKey {
	kid: string;
	privateKey: CryptoKey;
	jwk: JsonWebKey & { kid: string };
}

async function makeKey(kid: string): Promise<TestKey> {
	const pair = (await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256'
		},
		true,
		['sign', 'verify']
	)) as CryptoKeyPair;
	const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
	return { kid, privateKey: pair.privateKey, jwk: { ...exported, kid, alg: 'RS256' } };
}

function b64url(bytes: Uint8Array): string {
	let text = '';
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(value: unknown): string {
	return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function sign(
	key: TestKey,
	payload: Record<string, unknown>,
	header: Record<string, unknown> = {}
): Promise<string> {
	const head = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header });
	const input = `${head}.${b64urlJson(payload)}`;
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		key.privateKey,
		new TextEncoder().encode(input)
	);
	return `${input}.${b64url(new Uint8Array(signature))}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return { aud: [AUD], iss: ISSUER, sub: 'access-subject', iat: now, exp: now + 300, ...overrides };
}

let key: TestKey;
let rogue: TestKey;

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
	key = await makeKey('kid-main');
	rogue = await makeKey('kid-main');
});
afterAll(async () => {
	await network.disable();
});

function serveCerts(): void {
	network.use(
		http.get(CERTS, () => {
			certsRequests += 1;
			return HttpResponse.json({ keys: [key.jwk], public_cert: { kid: key.kid, cert: 'x' } });
		})
	);
}

beforeEach(() => {
	network.resetHandlers();
	serveCerts();
	clearAccessKeyCache();
	certsRequests = 0;
});

describe('readAccessConfig', () => {
	it('is off without variables, invalid when half or badly configured', () => {
		expect(readAccessConfig({})).toBeNull();
		expect(readAccessConfig(undefined)).toBeNull();
		expect(readAccessConfig({ ACCESS_AUD: '  ', ACCESS_TEAM_DOMAIN: '' })).toBeNull();
		expect(readAccessConfig({ ACCESS_AUD: AUD })).toBe('invalid');
		expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM })).toBe('invalid');
		expect(readAccessConfig({ ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: 'evil.com/path?x' })).toBe(
			'invalid'
		);
		expect(readAccessConfig({ ACCESS_AUD: 1, ACCESS_TEAM_DOMAIN: TEAM })).toBe('invalid');
		expect(readAccessConfig(RAW_ENV)).toEqual(CONFIG);
		expect(readAccessConfig({ ...RAW_ENV, ACCESS_TEAM_DOMAIN: `https://${TEAM}/` })).toEqual(
			CONFIG
		);
	});
});

describe('verifyAccessJwt', () => {
	it('accepts a valid token and caches the keys', async () => {
		expect(await verifyAccessJwt(await sign(key, claims()), CONFIG)).toEqual({
			ok: true,
			configured: true,
			subject: 'access-subject'
		});
		expect(await verifyAccessJwt(await sign(key, claims({ aud: AUD })), CONFIG)).toMatchObject({
			ok: true
		});
		expect(certsRequests).toBe(1);
	});

	it('refetches the keys after the TTL', async () => {
		const start = Date.now();
		const token = await sign(key, claims());
		await verifyAccessJwt(token, CONFIG, { now: () => start });
		await verifyAccessJwt(token, CONFIG, { now: () => start + JWKS_TTL_MS - 1 });
		expect(certsRequests).toBe(1);
		await verifyAccessJwt(token, CONFIG, { now: () => start + JWKS_TTL_MS + 1 });
		expect(certsRequests).toBe(2);
	});

	it('rejects missing, malformed and tampered tokens', async () => {
		const valid = await sign(key, claims());
		const [head, , sig] = valid.split('.');
		const cases: [string | null, string][] = [
			[null, 'missing'],
			['', 'missing'],
			['a.b', 'malformed'],
			['a.b.c.d', 'malformed'],
			[`${head}.${b64urlJson(claims({ sub: 'other' }))}.${sig}`, 'signature'],
			[await sign(rogue, claims()), 'signature'],
			[await sign(key, claims(), { alg: 'HS256' }), 'algorithm'],
			[await sign(key, claims(), { alg: 'none' }), 'algorithm'],
			[await sign(key, claims(), { kid: 'kid-unknown' }), 'unknown_key'],
			[await sign(key, claims({ aud: ['someone-else'] })), 'audience'],
			[await sign(key, claims({ iss: 'https://evil.cloudflareaccess.com' })), 'issuer'],
			[await sign(key, claims({ exp: Math.floor(Date.now() / 1000) - 3600 })), 'expired'],
			[await sign(key, claims({ exp: undefined })), 'expired'],
			[await sign(key, claims({ nbf: Math.floor(Date.now() / 1000) + 3600 })), 'not_yet_valid']
		];
		for (const [token, reason] of cases) {
			expect(await verifyAccessJwt(token, CONFIG), String(reason)).toEqual({ ok: false, reason });
		}
	});

	it('fails closed when the certs endpoint is down or serves no usable key', async () => {
		network.resetHandlers();
		network.use(http.get(CERTS, () => new HttpResponse('nope', { status: 500 })));
		const token = await sign(key, claims());
		expect(await verifyAccessJwt(token, CONFIG)).toEqual({ ok: false, reason: 'jwks_unavailable' });

		network.resetHandlers();
		network.use(http.get(CERTS, () => HttpResponse.json({ keys: [{ kty: 'EC', kid: key.kid }] })));
		expect(await verifyAccessJwt(token, CONFIG)).toEqual({ ok: false, reason: 'jwks_unavailable' });

		network.resetHandlers();
		network.use(
			http.get(CERTS, () => new HttpResponse(null, { status: 302, headers: { location: '/x' } }))
		);
		expect(await verifyAccessJwt(token, CONFIG)).toEqual({ ok: false, reason: 'jwks_unavailable' });
	});
});

describe('checkAccess and the admin guard', () => {
	it('passes through when Access is not configured', async () => {
		expect(await checkAccess(new Request('https://x.test/admin'), {})).toEqual({
			ok: true,
			configured: false
		});
		expect(certsRequests).toBe(0);
	});

	it('denies everything when only one variable is set', async () => {
		const token = await sign(key, claims());
		const request = new Request('https://x.test/admin', {
			headers: { [ACCESS_JWT_HEADER]: token }
		});
		expect(await checkAccess(request, { ACCESS_AUD: AUD })).toEqual({
			ok: false,
			reason: 'misconfigured'
		});
	});

	it('requires the header on top of the admin session (404 otherwise)', async () => {
		const h = harness(network, { admin2faRequired: false });
		serveCerts();
		const admin = await account(h, 'access', true);
		const locals = await localsOf(admin.client);
		const log: string[] = [];
		const options = { rawEnv: RAW_ENV, log: (line: string) => log.push(line) };

		const missing = await requireAdmin(locals, h.env, { ...options, request: adminRequest(h) });
		expect(missing).toEqual({ ok: false, status: 404, reason: 'access_missing' });

		const invalid = await requireAdmin(locals, h.env, {
			...options,
			request: adminRequest(h, '/admin', { [ACCESS_JWT_HEADER]: await sign(rogue, claims()) })
		});
		expect(invalid).toEqual({ ok: false, status: 404, reason: 'access_signature' });

		const valid = await requireAdmin(locals, h.env, {
			...options,
			request: adminRequest(h, '/admin', { [ACCESS_JWT_HEADER]: await sign(key, claims()) })
		});
		expect(valid).toMatchObject({ ok: true, accessConfigured: true });

		// Denial logs carry reason codes only.
		expect(log).toEqual([
			JSON.stringify({ event: 'admin.access_denied', reason: 'missing' }),
			JSON.stringify({ event: 'admin.access_denied', reason: 'signature' })
		]);

		// A valid Access token never makes a non-admin an admin.
		const user = await account(h, 'accessuser');
		const notAdmin = await requireAdmin(await localsOf(user.client), h.env, {
			...options,
			request: adminRequest(h, '/admin', { [ACCESS_JWT_HEADER]: await sign(key, claims()) })
		});
		expect(notAdmin).toEqual({ ok: false, status: 404, reason: 'not_admin' });
	});
});
