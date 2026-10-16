// T3.T authorization matrix, part 3: the remaining auth pages × every persona (anonymous,
// unverified, verified, admin with and without the 2FA marker, banned), through the real route
// modules: /esqueci-senha (load + action), /redefinir-senha (load + action), /verificar-email
// (load + resend action) and /conta/encerrada.
//
// These pages are deliberately session-agnostic: their answers must not depend on who is signed in
// (no redirect, no different message, no data about the visitor), and a reset token, not the
// session that submits it, decides whose password changes.
//
// /conta/encerrada has no server module at all (only +page.svelte under conta/+layout.ts, which
// sets prerender = false and has no load): nothing on the server can leak or authorize there. The
// tests below pin that down; account.spec.ts renders it for anonymous and signed-in visitors.
import { setupNetwork } from '@msw/cloudflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RESEND_COOKIE } from '#lib/components/auth/actions.server.ts';
import {
	createVerifiedUser,
	linkOf,
	PASSWORD,
	signedIn,
	uniqueEmail,
	type Harness
} from '../auth/harness.ts';
import {
	harness,
	outcome,
	personas,
	PERSONAS,
	platform,
	routeEvent,
	routeModule,
	type PageServerModule,
	type Persona,
	type PersonaName
} from './helpers.ts';

const network = setupNetwork();

vi.setConfig({ testTimeout: 60_000 });

let h: Harness;
let all: Record<PersonaName, Persona>;

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
	h = harness(network);
	all = await personas(h);
}, 120_000);
afterAll(async () => {
	await network.disable();
});

const AUTH_HEADERS = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' };

describe('/esqueci-senha × personas', () => {
	it('load: the same empty form for everyone, never cached or indexed', async () => {
		const page = await routeModule<PageServerModule>('esqueci-senha/+page.server.ts');
		for (const name of PERSONAS) {
			const event = routeEvent({
				path: '/esqueci-senha',
				locals: all[name].locals,
				platform: platform()
			});
			expect(await outcome(() => page.load?.(event)), name).toEqual({ kind: 'data', data: {} });
			expect(event.headers, name).toMatchObject(AUTH_HEADERS);
		}
	});

	it('action: one answer for every persona and address; only existing accounts get mail', async () => {
		const page = await routeModule<PageServerModule>('esqueci-senha/+page.server.ts');
		for (const name of PERSONAS) {
			const persona = all[name];
			// Signed-in personas ask for their own address; the anonymous visitor for an unknown one.
			const email = persona.email ?? uniqueEmail('p3-forgot-nobody');
			const result = await outcome(() =>
				page.actions?.default?.(
					routeEvent({
						path: '/esqueci-senha',
						locals: persona.locals,
						platform: platform(),
						client: persona.client,
						form: {
							email,
							'cf-turnstile-response': h.turnstileToken('/request-password-reset') ?? ''
						}
					})
				)
			);
			// Identical for everyone apart from echoing the address that was typed.
			expect(result, name).toEqual({ kind: 'data', data: { sent: true, values: { email } } });
		}
		await h.flush();
		expect(h.mails(all.verified.email ?? '', 'reset-password').length).toBeGreaterThan(0);
	});

	it('action without Turnstile fails the same way for every persona', async () => {
		const page = await routeModule<PageServerModule>('esqueci-senha/+page.server.ts');
		const statuses = new Set<number>();
		for (const name of PERSONAS) {
			const result = await outcome(() =>
				page.actions?.default?.(
					routeEvent({
						path: '/esqueci-senha',
						locals: all[name].locals,
						platform: platform(),
						client: all[name].client,
						form: { email: all[name].email ?? uniqueEmail('p3-forgot-nt') }
					})
				)
			);
			expect(result.kind, name).toBe('fail');
			if (result.kind === 'fail') statuses.add(result.status);
		}
		expect(statuses).toEqual(new Set([400]));
	});
});

