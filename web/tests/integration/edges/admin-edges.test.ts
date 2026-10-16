// Refusal and error branches of the /admin server modules: the re-authentication action, the
// moderation error mapping, the read-only form validation, the guard without an auth instance and
// the Cloudflare Access JWT checks (malformed tokens, key-set failures, claim edge cases).
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	banAction,
	readOnlyAction,
	reauthAction,
	unbanAction
} from '#lib/server/admin/actions.ts';
import {
	checkAccess,
	clearAccessKeyCache,
	readAccessConfig,
	verifyAccessJwt,
	type AccessConfig
} from '#lib/server/admin/access.ts';
import {
	AUDIT_ACTIONS,
	audited,
	AuditEntryError,
	auditStatement,
	listAudit
} from '#lib/server/admin/audit.ts';
import { requireAdminPage } from '#lib/server/admin/kit.ts';
import {
	account,
	enableTotp,
	harness as adminHarness,
	localsOf,
	totpCode
} from '../admin/helpers.ts';
import { createVerifiedUser, uniqueEmail } from '../auth/harness.ts';
import { outcome, platform, routeEvent, statusOf, type TestLocals } from '../phase3/helpers.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

vi.setConfig({ testTimeout: 60_000 });

type Action = (event: never) => unknown;

describe('admin actions', () => {
	async function admin(withTotp: boolean) {
		const h = adminHarness(network);
		const acct = await account(h, 'adm-edges', true);
		const secret = withTotp ? await enableTotp(h, acct.client) : null;
		const current = await localsOf(acct.client);
		const locals: TestLocals = { auth: h.auth, ...current };
		return { h, acct, secret, locals };
	}

	function run(
		action: Action,
		locals: TestLocals,
		client: Parameters<typeof routeEvent>[0]['client'],
		form: Record<string, string>,
		overrides: Record<string, unknown> = {}
	) {
		return outcome(() =>
			action(
				routeEvent({ path: '/admin', locals, platform: platform(overrides), client, form }) as never
			)
		);
	}

	it('reauth: a wrong code fails with INVALID_CODE, the current TOTP code renews the session', async () => {
		const { h, acct, secret, locals } = await admin(true);
		const wrong = await run(reauthAction as Action, locals, acct.client, { code: '000000' });
		expect(wrong).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { reauth: true, reauthError: 'INVALID_CODE' }
		});
		const right = await run(reauthAction as Action, locals, acct.client, {
			code: await totpCode(h, secret ?? '')
		});
		expect(right).toMatchObject({ kind: 'data', data: { reauthed: true } });
	});

	it('reauth without a second factor (ADMIN_2FA_REQUIRED=false) answers NO_SECOND_FACTOR', async () => {
		const { acct, locals } = await admin(false);
		const result = await run(
			reauthAction as Action,
			locals,
			acct.client,
			{ code: '123456' },
			{ ADMIN_2FA_REQUIRED: 'false' }
		);
		expect(result).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { reauthError: 'NO_SECOND_FACTOR' }
		});
	});

	it('moderation errors map to 400 / 404 / 409 and change nothing', async () => {
		const { h, acct, locals } = await admin(true);
		const target = await createVerifiedUser(h, uniqueEmail('mod-target'));
		const otherAdmin = await account(h, 'adm-other', true);
		const cases: [Action, Record<string, string>, number, string][] = [
			[banAction as Action, { userId: acct.id, reason: 'self ban', duration: '1' }, 409, 'SELF'],
			[banAction as Action, { userId: 'no-such-user-42', reason: 'missing', duration: '1' }, 404, 'NOT_FOUND'],
			[banAction as Action, { userId: otherAdmin.id, reason: 'admin', duration: '7' }, 409, 'TARGET_IS_ADMIN'],
			[banAction as Action, { userId: target, reason: 'x', duration: '1' }, 400, 'INVALID_INPUT'],
			[banAction as Action, { userId: target, reason: 'valid reason', duration: '2' }, 400, 'INVALID_INPUT'],
			[banAction as Action, { userId: 'bad id!', reason: 'valid reason', duration: '1' }, 400, 'INVALID_INPUT'],
			[unbanAction as Action, { userId: target, reason: 'not banned' }, 409, 'NOT_BANNED'],
			[unbanAction as Action, { userId: 'no-such-user-43', reason: 'missing' }, 404, 'NOT_FOUND'],
			[unbanAction as Action, { userId: target, reason: '\u0001\u0002\u0003' }, 400, 'INVALID_INPUT']
		];
		for (const [action, form, status, code] of cases) {
			const result = await run(action, locals, acct.client, form);
			expect(result, code).toMatchObject({ kind: 'fail', status, data: { error: code } });
		}
		const row = await env.DB.prepare('SELECT banned FROM "user" WHERE id = ?')
			.bind(target)
			.first<{ banned: number }>();
		expect(row?.banned).toBe(0);
	});

	it('read-only: only on/off are accepted', async () => {
		const { acct, locals } = await admin(true);
		for (const mode of ['', 'maybe', 'ON']) {
			const result = await run(readOnlyAction as Action, locals, acct.client, { mode });
			expect(result, mode).toMatchObject({ kind: 'fail', status: 400, data: { error: 'invalid' } });
		}
	});

	it('the guard answers 404 when there is no auth instance (prerender / no platform)', async () => {
		const { acct, locals } = await admin(true);
		const result = await outcome(() =>
			requireAdminPage(
				routeEvent({
					path: '/admin',
					locals: { ...locals, auth: null as never },
					platform: platform(),
					client: acct.client
				}) as never
			)
		);
		expect(statusOf(result)).toBe(404);
	});
});

