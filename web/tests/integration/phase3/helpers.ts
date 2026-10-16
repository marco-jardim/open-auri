// Shared fixtures of the Phase 3 battery (T3.T): personas for the authorization matrix, a plain
// copy of the Worker env with overrides (the platform the routes see), a minimal SvelteKit
// RequestEvent and an outcome reader for loads / actions / request handlers.
//
// Routes are imported dynamically with a computed specifier on purpose: their `./$types` imports
// and `App.*` types only exist in the SvelteKit TS program, so `check:int` must not follow them.
// Only route modules without `$app/*` imports are loaded this way (see routes.test.ts).
import type { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import type { Auth } from '#lib/server/auth.ts';
import type { AuthSession, AuthUser } from '#lib/server/types.ts';
import { enableTotp, harness as adminHarness, localsOf, makeAdmin } from '../admin/helpers.ts';
import {
	createVerifiedUser,
	PASSWORD,
	signedIn,
	uniqueEmail,
	uniqueUsername,
	type Client,
	type Harness
} from '../auth/harness.ts';

export type Network = ReturnType<typeof setupNetwork>;

export { adminHarness as harness };

// --- Worker env ---------------------------------------------------------------------------------

const ENV_KEYS = [
	'DB',
	'CONFIG',
	'MEDIA',
	'ACCESS_LOG_QUEUE',
	'RL_AUTH',
	'RL_API',
	'RL_WRITE',
	'PUBLIC_ORIGIN',
	'GITHUB_URL',
	'RESEND_FROM',
	'EMAIL_TRANSPORT',
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

/** Plain copy of the runtime env with entries replaced (`undefined` removes one). */
export function rawEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const copy: Record<string, unknown> = {};
	for (const key of ENV_KEYS) {
		const value: unknown = Reflect.get(env, key);
		if (value !== undefined) copy[key] = value;
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete copy[key];
		else copy[key] = value;
	}
	return copy;
}

export interface TestPlatform {
	env: Record<string, unknown>;
	ctx: { waitUntil(promise: Promise<unknown>): void };
	/** Waits for everything passed to waitUntil so far. */
	flush(): Promise<void>;
}

/**
 * `event.platform` for route tests: sign-up on, admin 2FA required, Access off (no ACCESS_*),
 * unless overridden.
 */
export function platform(overrides: Record<string, unknown> = {}): TestPlatform {
	const pending: Promise<unknown>[] = [];
	return {
		env: rawEnv({ SIGNUP_ENABLED: 'true', ADMIN_2FA_REQUIRED: 'true', ...overrides }),
		ctx: {
			waitUntil(promise) {
				pending.push(promise);
			}
		},
		async flush() {
			while (pending.length > 0) await Promise.allSettled(pending.splice(0));
		}
	};
}

// --- Personas -------------------------------------------------------------------------------------

export const PERSONAS = [
	'anonymous',
	'unverified',
	'verified',
	'admin',
	'admin2fa',
	'banned'
] as const;
export type PersonaName = (typeof PERSONAS)[number];

export interface TestLocals {
	auth: Auth;
	user: AuthUser | null;
	session: AuthSession | null;
}

export interface Persona {
	name: PersonaName;
	client: Client;
	id: string | null;
	email: string | null;
	locals: TestLocals;
}

async function setUserFlag(id: string, column: 'emailVerified' | 'banned', value: 0 | 1) {
	await env.DB.prepare(`UPDATE "user" SET "${column}" = ? WHERE id = ?`).bind(value, id).run();
}

/**
 * One signed-in (or anonymous) actor. `unverified` and `banned` are real verified accounts whose
 * row is flipped after sign-in (an unverified user cannot sign in; a real ban revokes sessions),
 * and whose locals carry the flag explicitly so the guards are exercised deterministically.
 */
export async function persona(h: Harness, name: PersonaName): Promise<Persona> {
	if (name === 'anonymous') {
		return {
			name,
			client: h.client(),
			id: null,
			email: null,
			locals: { auth: h.auth, user: null, session: null }
		};
	}
	const email = uniqueEmail(`p3-${name}`);
	const id = await createVerifiedUser(h, email, { username: uniqueUsername('p') });
	if (name === 'admin' || name === 'admin2fa') await makeAdmin(id);
	const client = await signedIn(h, email);
	if (name === 'admin2fa') await enableTotp(h, client);
	const current = await localsOf(client);
	let user = current.user;
	if (name === 'unverified') {
		await setUserFlag(id, 'emailVerified', 0);
		user = { ...user, emailVerified: false };
	}
	if (name === 'banned') {
		await setUserFlag(id, 'banned', 1);
		user = { ...user, banned: true };
	}
	return { name, client, id, email, locals: { auth: h.auth, user, session: current.session } };
}

export async function personas(h: Harness): Promise<Record<PersonaName, Persona>> {
	const entries = await Promise.all(PERSONAS.map(async (name) => [name, await persona(h, name)]));
	return Object.fromEntries(entries) as Record<PersonaName, Persona>;
}

export { PASSWORD };

// --- SvelteKit event ------------------------------------------------------------------------------

interface CookieOptions {
	path?: string;
	[key: string]: unknown;
}

/** Minimal `Cookies` of a RequestEvent (in-memory; reads the request's Cookie header). */
export class CookieJar {
	readonly values = new Map<string, string>();

	constructor(header: string | null) {
		for (const part of (header ?? '').split(';')) {
			const index = part.indexOf('=');
			if (index > 0) this.values.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
		}
	}

	get(name: string): string | undefined {
		return this.values.get(name);
	}

	getAll(): { name: string; value: string }[] {
		return [...this.values].map(([name, value]) => ({ name, value }));
	}

	set(name: string, value: string, options?: CookieOptions): void {
		void options;
		this.values.set(name, value);
	}

	delete(name: string, options?: CookieOptions): void {
		void options;
		this.values.delete(name);
	}

	serialize(name: string, value: string): string {
		return `${name}=${value}`;
	}
}

export interface RouteEvent {
	request: Request;
	url: URL;
	locals: TestLocals;
	platform: TestPlatform;
	cookies: CookieJar;
	params: Record<string, string>;
	route: { id: string | null };
	headers: Record<string, string>;
	setHeaders(headers: Record<string, string>): void;
	getClientAddress(): string;
	fetch: typeof fetch;
	isDataRequest: boolean;
	isSubRequest: boolean;
	isRemoteRequest: boolean;
}

export interface EventOptions {
	path: string;
	locals: TestLocals;
	platform: TestPlatform;
	/** Signed-in client whose cookies and IP are sent (default: none). */
	client?: Client;
	method?: string;
	/** Form fields (POST, urlencoded). */
	form?: Record<string, string>;
	/** JSON body (POST). */
	json?: unknown;
	/** Origin header; defaults to PUBLIC_ORIGIN for non-GET requests. `null` sends none. */
	origin?: string | null;
	headers?: Record<string, string>;
}

export function routeEvent(options: EventOptions): RouteEvent {
	const origin = String(options.platform.env.PUBLIC_ORIGIN);
	const method = options.method ?? (options.form || options.json !== undefined ? 'POST' : 'GET');
	const extra: Record<string, string> = { ...options.headers };
	const sendOrigin =
		options.origin === undefined ? (method === 'GET' ? null : origin) : options.origin;
	if (sendOrigin !== null) extra.origin = sendOrigin;
	let body: string | undefined;
	if (options.form) {
		extra['content-type'] = 'application/x-www-form-urlencoded';
		body = new URLSearchParams(options.form).toString();
	} else if (options.json !== undefined) {
		extra['content-type'] = 'application/json';
		body = JSON.stringify(options.json);
	}
	const headers = options.client
		? options.client.headers(extra)
		: new Headers({ 'cf-connecting-ip': '10.200.0.1', ...extra });
	const url = new URL(options.path, origin);
	const request = new Request(url, { method, headers, body });
	const set: Record<string, string> = {};
	return {
		request,
		url,
		locals: options.locals,
		platform: options.platform,
		cookies: new CookieJar(headers.get('cookie')),
		params: {},
		route: { id: url.pathname },
		headers: set,
		setHeaders(values) {
			for (const [name, value] of Object.entries(values)) set[name.toLowerCase()] = value;
		},
		getClientAddress: () => headers.get('cf-connecting-ip') ?? '127.0.0.1',
		fetch: (input, init) => fetch(input, init),
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	};
}

// --- Outcomes -------------------------------------------------------------------------------------

export type Outcome =
	| { kind: 'redirect'; status: number; location: string }
	| { kind: 'error'; status: number }
	| { kind: 'fail'; status: number; data: Record<string, unknown> }
	| { kind: 'response'; status: number; response: Response }
	| { kind: 'data'; data: Record<string, unknown> };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Runs a load / action / handler and classifies what SvelteKit would do with it: thrown
 * `redirect()` and `error()` (duck-typed: Kit's Redirect has `location`, HttpError has `body`),
 * returned `fail()` (ActionFailure: `status` + `data`), a Response, or plain data.
 */
export async function outcome(run: () => unknown): Promise<Outcome> {
	let value: unknown;
	try {
		value = await run();
	} catch (thrown) {
		if (isObject(thrown) && typeof thrown.status === 'number') {
			if (typeof thrown.location === 'string') {
				return { kind: 'redirect', status: thrown.status, location: thrown.location };
			}
			if ('body' in thrown) return { kind: 'error', status: thrown.status };
		}
		throw thrown;
	}
	if (value instanceof Response) return { kind: 'response', status: value.status, response: value };
	if (
		isObject(value) &&
		typeof value.status === 'number' &&
		'data' in value &&
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		return {
			kind: 'fail',
			status: value.status,
			data: (value.data ?? {}) as Record<string, unknown>
		};
	}
	return { kind: 'data', data: isObject(value) ? value : {} };
}

/** HTTP status SvelteKit would answer for an outcome (200 for data). */
export function statusOf(result: Outcome): number {
	return result.kind === 'data' ? 200 : result.status;
}

// --- Route modules ----------------------------------------------------------------------------------

type Handler = (event: RouteEvent) => unknown;

export interface PageServerModule {
	load?: Handler;
	actions?: Record<string, Handler>;
}

export interface EndpointModule {
	GET?: Handler;
	POST?: Handler;
}

const ROUTES_DIR = '../../../src/routes/';

/** Imports `web/src/routes/<path>` (computed specifier: not followed by `check:int`). */
export async function routeModule<T extends PageServerModule | EndpointModule>(
	path: string
): Promise<T> {
	const specifier = `${ROUTES_DIR}${path}`;
	return (await import(/* @vite-ignore */ specifier)) as T;
}

// --- Misc -----------------------------------------------------------------------------------------

export async function userRow(
	id: string
): Promise<{ email: string; emailVerified: number; banned: number } | null> {
	return env.DB.prepare('SELECT email, emailVerified, banned FROM "user" WHERE id = ?')
		.bind(id)
		.first();
}

export async function count(query: string, ...params: (string | number)[]): Promise<number> {
	const row = await env.DB.prepare(query)
		.bind(...params)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** A Date `minutes` ago. */
export function minutesAgo(minutes: number): Date {
	return new Date(Date.now() - minutes * 60 * 1000);
}