describe('/redefinir-senha × personas', () => {
	it('load: echoes only the token of the URL, never referrer-leaks it, for everyone', async () => {
		const page = await routeModule<PageServerModule>('redefinir-senha/+page.server.ts');
		for (const name of PERSONAS) {
			const withToken = routeEvent({
				path: '/redefinir-senha?token=abc123def456',
				locals: all[name].locals,
				platform: platform()
			});
			const result = await outcome(() => page.load?.(withToken));
			expect(result, name).toEqual({ kind: 'data', data: { token: 'abc123def456' } });
			expect(withToken.headers, name).toMatchObject({
				...AUTH_HEADERS,
				'referrer-policy': 'no-referrer'
			});
			const without = await outcome(() =>
				page.load?.(
					routeEvent({ path: '/redefinir-senha', locals: all[name].locals, platform: platform() })
				)
			);
			expect(without.kind, name).toBe('data');
			expect(without.kind === 'data' ? without.data.token : 'x', name).toBeFalsy();
		}
	});

	it('action: a bad token fails identically for everyone; the session never substitutes a token', async () => {
		const page = await routeModule<PageServerModule>('redefinir-senha/+page.server.ts');
		const answers = new Set<string>();
		for (const name of PERSONAS) {
			for (const token of ['not-a-real-token', '']) {
				const result = await outcome(() =>
					page.actions?.default?.(
						routeEvent({
							path: '/redefinir-senha',
							locals: all[name].locals,
							platform: platform(),
							client: all[name].client,
							form: { token, password: 'brand new pass 99', confirm: 'brand new pass 99' }
						})
					)
				);
				expect(result, `${name} ${token || '(empty)'}`).toMatchObject({
					kind: 'fail',
					status: 400,
					data: { error: 'token' }
				});
				answers.add(JSON.stringify(result));
			}
		}
		expect(answers.size).toBe(1);
		// Nobody's password changed.
		for (const name of PERSONAS.filter(
			(n) => n !== 'anonymous' && n !== 'banned' && n !== 'unverified'
		)) {
			expect((await h.client().signIn(all[name].email ?? '', PASSWORD)).status, name).not.toBe(401);
		}
	});

	it("a valid token changes its owner's password whoever submits it, and only the owner's sessions end", async () => {
		const page = await routeModule<PageServerModule>('redefinir-senha/+page.server.ts');
		const ownerEmail = uniqueEmail('p3-reset-owner');
		await createVerifiedUser(h, ownerEmail);
		const owner = await signedIn(h, ownerEmail);
		expect((await h.client().post('/request-password-reset', { email: ownerEmail })).status).toBe(
			200
		);
		await h.flush();
		const token = linkOf(h.mail(ownerEmail, 'reset-password')).searchParams.get('token') ?? '';
		const submitter = all.admin2fa;
		const newPassword = 'reset by token only 77';
		const result = await outcome(() =>
			page.actions?.default?.(
				routeEvent({
					path: '/redefinir-senha',
					locals: submitter.locals,
					platform: platform(),
					client: submitter.client,
					form: { token, password: newPassword, confirm: newPassword }
				})
			)
		);
		expect(result).toEqual({ kind: 'redirect', status: 303, location: '/entrar?redefinida=1' });
		expect(await owner.session()).toBeNull();
		expect((await submitter.client.session())?.user.email).toBe(submitter.email);
		expect((await h.client().signIn(ownerEmail, newPassword)).status).toBe(200);
		expect((await h.client().signIn(submitter.email ?? '', newPassword)).status).not.toBe(200);
	});
});

describe('/verificar-email × personas', () => {
	it('load: the same landing states for everyone (no redirect, nothing about the visitor)', async () => {
		const page = await routeModule<PageServerModule>('verificar-email/+page.server.ts');
		for (const query of ['?verificado=1', '?enviado=1', '?verificado=1&error=INVALID_TOKEN', '']) {
			const results = new Set<string>();
			for (const name of PERSONAS) {
				const event = routeEvent({
					path: `/verificar-email${query}`,
					locals: all[name].locals,
					platform: platform()
				});
				const result = await outcome(() => page.load?.(event));
				expect(result.kind, `${name} ${query}`).toBe('data');
				expect(event.headers).toMatchObject(AUTH_HEADERS);
				const text = JSON.stringify(result);
				if (all[name].email) expect(text).not.toContain(all[name].email);
				results.add(text);
			}
			expect(results.size, query).toBe(1);
		}
	});

	it('resend action: one answer for every persona, then the cooldown applies to everyone', async () => {
		const page = await routeModule<PageServerModule>('verificar-email/+page.server.ts');
		const statuses = new Set<string>();
		for (const name of PERSONAS) {
			const persona = all[name];
			const email = persona.email ?? uniqueEmail('p3-resend-nobody');
			const first = routeEvent({
				path: '/verificar-email',
				locals: persona.locals,
				platform: platform(),
				client: persona.client,
				form: { email }
			});
			const sent = await outcome(() => page.actions?.default?.(first));
			expect(sent, name).toMatchObject({ kind: 'data', data: { sent: true, values: { email } } });
			statuses.add(sent.kind);
			const cooldown = first.cookies.get(RESEND_COOKIE);
			expect(cooldown, name).toBeTruthy();

			const again = routeEvent({
				path: '/verificar-email',
				locals: persona.locals,
				platform: platform(),
				client: persona.client,
				form: { email }
			});
			again.cookies.set(RESEND_COOKIE, cooldown ?? '');
			const limited = await outcome(() => page.actions?.default?.(again));
			expect(limited, name).toMatchObject({
				kind: 'fail',
				status: 429,
				data: { error: 'cooldown' }
			});
		}
		expect(statuses).toEqual(new Set(['data']));
		await h.flush();
		// The unverified persona's address got a fresh verification link.
		expect(h.mails(all.unverified.email ?? '', 'verify-email').length).toBeGreaterThan(1);
	});
});

describe('/conta/encerrada', () => {
	it('has no server module: the conta layout only disables prerendering', async () => {
		const layout = await routeModule<PageServerModule & { prerender?: boolean }>(
			'conta/+layout.ts'
		);
		expect(layout.prerender).toBe(false);
		expect(layout.load).toBeUndefined();
		for (const file of ['conta/encerrada/+page.server.ts', 'conta/encerrada/+page.ts']) {
			await expect(routeModule(file), file).rejects.toThrow();
		}
	});
});
