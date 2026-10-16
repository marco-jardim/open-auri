// Test harness for the auth flows: builds a Better Auth instance with createAuth() and drives
// `auth.handler(request)` directly (no SvelteKit). Outbound HTTP is mocked with @msw/cloudflare:
//   - Resend: every message is captured in `outbox` (links are read from the plain-text part);
//   - Turnstile Siteverify: the token says what to answer. `ok:<action>:<hostname>` succeeds for
//     that action and hostname, anything else fails with `invalid-input-response`.
// Each Client has its own cookie jar and its own random client IP (so rate-limit windows of
// different tests never meet).
import type { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { http, HttpResponse } from 'msw';
import { createAuth, type Auth, type CreateAuthOptions } from '#lib/server/auth.ts';
import { RESEND_ENDPOINT } from '#lib/server/email/index.ts';
import { getServerEnv, type ServerEnv } from '#lib/server/env.ts';
import { AUTH_POLICIES, isAuthGuardedPath } from '#lib/server/security/ratelimit.ts';
import { SITEVERIFY_URL } from '#lib/server/security/turnstile.ts';

export const PASSWORD = 'correct horse battery 1';
export const NEW_PASSWORD = 'another long secret 22';

export interface SentEmail {
	to: string;
	subject: string;
	text: string;
	html: string;
	template: string;
}

export const outbox: SentEmail[] = [];

type Network = ReturnType<typeof setupNetwork>;

/** Handlers for Resend and Siteverify; call in beforeAll after `network.enable()`. */
export function mockNetwork(network: Network): void {
	network.use(
		http.post(RESEND_ENDPOINT, async ({ request }) => {
			const body = (await request.json()) as {
				to: string[];
				subject: string;
				text: string;
				html: string;
				tags?: { name: string; value: string }[];
			};
			outbox.push({
				to: body.to[0] ?? '',
				subject: body.subject,
				text: body.text,
				html: body.html,
				template: body.tags?.find((tag) => tag.name === 'template')?.value ?? ''
			});
			return HttpResponse.json({ id: `email_${outbox.length}` });
		}),
		http.post(SITEVERIFY_URL, async ({ request }) => {
			const form = new URLSearchParams(await request.text());
			const token = form.get('response') ?? '';
			const [kind, action, hostname] = token.split(':');
			if (kind === 'ok' && action && hostname) {
				return HttpResponse.json({ success: true, action, hostname });
			}
			return HttpResponse.json({ success: false, 'error-codes': ['invalid-input-response'] });
		})
	);
}

export function uniqueEmail(prefix = 'user'): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 12)}@example.com`;
}

export function uniqueUsername(prefix = 'u'): string {
	return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function randomIp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return `10.${bytes[0]}.${bytes[1]}.${bytes[2]}`;
}

export interface EnvOverrides {
	signupEnabled?: boolean;
	admin2faRequired?: boolean;
	publicOrigin?: string;
}

/** The validated test env with flag overrides (sign-up on by default here). */
export function testEnv(overrides: EnvOverrides = {}): ServerEnv {
	const base = getServerEnv({ env });
	return {
		...base,
		publicOrigin: overrides.publicOrigin ?? base.publicOrigin,
		flags: {
			...base.flags,
			signupEnabled: overrides.signupEnabled ?? true,
			admin2faRequired: overrides.admin2faRequired ?? base.flags.admin2faRequired
		}
	};
}

export class Harness {
	readonly auth: Auth;
	readonly env: ServerEnv;
	readonly origin: string;
	readonly hostname: string;
	#pending: Promise<unknown>[] = [];

	constructor(overrides: EnvOverrides = {}, options: Partial<CreateAuthOptions> = {}) {
		this.env = testEnv(overrides);
		this.origin = this.env.publicOrigin;
		this.hostname = new URL(this.origin).hostname;
		this.auth = createAuth(this.env, {
			...options,
			waitUntil: (promise) => {
				this.#pending.push(promise);
			}
		});
	}

	/** Waits for every background task (e-mail delivery) scheduled so far. */
	async flush(): Promise<void> {
		while (this.#pending.length > 0) {
			const batch = this.#pending.splice(0);
			await Promise.allSettled(batch);
		}
	}

	client(): Client {
		return new Client(this);
	}

	turnstileToken(path: string): string | null {
		if (!isAuthGuardedPath(path)) return null;
		const action = AUTH_POLICIES[path].turnstileAction;
		return action ? `ok:${action}:${this.hostname}` : null;
	}

	/** Messages sent to `to` (optionally of one template), oldest first. */
	mails(to: string, template?: string): SentEmail[] {
		return outbox.filter((mail) => mail.to === to && (!template || mail.template === template));
	}

	/** The single message of `template` sent to `to`; throws when there is not exactly one. */
	mail(to: string, template: string): SentEmail {
		const found = this.mails(to, template);
		if (found.length !== 1) throw new Error(`expected 1 ${template} e-mail, got ${found.length}`);
		return found[0] as SentEmail;
	}
}

/** First URL of the e-mail (the action link). */
export function linkOf(mail: SentEmail): URL {
	const match = /https?:\/\/[^\s]+/.exec(mail.text);
	if (!match) throw new Error('no link in e-mail');
	return new URL(match[0]);
}

export interface PostOptions {
	/** Turnstile token; defaults to a passing token for guarded paths. `null` sends none. */
	turnstile?: string | null;
	/** Origin header; defaults to the harness origin. `null` sends none. */
	origin?: string | null;
	headers?: Record<string, string>;
}

export class Client {
	readonly ip = randomIp();
	readonly cookies = new Map<string, string>();
	readonly #harness: Harness;

	constructor(harness: Harness) {
		this.#harness = harness;
	}

	cookieHeader(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
	}

	headers(extra: Record<string, string> = {}): Headers {
		const headers = new Headers({ 'cf-connecting-ip': this.ip, ...extra });
		const cookie = this.cookieHeader();
		if (cookie) headers.set('cookie', cookie);
		return headers;
	}

	#store(response: Response): void {
		for (const line of response.headers.getSetCookie()) {
			const [pair = '', ...attributes] = line.split(';');
			const index = pair.indexOf('=');
			const name = pair.slice(0, index).trim();
			const value = pair.slice(index + 1).trim();
			const expired =
				value === '' ||
				attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) ||
				attributes.some((attribute) => {
					const match = /^\s*expires=(.+)$/i.exec(attribute);
					return match?.[1] !== undefined && new Date(match[1]).getTime() <= Date.now();
				});
			if (expired) this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
	}

	async post(path: string, body: unknown = {}, options: PostOptions = {}): Promise<Response> {
		const harness = this.#harness;
		const extra: Record<string, string> = {
			'content-type': 'application/json',
			...options.headers
		};
		const origin = options.origin === undefined ? harness.origin : options.origin;
		if (origin !== null) extra.origin = origin;
		const token =
			options.turnstile === undefined ? harness.turnstileToken(path) : options.turnstile;
		if (token !== null) extra['x-turnstile-token'] = token;
		const response = await harness.auth.handler(
			new Request(`${harness.origin}/api/auth${path}`, {
				method: 'POST',
				headers: this.headers(extra),
				body: JSON.stringify(body)
			})
		);
		this.#store(response);
		return response;
	}

	/** GET of an auth URL (path under /api/auth, or a full link from an e-mail). */
	async get(target: string | URL): Promise<Response> {
		const harness = this.#harness;
		const url =
			target instanceof URL ? target.href : new URL(`/api/auth${target}`, harness.origin).href;
		const response = await harness.auth.handler(
			new Request(url, { method: 'GET', headers: this.headers(), redirect: 'manual' })
		);
		this.#store(response);
		return response;
	}

	/** Current session as the API reports it (null when signed out). */
	async session(): Promise<{
		user: Record<string, unknown>;
		session: Record<string, unknown>;
	} | null> {
		const response = await this.get('/get-session');
		if (!response.ok) return null;
		const body: unknown = await response.json();
		if (!body || typeof body !== 'object') return null;
		return body as { user: Record<string, unknown>; session: Record<string, unknown> };
	}

	signUp(email: string, extra: Record<string, unknown> = {}): Promise<Response> {
		return this.post('/sign-up/email', {
			name: 'Test Person',
			email,
			password: PASSWORD,
			...extra
		});
	}

	signIn(email: string, password = PASSWORD): Promise<Response> {
		return this.post('/sign-in/email', { email, password });
	}
}

/** Signs up `email`, follows the verification link and returns the user id. */
export async function createVerifiedUser(
	harness: Harness,
	email = uniqueEmail(),
	extra: Record<string, unknown> = {}
): Promise<string> {
	const client = harness.client();
	const response = await client.signUp(email, extra);
	if (response.status !== 200) throw new Error(`sign-up failed: ${response.status}`);
	await harness.flush();
	const verified = await harness.client().get(linkOf(harness.mail(email, 'verify-email')));
	if (verified.status >= 400) throw new Error(`verification failed: ${verified.status}`);
	const row = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ id: string }>();
	if (!row) throw new Error('user row missing');
	return row.id;
}

/** Signs in a fresh client and returns it. */
export async function signedIn(
	harness: Harness,
	email: string,
	password = PASSWORD
): Promise<Client> {
	const client = harness.client();
	const response = await client.signIn(email, password);
	if (response.status !== 200) throw new Error(`sign-in failed: ${response.status}`);
	return client;
}

export async function errorCode(response: Response): Promise<string | undefined> {
	const body = (await response
		.clone()
		.json()
		.catch(() => ({}))) as { code?: unknown };
	return typeof body.code === 'string' ? body.code : undefined;
}

/** Decodes the RFC 4648 base32 secret of an otpauth:// URI into the raw TOTP secret. */
export function totpSecretFromUri(uri: string): string {
	const encoded = new URL(uri).searchParams.get('secret') ?? '';
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const bytes: number[] = [];
	for (const char of encoded.replace(/=+$/, '').toUpperCase()) {
		const index = alphabet.indexOf(char);
		if (index < 0) throw new Error('bad base32');
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}