// --- Audit trail ------------------------------------------------------------------------------------

describe('audit trail edges', () => {
	it('refuses an unknown actor kind', () => {
		expect(() =>
			auditStatement(env.DB, {
				actorId: 'a',
				actorKind: 'robot' as never,
				action: AUDIT_ACTIONS.reauth
			})
		).toThrow(AuditEntryError);
	});

	it('a failed mutation appends <action>.failed with the API code or the error name', async () => {
		const target = `audit-${crypto.randomUUID()}`;
		const entry = {
			actorId: 'admin-x',
			actorKind: 'admin' as const,
			action: AUDIT_ACTIONS.reauth,
			targetKind: 'user',
			targetId: target
		};
		const apiError = Object.assign(new Error('x'), { body: { code: 'USER_NOT_FOUND' } });
		await expect(audited(env.DB, entry, async () => Promise.reject(apiError))).rejects.toBe(apiError);
		const oddBody = Object.assign(new Error('y'), { name: 'OddError', body: { code: 'lower case' } });
		await expect(audited(env.DB, entry, async () => Promise.reject(oddBody))).rejects.toBe(oddBody);
		await expect(audited(env.DB, entry, async () => Promise.reject('plain string'))).rejects.toBe(
			'plain string'
		);
		const { rows } = await listAudit(env.DB, { page: 1, targetId: target });
		const failed = rows.filter((row) => row.action.endsWith('.failed')).map((row) => row.detail);
		expect(failed).toEqual(
			expect.arrayContaining([
				{ reason: 'USER_NOT_FOUND' },
				{ reason: 'OddError' },
				{ reason: 'unknown' }
			])
		);
	});

	it('rows with a detail that is not a JSON object read back as null detail', async () => {
		const target = `audit-raw-${crypto.randomUUID()}`;
		// Non-JSON text is refused by the CHECK constraint; valid JSON that is not an object reads as null.
		for (const detail of ['[1]', 'null', '"text"']) {
			await env.DB.prepare(
				'INSERT INTO audit_log (id, actor_id, actor_kind, action, target_kind, target_id, detail, created_at) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
			)
				.bind(crypto.randomUUID(), null, 'system', AUDIT_ACTIONS.reauth, 'user', target, detail, Date.now())
				.run();
		}
		const { rows } = await listAudit(env.DB, { page: 1, targetId: target });
		expect(rows).toHaveLength(3);
		for (const row of rows) expect(row.detail).toBeNull();
	});
});

