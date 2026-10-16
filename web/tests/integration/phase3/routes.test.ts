// T3.T authorization matrix, part 2: the SvelteKit server surfaces of Phase 3, driven without a
// Kit server by calling the exported load / actions / RequestHandlers with a constructed event
// (locals from real Better Auth sessions, platform {env, ctx}).
//
// Loaded this way (no `$app/*` at module level): /conta (+exportar, +politica), /admin (layout,
// dashboard, usuarios, auditoria), /api/webhooks/resend, /api/auth/[...all], /api/dev/mailbox and
// the auth pages (/entrar, /criar-conta, /verificar-email, /esqueci-senha, /redefinir-senha).
// Not loadable here, tested through their lib functions instead: the root +layout.server.ts
// (`$app/env`: account summary → auth.ts toAuthLocals + legal/acceptance.ts), /termos and
// /privacidade (`$app/env/public` via #lib/config/public.ts; no Phase 3 auth surface) and
// hooks.server.ts (`$app/*`: its steps are compose.ts, read-only.ts and headers.ts, see
// cross-cutting.test.ts).
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POLICY_VERSION } from '#lib/content/legal/version.ts';
import { getAccountProfile } from '#lib/server/account/profile.ts';
import { forgetReadOnly, isReadOnly, setReadOnly } from '#lib/server/admin/read-only.ts';
import { computeSvixSignature, parseSvixSecret } from '#lib/server/email/webhook.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { createVerifiedUser, PASSWORD, uniqueEmail } from '../auth/harness.ts';
import {
	harness,
	minutesAgo,
	outcome,
	persona,
	personas,
	PERSONAS,
	platform,
	routeEvent,
	routeModule,
	statusOf,
	userRow,
	type EndpointModule,
	type PageServerModule,
	type Persona,
	type PersonaName
} from './helpers.ts';

const network = setupNetwork();

// Each matrix test signs up, verifies and signs in six personas (one with TOTP): well over 5 s.
vi.setConfig({ testTimeout: 60_000 });

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

// --- /conta ---------------------------------------------------------------------------------------

describe('/conta load × personas', () => {
	it('anonymous → /entrar?next=/conta, banned → 403, everyone else sees only their own data', async () => {
		const h = harness(network);
		const all = await personas(h);
		const page = await routeModule<PageServerModule>('conta/+page.server.ts');
		const p = platform();
		for (const name of PERSONAS) {
			const actor = all[name];
			const result = await outcome(() =>
				page.load?.(routeEvent({ path: '/conta', locals: actor.locals, platform: p }))
			);
			if (name === 'anonymous') {
				expect(result, name).toEqual({
					kind: 'redirect',
					status: 303,
					location: '/entrar?next=%2Fconta'
				});
			} else if (name === 'banned') {
				expect(statusOf(result), name).toBe(403);
			} else {
				expect(result.kind, name).toBe('data');
				const data = result.kind === 'data' ? result.data : {};
				expect((data.profile as { email: string }).email, name).toBe(actor.email);
				const sessions = data.sessions as { current: boolean }[];
				expect(sessions.length, name).toBeGreaterThan(0);
			}
		}
	});
});

/** Harmless input per action and the status a persona that passes the access check gets. */
const CONTA_ACTIONS: Record<
	string,
	{ form: Record<string, string>; verifiedOnly: boolean; allowed: number }
> = {
	nickname: { form: { nickname: '' }, verifiedOnly: true, allowed: 400 },
	bio: { form: { bio: 'matrix bio' }, verifiedOnly: true, allowed: 200 },
	visibility: { form: { activity_visibility: 'public' }, verifiedOnly: true, allowed: 200 },
	password: {
		form: { currentPassword: '', newPassword: '', confirmPassword: '' },
		verifiedOnly: false,
		allowed: 400
	},
	revokeSession: { form: { sessionId: 'no-such-session' }, verifiedOnly: false, allowed: 404 },
	revokeOthers: { form: {}, verifiedOnly: false, allowed: 200 },
	email: { form: { newEmail: 'not-an-email' }, verifiedOnly: false, allowed: 400 },
	close: { form: { mode: 'bogus', password: PASSWORD }, verifiedOnly: false, allowed: 400 },
	twoFactorStart: { form: { password: '' }, verifiedOnly: false, allowed: 400 },
	twoFactorConfirm: { form: { code: '12' }, verifiedOnly: false, allowed: 400 },
	twoFactorDisable: { form: { password: '' }, verifiedOnly: false, allowed: 400 }
};

