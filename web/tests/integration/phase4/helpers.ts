// Fixtures of the T4.T battery (phase 4): the six personas of the authorization matrix, synthetic
// events for any `/api/v1` handler (any method, any params) and small readers of responses and
// SvelteKit `error()`/`redirect()` throws. Users come from ../account/helpers.ts and curves from
// ../social/curves/helpers.ts (real gate). Every id and nickname is unique: the D1 database is
// shared between files, so nothing here depends on global counts.
import { env } from 'cloudflare:workers';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { locals, nick, seedUser, uid, type SeededUser } from '../account/helpers.ts';

export const ORIGIN: string = env.PUBLIC_ORIGIN;

export const PERSONAS = [
	'anonymous',
	'banned',
	'unverified',
	'verified',
	'admin',
	'owner'
] as const;
export type PersonaName = (typeof PERSONAS)[number];

export interface Member {
	user: SeededUser & { username: string };
	locals: AuthLocals;
}

/** A user in D1 plus the `locals` hooks.server.ts would build for it. */
export async function member(
	options: { verified?: boolean; banned?: boolean; admin?: boolean; prefix?: string } = {}
): Promise<Member> {
	const verified = options.verified ?? true;
	const banned = options.banned ?? false;
	const username = nick(options.prefix ?? 'p4');
	const seeded = await seedUser({ username, verified, banned });
	if (options.admin) {
		await env.DB.prepare('UPDATE "user" SET "role" = ? WHERE "id" = ?')
			.bind('admin', seeded.id)
			.run();
	}
	return {
		user: { ...seeded, username },
		locals: locals(seeded, uid('session'), {
			emailVerified: verified,
			banned,
			role: options.admin ? 'admin' : 'user'
		})
	};
}

export const ANONYMOUS: AuthLocals = { user: null, session: null };

export function randomIp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return `10.${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 1}`;
}

/** A syntactically valid social id that names nothing (base64url, 22 characters). */
export function missingId(): string {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 22);
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export const METHODS: readonly Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface CallInit {
	params?: Record<string, string>;
	body?: unknown;
	query?: string;
	headers?: Record<string, string>;
}

export interface SyntheticEvent {
	request: Request;
	locals: AuthLocals;
	platform: { env: unknown };
	route: { id: string };
	params: Record<string, string>;
	url: URL;
}

/** Concrete path of a route id: `curves/[id]/favorite` + `{ id }` → `/api/v1/curves/<id>/favorite`. */
export function concretePath(routeId: string, params: Record<string, string>): string {
	const path = routeId.replace(/\[(\w+)\]/g, (_, name: string) =>
		encodeURIComponent(params[name] ?? name)
	);
	return `/api/v1/${path}`;
}

export function syntheticEvent(
	routeId: string,
	method: Method,
	who: AuthLocals,
	init: CallInit = {}
): SyntheticEvent {
	const params = init.params ?? {};
	const url = new URL(`${ORIGIN}${concretePath(routeId, params)}${init.query ?? ''}`);
	const unsafe = method !== 'GET';
	const headers: Record<string, string> = {
		'cf-connecting-ip': randomIp(),
		...(unsafe ? { origin: ORIGIN } : {}),
		...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
		...init.headers
	};
	return {
		request: new Request(url, {
			method,
			headers,
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
		}),
		locals: who,
		platform: { env },
		route: { id: `/api/v1/${routeId}` },
		params,
		url
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Calls the `method` export of an imported `+server.ts` module (no casts: checked at runtime). */
export async function invoke(
	module: unknown,
	method: Method,
	event: SyntheticEvent
): Promise<Response> {
	const handler: unknown = isRecord(module) ? module[method] : undefined;
	if (typeof handler !== 'function') throw new Error(`route has no ${method}`);
	const result: unknown = await Reflect.apply(handler, undefined, [event]);
	if (!(result instanceof Response)) throw new Error(`${method} did not return a Response`);
	return result;
}

/** HTTP methods exported by a route module. */
export function exportedMethods(module: unknown): Method[] {
	if (!isRecord(module)) return [];
	return METHODS.filter((method) => typeof module[method] === 'function');
}

/** `error.code` of a JSON error body, or null. Reads a clone (the response stays readable). */
export async function errorCode(response: Response): Promise<string | null> {
	const text = await response.clone().text();
	try {
		const body: unknown = JSON.parse(text);
		if (!isRecord(body) || !isRecord(body.error)) return null;
		return typeof body.error.code === 'string' ? body.error.code : null;
	} catch {
		return null;
	}
}

/** Status of a load: 200 when it returns, else the status of the thrown HttpError/Redirect. */
export async function loadStatus(run: () => Promise<unknown>): Promise<number> {
	try {
		await run();
		return 200;
	} catch (thrown) {
		const status: unknown = isRecord(thrown) ? thrown.status : undefined;
		if (typeof status === 'number') return status;
		throw thrown;
	}
}

/** Body text of a response or the JSON of a load result (for "never contains" assertions). */
export async function textOf(value: unknown): Promise<string> {
	if (value instanceof Response) return value.clone().text();
	return JSON.stringify(value) ?? '';
}