// --- Cloudflare Access ------------------------------------------------------------------------------

function b64url(input: string | Uint8Array): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function configFor(team: string): AccessConfig {
	const config = readAccessConfig({ ACCESS_AUD: 'aud-1', ACCESS_TEAM_DOMAIN: team });
	if (!config || config === 'invalid') throw new Error('bad config');
	return config;
}

async function rsaKey() {
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
	const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
	return { pair, jwk };
}

async function sign(
	privateKey: CryptoKey,
	header: Record<string, unknown>,
	payload: Record<string, unknown>
): Promise<string> {
	const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		privateKey,
		new TextEncoder().encode(head)
	);
	return `${head}.${b64url(new Uint8Array(signature))}`;
}

describe('Cloudflare Access configuration', () => {
	it('reads both values, refuses half or bad configurations', () => {
		expect(readAccessConfig(undefined)).toBeNull();
		expect(readAccessConfig({ ACCESS_AUD: '  ', ACCESS_TEAM_DOMAIN: '' })).toBeNull();
		expect(readAccessConfig({ ACCESS_AUD: 'aud' })).toBe('invalid');
		expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' })).toBe('invalid');
		expect(readAccessConfig({ ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'not a host' })).toBe('invalid');
		expect(
			readAccessConfig({ ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'HTTPS://Team.CloudflareAccess.com//' })
		).toEqual({
			aud: 'aud',
			issuer: 'https://team.cloudflareaccess.com',
			certsUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs'
		});
	});

	it('checkAccess: misconfigured fails closed, missing header is refused', async () => {
		const request = new Request('https://example.org/admin');
		expect(await checkAccess(request, { ACCESS_AUD: 'aud' })).toEqual({
			ok: false,
			reason: 'misconfigured'
		});
		expect(
			await checkAccess(request, { ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'team.example.com' })
		).toEqual({ ok: false, reason: 'missing' });
	});
});