function expectedContaStatus(name: PersonaName, verifiedOnly: boolean, allowed: number): number {
	if (name === 'anonymous') return 401;
	if (name === 'banned') return 403;
	if (name === 'unverified' && verifiedOnly) return 403;
	return allowed;
}

describe('/conta actions × personas', () => {
	it('every action re-checks access: 401 anonymous, 403 banned, 403 unverified on profile', async () => {
		const h = harness(network);
		const all = await personas(h);
		const page = await routeModule<PageServerModule>('conta/+page.server.ts');
		const p = platform();
		expect(Object.keys(page.actions ?? {}).sort()).toEqual(Object.keys(CONTA_ACTIONS).sort());
		for (const [action, spec] of Object.entries(CONTA_ACTIONS)) {
			for (const name of PERSONAS) {
				const actor = all[name];
				const handler = page.actions?.[action];
				const result = await outcome(() =>
					handler?.(
						routeEvent({
							path: `/conta?/${action}`,
							locals: actor.locals,
							platform: p,
							client: actor.client,
							form: spec.form
						})
					)
				);
				expect(statusOf(result), `${action} as ${name}`).toBe(
					expectedContaStatus(name, spec.verifiedOnly, spec.allowed)
				);
				if (name === 'anonymous' && result.kind === 'fail') {
					expect(result.data.error).toBe('unauthenticated');
				}
				if (name === 'banned' && result.kind === 'fail') expect(result.data.error).toBe('BANNED');
			}
		}
	});

	it('acts only on locals.user: a posted user id is ignored', async () => {
		const h = harness(network);
		const owner = await persona(h, 'verified');
		const other = await persona(h, 'verified');
		const page = await routeModule<PageServerModule>('conta/+page.server.ts');
		const result = await outcome(() =>
			page.actions?.bio?.(
				routeEvent({
					path: '/conta?/bio',
					locals: owner.locals,
					platform: platform(),
					client: owner.client,
					form: { bio: 'mine only', userId: other.id ?? '' }
				})
			)
		);
		expect(statusOf(result)).toBe(200);
		const now = Date.now();
		expect((await getAccountProfile(env.DB, owner.id ?? '', now))?.bio).toBe('mine only');
		expect((await getAccountProfile(env.DB, other.id ?? '', now))?.bio ?? null).toBeNull();
	});
});

describe('/conta/exportar and /conta/politica × personas', () => {
	it('signed-in and not banned only, same origin only, nothing secret in the export', async () => {
		const h = harness(network);
		const all = await personas(h);
		const exportRoute = await routeModule<EndpointModule>('conta/exportar/+server.ts');
		const policyRoute = await routeModule<EndpointModule>('conta/politica/+server.ts');
		const p = platform();
		for (const name of PERSONAS) {
			const actor = all[name];
			const expected = name === 'anonymous' ? 401 : name === 'banned' ? 403 : 200;
			const exported = await outcome(() =>
				exportRoute.POST?.(
					routeEvent({
						path: '/conta/exportar',
						method: 'POST',
						locals: actor.locals,
						platform: p,
						client: actor.client
					})
				)
			);
			expect(statusOf(exported), `export as ${name}`).toBe(expected);
			const acknowledged = await outcome(() =>
				policyRoute.POST?.(
					routeEvent({
						path: '/conta/politica',
						locals: actor.locals,
						platform: p,
						client: actor.client,
						json: { version: POLICY_VERSION }
					})
				)
			);
			expect(statusOf(acknowledged), `policy as ${name}`).toBe(expected);
			for (const route of [exportRoute, policyRoute]) {
				const crossSite = await outcome(() =>
					route.POST?.(
						routeEvent({
							path: '/conta/exportar',
							locals: actor.locals,
							platform: p,
							client: actor.client,
							json: { version: POLICY_VERSION },
							origin: 'https://evil.example'
						})
					)
				);
				expect(statusOf(crossSite), `cross-site as ${name}`).toBe(403);
			}
			if (expected === 200 && exported.kind === 'response') {
				await expectCleanExport(actor, exported.response);
			}
		}
	});
});

