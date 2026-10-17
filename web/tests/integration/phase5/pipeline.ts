// Fixtures of the T5.T battery (phase 5, web part): the request pipeline of src/hooks.server.ts,
// rebuilt from the real modules it composes, in front of real route modules.
//
// hooks.server.ts itself cannot be imported in workerd (it imports `$app/env`, `$app/server` and
// paraglide's generated server; see phase3/cross-cutting.test.ts), so `pipeline()` chains the
// same factories in the same order (checked against the source text in headers.test.ts):
//
//   canonicalHost  → requestLog → readOnly(+finish) → [paraglide, auth] → securityHeaders → route
//
// Stand-ins: the platform shim is replaced by an event that already carries `platform` (env + a
// waitUntil collector); paraglide only rewrites %lang% in HTML chunks and is left out; auth is
// replaced by the `locals` given to the event (as phase4/helpers.ts does); the Marco Civil access
// log step is covered by security/access-log.test.ts. The security-header step is the one-liner
// of hooks.server.ts (`applySecurityHeaders(response, { origin: PUBLIC_ORIGIN })`), and the 503's
// `finish` gets the same function, as in hooks.server.ts.
//
// The KV read-only switch is NEVER flipped (KV is shared with the other files): `configView(on)`
// is a view of CONFIG whose `mode:read-only` reads '1' or nothing, as in phase4/protections.
import type { KVNamespace } from '@cloudflare/workers-types';
import type { Handle } from '@sveltejs/kit/hooks';
import { env } from 'cloudflare:workers';
import { READ_ONLY_KEY } from '#lib/server/admin/read-only.ts';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { createReadOnlyHandle } from '#lib/server/auth/compose.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { createRequestLogHandle } from '#lib/server/observability/request-log.ts';
import { createCanonicalHostHandle } from '#lib/server/security/canonical-host.ts';
import { applySecurityHeaders } from '#lib/server/security/headers.ts';
import type { Method, SyntheticEvent } from '../phase4/helpers.ts';

export const ORIGIN: string = env.PUBLIC_ORIGIN;

export interface PipelineEvent extends SyntheticEvent {
	platform: { env: unknown; ctx: { waitUntil(promise: Promise<unknown>): void } };
}

export interface EventInit {
	method?: Method | 'HEAD' | 'OPTIONS';
	/** SvelteKit route id as the request log sees it (e.g. `/api/v1/feed`). */
	routeId: string;
	params?: Record<string, string>;
	headers?: Record<string, string>;
	body?: unknown;
	locals?: AuthLocals;
	/** `platform.env` (default: the integration env). */
	platformEnv?: unknown;
}

/** Promises handed to `waitUntil` by the routes (awaited by `settled()`). */
const pending: Promise<unknown>[] = [];

export async function settled(): Promise<void> {
	await Promise.allSettled(pending.splice(0));
}

/** A request event for an absolute URL (any host: the canonical-host case needs workers.dev). */
export function eventAt(url: string, init: EventInit): PipelineEvent {
	const method = init.method ?? 'GET';
	const headers: Record<string, string> = {
		'cf-connecting-ip': randomIp(),
		...(method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? {} : { origin: ORIGIN }),
		...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
		...init.headers
	};
	return {
		request: new Request(url, {
			method,
			headers,
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
		}),
		locals: init.locals ?? { user: null, session: null },
		platform: {
			env: init.platformEnv ?? env,
			ctx: { waitUntil: (promise) => void pending.push(promise) }
		},
		route: { id: init.routeId },
		params: init.params ?? {},
		url: new URL(url)
	};
}

/** Same as {@link eventAt} for a path on PUBLIC_ORIGIN. */
export function eventFor(path: string, init: EventInit): PipelineEvent {
	return eventAt(`${ORIGIN}${path}`, init);
}

export function randomIp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return `10.${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 1}`;
}