describe('Cloudflare Access JWT', () => {
	it('refuses malformed tokens before any key fetch', async () => {
		clearAccessKeyCache();
		const config = configFor('malformed.example.com');
		const fetch = vi.fn(async () => new Response('{}'));
		const deps = { fetch: fetch as unknown as typeof globalThis.fetch };
		const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'k' }));
		const payload = b64url(JSON.stringify({ aud: 'aud-1' }));
		const cases: [string | null, string][] = [
			[null, 'missing'],
			['', 'missing'],
			['a'.repeat(16 * 1024 + 1), 'malformed'],
			['only.two', 'malformed'],
			[`${b64url('[1]')}.${payload}.c2ln`, 'malformed'],
			[`${header}.${b64url('not json')}.c2ln`, 'malformed'],
			[`${header}.${payload}.`, 'malformed'],
			[`${header}.${payload}.!!`, 'malformed'],
			[`${b64url(JSON.stringify({ alg: 'HS256', kid: 'k' }))}.${payload}.c2ln`, 'algorithm'],
			[`${b64url(JSON.stringify({ alg: 'RS256' }))}.${payload}.c2ln`, 'malformed'],
			[`${b64url(JSON.stringify({ alg: 'RS256', kid: '' }))}.${payload}.c2ln`, 'malformed']
		];
		for (const [token, reason] of cases) {
			expect(await verifyAccessJwt(token, config, deps), reason).toEqual({ ok: false, reason });
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it('an unreachable, failing or empty key set is jwks_unavailable', async () => {
		const token = `${b64url(JSON.stringify({ alg: 'RS256', kid: 'k' }))}.${b64url('{}')}.c2ln`;
		const answers: (() => Promise<Response>)[] = [
			async () => new Response('nope', { status: 500 }),
			async () => Response.redirect('https://elsewhere.example/certs', 302),
			async () => {
				throw new TypeError('network down');
			},
			async () => new Response('not json'),
			async () => Response.json({ keys: 'nope' }),
			async () =>
				Response.json({
					keys: [
						null,
						{ kty: 'EC', kid: 'k', n: 'x', e: 'AQAB' },
						{ kty: 'RSA', kid: 'k', alg: 'RS512', n: 'x', e: 'AQAB' },
						{ kty: 'RSA', n: 'x', e: 'AQAB' },
						{ kty: 'RSA', kid: 'k', e: 'AQAB' },
						{ kty: 'RSA', kid: 'k', n: '!!', e: 'AQAB' }
					]
				})
		];
		for (const [index, answer] of answers.entries()) {
			clearAccessKeyCache();
			const config = configFor(`jwks-${index}.example.com`);
			const result = await verifyAccessJwt(token, config, {
				fetch: answer as unknown as typeof globalThis.fetch
			});
			expect(result, String(index)).toEqual({ ok: false, reason: 'jwks_unavailable' });
		}
	});

	it('checks key id, signature and every claim', async () => {
		clearAccessKeyCache();
		const config = configFor('claims.example.com');
		const { pair, jwk } = await rsaKey();
		let fetches = 0;
		let now = Date.UTC(2026, 9, 16, 12);
		const deps = {
			fetch: (async () => {
				fetches += 1;
				return Response.json({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256' }] });
			}) as unknown as typeof globalThis.fetch,
			now: () => now
		};
		const nowS = Math.floor(now / 1000);
		const good = { aud: ['other', 'aud-1'], iss: config.issuer, exp: nowS + 600, iat: nowS, sub: 'u' };
		const header = { alg: 'RS256', kid: 'k1' };

		expect(await verifyAccessJwt(await sign(pair.privateKey, header, good), config, deps)).toEqual({
			ok: true,
			configured: true,
			subject: 'u'
		});
		const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
			[{ ...header, kid: 'k2' }, good, 'unknown_key'],
			[header, { ...good, aud: 'aud-2' }, 'audience'],
			[header, { ...good, iss: 'https://evil.example.com' }, 'issuer'],
			[header, { ...good, exp: nowS - 3600 }, 'expired'],
			[header, { ...good, exp: 'soon' }, 'expired'],
			[header, { ...good, nbf: nowS + 3600 }, 'not_yet_valid'],
			[header, { ...good, iat: nowS + 3600 }, 'not_yet_valid']
		];
		for (const [h, p, reason] of cases) {
			expect(await verifyAccessJwt(await sign(pair.privateKey, h, p), config, deps), reason).toEqual({
				ok: false,
				reason
			});
		}
		const valid = await sign(pair.privateKey, header, good);
		const tampered = `${valid.slice(0, valid.lastIndexOf('.'))}.${b64url(new Uint8Array(256))}`;
		expect(await verifyAccessJwt(tampered, config, deps)).toEqual({ ok: false, reason: 'signature' });
		expect(
			await verifyAccessJwt(await sign(pair.privateKey, header, { ...good, sub: '' }), config, deps)
		).toEqual({ ok: true, configured: true, subject: null });
		expect(fetches).toBe(1);

		// An unknown kid after the minimum refetch interval triggers one refetch; after the TTL
		// the cached set is replaced.
		now += 60_000;
		await verifyAccessJwt(await sign(pair.privateKey, { ...header, kid: 'k9' }, good), config, deps);
		expect(fetches).toBe(2);
		now += 10 * 60_000;
		const later = Math.floor(now / 1000);
		expect(
			(
				await verifyAccessJwt(
					await sign(pair.privateKey, header, { ...good, exp: later + 600, iat: later }),
					config,
					deps
				)
			).ok
		).toBe(true);
		expect(fetches).toBe(3);
	});
});