async function expectCleanExport(actor: Persona, response: Response): Promise<void> {
	expect(response.headers.get('content-disposition') ?? '').toMatch(/^attachment;/);
	expect(response.headers.get('cache-control')).toContain('no-store');
	const text = await response.text();
	const document = JSON.parse(text) as Record<string, unknown>;
	expect(Object.keys(document)).toEqual(expect.arrayContaining(['format', 'version']));
	const secrets = await env.DB.prepare(
		'SELECT s.token AS token, a.password AS password, t.secret AS secret, t.backupCodes AS codes ' +
			'FROM "session" s LEFT JOIN account a ON a.userId = s.userId ' +
			'LEFT JOIN twoFactor t ON t.userId = s.userId WHERE s.userId = ?'
	)
		.bind(actor.id)
		.all<{ token: string; password: string | null; secret: string | null; codes: string | null }>();
	for (const row of secrets.results) {
		for (const value of [row.token, row.password, row.secret, row.codes]) {
			if (value) expect(text, actor.name).not.toContain(value);
		}
	}
	expect(text).not.toMatch(/scrypt\$/);
	expect(text).not.toContain(String(env.BETTER_AUTH_SECRET));
}

// --- /admin ---------------------------------------------------------------------------------------

const ADMIN_LOADS = [
	['admin/+layout.server.ts', '/admin'],
	['admin/+page.server.ts', '/admin'],
	['admin/usuarios/+page.server.ts', '/admin/usuarios?q=u'],
	['admin/auditoria/+page.server.ts', '/admin/auditoria?page=1']
] as const;

describe('/admin × personas', () => {
	it('every load is 404 unless admin with the 2FA marker (ADMIN_2FA_REQUIRED=true)', async () => {
		const h = harness(network);
		const all = await personas(h);
		const p = platform({ ADMIN_2FA_REQUIRED: 'true' });
		for (const [file, path] of ADMIN_LOADS) {
			const page = await routeModule<PageServerModule>(file);
			for (const name of PERSONAS) {
				const event = routeEvent({ path, locals: all[name].locals, platform: p });
				const result = await outcome(() => page.load?.(event));
				expect(statusOf(result), `${file} as ${name}`).toBe(name === 'admin2fa' ? 200 : 404);
				if (file === 'admin/+layout.server.ts') {
					expect(event.headers['x-robots-tag']).toBe('noindex, nofollow');
					expect(event.headers['cache-control']).toBe('no-store');
				}
			}
		}
	});

	it('with ADMIN_2FA_REQUIRED=false an admin without the marker gets in; others still 404', async () => {
		const h = harness(network);
		const all = await personas(h);
		const p = platform({ ADMIN_2FA_REQUIRED: 'false' });
		const layout = await routeModule<PageServerModule>('admin/+layout.server.ts');
		for (const name of PERSONAS) {
			const result = await outcome(() =>
				layout.load?.(routeEvent({ path: '/admin', locals: all[name].locals, platform: p }))
			);
			const admitted = name === 'admin' || name === 'admin2fa';
			expect(statusOf(result), name).toBe(admitted ? 200 : 404);
		}
	});

	it('actions: 404 for non-admins, reauth for a stale admin, audited success for a fresh one', async () => {
		const h = harness(network);
		const all = await personas(h);
		const p = platform();
		const dashboard = await routeModule<PageServerModule>('admin/+page.server.ts');
		const users = await routeModule<PageServerModule>('admin/usuarios/+page.server.ts');
		const target = all.verified;
		const forms: [PageServerModule, string, Record<string, string>][] = [
			[dashboard, 'readOnly', { mode: 'off' }],
			[dashboard, 'reauth', { code: '000000' }],
			[users, 'searchEmail', { email: target.email ?? '' }],
			[users, 'ban', { userId: target.id ?? '', reason: 'matrix', duration: '1' }],
			[users, 'unban', { userId: target.id ?? '', reason: 'matrix' }],
			[users, 'reauth', { code: '000000' }]
		];
		for (const name of PERSONAS.filter((n) => n !== 'admin2fa')) {
			for (const [module, action, form] of forms) {
				const result = await outcome(() =>
					module.actions?.[action]?.(
						routeEvent({
							path: `/admin?/${action}`,
							locals: all[name].locals,
							platform: p,
							client: all[name].client,
							form
						})
					)
				);
				expect(statusOf(result), `${action} as ${name}`).toBe(404);
			}
		}
		expect((await userRow(target.id ?? ''))?.banned).toBe(0);

		const admin = all.admin2fa;
		const session = admin.locals.session;
		if (!session) throw new Error('admin session missing');
		const staleLocals = {
			...admin.locals,
			session: { ...session, createdAt: minutesAgo(30), twoFactorVerifiedAt: minutesAgo(30) }
		};
		const stale = await outcome(() =>
			dashboard.actions?.readOnly?.(
				routeEvent({
					path: '/admin?/readOnly',
					locals: staleLocals,
					platform: p,
					client: admin.client,
					form: { mode: 'on' }
				})
			)
		);
		expect(stale).toMatchObject({ kind: 'fail', status: 403, data: { reauth: true } });
		expect(await isReadOnly(getServerEnv(p))).toBe(false);

		const ban = await outcome(() =>
			users.actions?.ban?.(
				routeEvent({
					path: '/admin/usuarios?/ban',
					locals: admin.locals,
					platform: p,
					client: admin.client,
					form: { userId: target.id ?? '', reason: 'matrix test', duration: '1' }
				})
			)
		);
		expect(ban).toMatchObject({ kind: 'data', data: { done: 'ban' } });
		expect((await userRow(target.id ?? ''))?.banned).toBe(1);
		const audit = await env.DB.prepare(
			'SELECT count(*) AS n FROM audit_log WHERE actor_id = ? AND target_id = ?'
		)
			.bind(admin.id, target.id)
			.first<{ n: number }>();
		expect(audit?.n).toBeGreaterThan(0);
		const unban = await outcome(() =>
			users.actions?.unban?.(
				routeEvent({
					path: '/admin/usuarios?/unban',
					locals: admin.locals,
					platform: p,
					client: admin.client,
					form: { userId: target.id ?? '', reason: 'matrix test' }
				})
			)
		);
		expect(unban).toMatchObject({ kind: 'data', data: { done: 'unban' } });

		try {
			const on = await outcome(() =>
				dashboard.actions?.readOnly?.(
					routeEvent({
						path: '/admin?/readOnly',
						locals: admin.locals,
						platform: p,
						client: admin.client,
						form: { mode: 'on' }
					})
				)
			);
			expect(on).toMatchObject({ kind: 'data', data: { done: 'read_only_on' } });
			expect(await isReadOnly(getServerEnv(p))).toBe(true);
		} finally {
			await setReadOnly(getServerEnv(p), false, admin.id ?? 'test');
			forgetReadOnly(getServerEnv(p));
		}
	});
});