/** CONFIG as the read-only step sees it with the switch on (`'1'`) or off (absent). */
export function configView(on: boolean): KVNamespace {
	const config: KVNamespace = env.CONFIG;
	return new Proxy(config, {
		get(target, property, receiver) {
			if (property === 'get') {
				return async (key: string) => {
					if (key === READ_ONLY_KEY) return on ? '1' : null;
					return target.get(key);
				};
			}
			const value: unknown = Reflect.get(target, property, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

function originOf(platform: { readonly env?: unknown } | undefined): string {
	return getServerEnv(platform).publicOrigin;
}

export interface PipelineOptions {
	/** Read-only switch as seen through {@link configView}. */
	readOnly: boolean;
	/** PUBLIC_ORIGIN for the canonical-host step only (default: the env's, local → pass-through). */
	canonicalOrigin?: string;
}

export type Endpoint = (event: PipelineEvent) => Promise<Response> | Response;

/** The ordered handles (see the file header). */
export function handles(options: PipelineOptions): Handle[] {
	const config = configView(options.readOnly);
	const canonicalOrigin = options.canonicalOrigin;
	const securityHeaders: Handle = async ({ event, resolve }) =>
		applySecurityHeaders(await resolve(event), { origin: originOf(event.platform) });
	return [
		createCanonicalHostHandle(
			canonicalOrigin === undefined ? {} : { publicOrigin: () => canonicalOrigin }
		),
		createRequestLogHandle(),
		createReadOnlyHandle({
			building: false,
			env: () => ({ config }),
			finish: (event, response) =>
				applySecurityHeaders(response, { origin: originOf(event.platform) })
		}),
		securityHeaders
	];
}

/**
 * Runs `event` through the handles, then `endpoint` (the route module). Handles are called with
 * `Reflect.apply` (the synthetic event is not a full RequestEvent; nothing is cast).
 */
export async function through(
	options: PipelineOptions,
	event: PipelineEvent,
	endpoint: Endpoint
): Promise<Response> {
	const chain = handles(options);
	const step = async (index: number, current: PipelineEvent): Promise<Response> => {
		const handle = chain[index];
		if (!handle) return endpoint(current);
		const result: unknown = await Reflect.apply(handle, undefined, [
			{ event: current, resolve: (next: PipelineEvent) => step(index + 1, next) }
		]);
		if (!(result instanceof Response)) throw new Error(`handle ${index} returned no Response`);
		return result;
	};
	return step(0, event);
}

export const KIT_POLICY =
	"default-src 'self'; script-src 'self' 'nonce-phase5'; style-src 'self' 'nonce-phase5'; " +
	"style-src-attr 'unsafe-inline'; object-src 'none'";

/** A response shaped like SvelteKit's SSR page (text/html with its nonce CSP header). */
export function kitPage(
	html = '<!doctype html><html lang="pt-BR"><title>x</title></html>',
	status = 200
): Response {
	return new Response(html, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'content-security-policy': KIT_POLICY
		}
	});
}

/** Every console line written while `run` executes (log, info, warn, error). */
export async function captureConsole<T>(
	run: () => Promise<T>
): Promise<{ result: T | undefined; error: unknown; lines: string[] }> {
	const lines: string[] = [];
	const sinks = ['log', 'info', 'warn', 'error'] as const;
	const originals = sinks.map((name) => console[name]);
	for (const name of sinks) {
		console[name] = (...args: unknown[]) => {
			const parts = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)));
			lines.push(parts.join(' '));
		};
	}
	try {
		return { result: await run(), error: null, lines };
	} catch (error) {
		return { result: undefined, error, lines };
	} finally {
		sinks.forEach((name, index) => {
			const original = originals[index];
			if (original) console[name] = original;
		});
	}
}

/** The `http.request` lines among captured console lines, parsed. */
export function requestLines(lines: readonly string[]): Record<string, unknown>[] {
	const parsed: Record<string, unknown>[] = [];
	for (const line of lines) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			// Not a JSON line (no request-log line is ever plain text).
			continue;
		}
		if (typeof value !== 'object' || value === null) continue;
		if (Reflect.get(value, 'event') === 'http.request') {
			parsed.push(Object.fromEntries(Object.entries(value)));
		}
	}
	return parsed;
}