// --- /api/webhooks/resend, /api/auth/[...all], /api/dev/mailbox -------------------------------------

async function signedWebhook(body: string): Promise<Record<string, string>> {
	const key = parseSvixSecret(String(env.RESEND_WEBHOOK_SECRET));
	if (!key) throw new Error('webhook test secret missing');
	const id = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = await computeSvixSignature(key, id, timestamp, body);
	return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
}

describe('/api/webhooks/resend', () => {
	it('ignores who is signed in: only the svix signature decides', async () => {
		const h = harness(network);
		const all = await personas(h);
		const route = await routeModule<EndpointModule>('api/webhooks/resend/+server.ts');
		const p = platform();
		const body = JSON.stringify({
			type: 'email.bounced',
			data: { to: [uniqueEmail('p3-bounce')], bounce: { type: 'Permanent' } }
		});
		for (const name of PERSONAS) {
			const unsigned = await outcome(() =>
				route.POST?.(
					routeEvent({
						path: '/api/webhooks/resend',
						method: 'POST',
						locals: all[name].locals,
						platform: p,
						client: all[name].client,
						headers: { 'content-type': 'application/json' },
						json: JSON.parse(body)
					})
				)
			);
			expect(statusOf(unsigned), name).toBe(400);
		}
		const headers = await signedWebhook(body);
		const forged = await outcome(() =>
			route.POST?.({
				...routeEvent({ path: '/api/webhooks/resend', locals: all.admin2fa.locals, platform: p }),
				request: new Request(`${h.origin}/api/webhooks/resend`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...headers },
					body: body.replace('Permanent', 'Transient')
				})
			})
		);
		// A signed-in admin does not make a forged payload valid.
		expect(statusOf(forged)).toBe(401);
		const accepted = await outcome(() =>
			route.POST?.({
				...routeEvent({ path: '/api/webhooks/resend', locals: all.anonymous.locals, platform: p }),
				request: new Request(`${h.origin}/api/webhooks/resend`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...headers },
					body
				})
			})
		);
		expect(statusOf(accepted)).toBe(204);
	});
});

describe('/api/auth/[...all]', () => {
	it('delegates to locals.auth (session of the caller) and answers 503 without an instance', async () => {
		const h = harness(network);
		const verified = await persona(h, 'verified');
		const route = await routeModule<EndpointModule>('api/auth/[...all]/+server.ts');
		const p = platform();
		const event = routeEvent({
			path: '/api/auth/get-session',
			locals: verified.locals,
			platform: p,
			client: verified.client
		});
		const result = await outcome(() => route.GET?.(event));
		expect(result.kind).toBe('response');
		if (result.kind === 'response') {
			const body = (await result.response.json()) as { user?: { email?: string } } | null;
			expect(body?.user?.email).toBe(verified.email);
		}
		const none = await outcome(() =>
			route.POST?.({ ...event, locals: { ...event.locals, auth: null as never } })
		);
		expect(statusOf(none)).toBe(503);
	});
});

describe('/api/dev/mailbox', () => {
	it('is 404 with the production transport and refuses capture on a non-local origin', async () => {
		const h = harness(network);
		const anonymous = await persona(h, 'anonymous');
		const route = await routeModule<EndpointModule>('api/dev/mailbox/+server.ts');
		const production = await outcome(() =>
			route.GET?.(
				routeEvent({
					path: '/api/dev/mailbox?to=a%40example.com',
					locals: anonymous.locals,
					platform: platform({ EMAIL_TRANSPORT: 'resend' })
				})
			)
		);
		expect(statusOf(production)).toBe(404);
		await expect(
			outcome(() =>
				route.GET?.(
					routeEvent({
						path: '/api/dev/mailbox?to=a%40example.com',
						locals: anonymous.locals,
						platform: platform({
							EMAIL_TRANSPORT: 'capture',
							PUBLIC_ORIGIN: 'https://open-auri.example.org'
						})
					})
				)
			)
		).rejects.toThrow(/EMAIL_TRANSPORT/);
		const local = await outcome(() =>
			route.GET?.(
				routeEvent({
					path: '/api/dev/mailbox?to=nobody%40example.test',
					locals: anonymous.locals,
					platform: platform({ EMAIL_TRANSPORT: 'capture', PUBLIC_ORIGIN: 'http://localhost:4173' })
				})
			)
		);
		expect(statusOf(local)).toBe(200);
	});
});

// --- Auth pages -----------------------------------------------------------------------------------

describe('auth pages × personas', () => {
	it('loads: signed-in visitors are sent on, anonymous ones get the form; never cached', async () => {
		const h = harness(network);
		const all = await personas(h);
		const p = platform();
		for (const file of ['entrar/+page.server.ts', 'criar-conta/+page.server.ts']) {
			const page = await routeModule<PageServerModule>(file);
			for (const name of PERSONAS) {
				const event = routeEvent({ path: '/entrar', locals: all[name].locals, platform: p });
				const result = await outcome(() => page.load?.(event));
				if (name === 'anonymous') expect(result.kind, `${file} as ${name}`).toBe('data');
				else expect(result, `${file} as ${name}`).toMatchObject({ kind: 'redirect', status: 303 });
				expect(event.headers['cache-control']).toBe('private, no-store');
				expect(event.headers['x-robots-tag']).toBe('noindex, nofollow');
			}
		}
		const reset = await routeModule<PageServerModule>('redefinir-senha/+page.server.ts');
		const event = routeEvent({
			path: '/redefinir-senha?token=abc',
			locals: all.anonymous.locals,
			platform: p
		});
		await outcome(() => reset.load?.(event));
		expect(event.headers['referrer-policy']).toBe('no-referrer');
	});

	it('sign-up follows SIGNUP_ENABLED from the platform env; sign-in needs Turnstile', async () => {
		const h = harness(network);
		const anonymous = await persona(h, 'anonymous');
		const signUp = await routeModule<PageServerModule>('criar-conta/+page.server.ts');
		const email = uniqueEmail('p3-page-signup');
		const form = {
			email,
			password: PASSWORD,
			confirm: PASSWORD,
			'cf-turnstile-response': h.turnstileToken('/sign-up/email') ?? ''
		};
		const closed = await outcome(() =>
			signUp.actions?.default?.(
				routeEvent({
					path: '/criar-conta',
					locals: anonymous.locals,
					platform: platform({ SIGNUP_ENABLED: 'false' }),
					client: anonymous.client,
					form
				})
			)
		);
		expect(closed).toMatchObject({ kind: 'fail', status: 403, data: { error: 'signup_disabled' } });
		const opened = await outcome(() =>
			signUp.actions?.default?.(
				routeEvent({
					path: '/criar-conta',
					locals: anonymous.locals,
					platform: platform(),
					client: anonymous.client,
					form
				})
			)
		);
		expect(opened).toMatchObject({ kind: 'redirect', status: 303 });
		await h.flush();
		expect(h.mails(email, 'verify-email')).toHaveLength(1);

		const signIn = await routeModule<PageServerModule>('entrar/+page.server.ts');
		const verifiedEmail = uniqueEmail('p3-page-signin');
		await createVerifiedUser(h, verifiedEmail);
		const base = { email: verifiedEmail, password: PASSWORD };
		const noToken = await outcome(() =>
			signIn.actions?.signIn?.(
				routeEvent({
					path: '/entrar?/signIn',
					locals: anonymous.locals,
					platform: platform(),
					client: h.client(),
					form: base
				})
			)
		);
		expect(noToken.kind).toBe('fail');
		const ok = await outcome(() =>
			signIn.actions?.signIn?.(
				routeEvent({
					path: '/entrar?/signIn',
					locals: anonymous.locals,
					platform: platform(),
					client: h.client(),
					form: { ...base, 'cf-turnstile-response': h.turnstileToken('/sign-in/email') ?? '' }
				})
			)
		);
		expect(ok).toMatchObject({ kind: 'redirect', status: 303 });
		const wrong = await outcome(() =>
			signIn.actions?.signIn?.(
				routeEvent({
					path: '/entrar?/signIn',
					locals: anonymous.locals,
					platform: platform(),
					client: h.client(),
					form: {
						email: verifiedEmail,
						password: 'not the password 00',
						'cf-turnstile-response': h.turnstileToken('/sign-in/email') ?? ''
					}
				})
			)
		);
		expect(wrong.kind).toBe('fail');
		const stranger = uniqueEmail('p3-nobody');
		const unknown = await outcome(() =>
			signIn.actions?.signIn?.(
				routeEvent({
					path: '/entrar?/signIn',
					locals: anonymous.locals,
					platform: platform(),
					client: h.client(),
					form: {
						email: stranger,
						password: 'not the password 00',
						'cf-turnstile-response': h.turnstileToken('/sign-in/email') ?? ''
					}
				})
			)
		);
		// Anti-enumeration: unknown address and wrong password answer the same (only the echoed
		// e-mail differs).
		expect(unknown.kind).toBe('fail');
		if (unknown.kind === 'fail' && wrong.kind === 'fail') {
			expect(unknown.status).toBe(wrong.status);
			expect({ ...unknown.data, values: null }).toEqual({ ...wrong.data, values: null });
			expect(unknown.data.values).toEqual({ email: stranger });
		}
	});

	it('reset request answers the same for known and unknown addresses; bad tokens fail', async () => {
		const h = harness(network);
		const anonymous = await persona(h, 'anonymous');
		const forgot = await routeModule<PageServerModule>('esqueci-senha/+page.server.ts');
		const known = uniqueEmail('p3-forgot-known');
		await createVerifiedUser(h, known);
		const results = [];
		for (const email of [known, uniqueEmail('p3-forgot-unknown')]) {
			const result = await outcome(() =>
				forgot.actions?.default?.(
					routeEvent({
						path: '/esqueci-senha',
						locals: anonymous.locals,
						platform: platform(),
						client: h.client(),
						form: {
							email,
							'cf-turnstile-response': h.turnstileToken('/request-password-reset') ?? ''
						}
					})
				)
			);
			expect(result).toMatchObject({ kind: 'data', data: { sent: true } });
			results.push(result.kind);
		}
		expect(new Set(results).size).toBe(1);
		await h.flush();
		expect(h.mails(known, 'reset-password')).toHaveLength(1);

		const reset = await routeModule<PageServerModule>('redefinir-senha/+page.server.ts');
		const bad = await outcome(() =>
			reset.actions?.default?.(
				routeEvent({
					path: '/redefinir-senha',
					locals: anonymous.locals,
					platform: platform(),
					client: h.client(),
					form: {
						token: 'not-a-real-token',
						password: 'brand new pass 99',
						confirm: 'brand new pass 99'
					}
				})
			)
		);
		expect(bad.kind).toBe('fail');

		const verify = await routeModule<PageServerModule>('verificar-email/+page.server.ts');
		const landing = await outcome(() =>
			verify.load?.(
				routeEvent({
					path: '/verificar-email?verificado=1',
					locals: anonymous.locals,
					platform: platform()
				})
			)
		);
		expect(landing.kind).toBe('data');
	});
});
