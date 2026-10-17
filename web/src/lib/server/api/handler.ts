// `defineApi(options, handler)`: the wrapper every /api/v1 `+server.ts` export goes through.
// Order: same-origin (unsafe methods) → auth level → rate limit → Turnstile → handler. ApiError
// becomes its JSON error; anything else becomes 500 `INTERNAL` with one PII-free log line (route id
// and error name only). The global read-only handle already answers 503 READ_ONLY to writes, so it
// is not repeated here. No `$app/*` imports: tested inside workerd.
import type { RequestEvent } from '@sveltejs/kit';
import { checkUser, type AuthLocals } from '../auth/guards.ts';
import { getServerEnv, type ServerEnv } from '../env.ts';
import { metricsFromEnv, recordServerError } from '../observability/metrics.ts';
import type { TurnstileAction } from '../security/turnstile.ts';
import type { AuthSession, AuthUser } from '../types.ts';
import { ApiError, apiError, apiErrorFrom } from './errors.ts';
import { apiAdmin, apiUser, apiVerified, type ApiPrincipal } from './guard.ts';
import { assertSameOrigin, UNSAFE_METHODS } from './http.ts';
import { apiRateLimit, apiTurnstile, type ApiQuota, type ApiRateKind } from './limits.ts';

export type ApiAuth = 'public' | 'user' | 'verified' | 'admin';

export interface ApiRouteRate {
	/** Route group of the rate-limit keys, e.g. `api.curves.read`. */
	group: string;
	/** Defaults to `write` for POST/PUT/PATCH/DELETE and `read` otherwise. */
	kind?: ApiRateKind;
	/** Optional D1 quotas (default window: one day). */
	quotas?: readonly ApiQuota[];
}

export interface ApiOptions {
	auth: ApiAuth;
	/** Burst guard (and quotas); `false` only for routes that are limited elsewhere. */
	rateLimit: ApiRouteRate | false;
	/** Require a Turnstile token (`x-turnstile-token`) for this action. */
	turnstile?: TurnstileAction;
	/** Admin routes only: destructive actions also need a fresh session (403 REAUTH_REQUIRED). */
	destructive?: boolean;
}

/** The part of SvelteKit's RequestEvent the wrapper uses (lets tests pass synthetic events). */
export interface ApiEvent {
	request: Request;
	locals: AuthLocals;
	platform?: { readonly env?: unknown } | undefined;
	route: { id: string | null };
}

export interface PublicApiContext<E extends ApiEvent = RequestEvent> {
	event: E;
	env: ServerEnv;
	/** The signed-in, non-banned user, or null. */
	user: AuthUser | null;
	session: AuthSession | null;
}

export interface ApiContext<E extends ApiEvent = RequestEvent> {
	event: E;
	env: ServerEnv;
	user: AuthUser;
	session: AuthSession;
}

export type ApiHandler<C> = (context: C) => Response | Promise<Response>;

/** Assignable to SvelteKit's `RequestHandler` when `E` is (the default) `RequestEvent`. */
export type ApiRequestHandler<E extends ApiEvent = RequestEvent> = (event: E) => Promise<Response>;

async function principalOf(
	options: ApiOptions,
	event: ApiEvent,
	env: ServerEnv
): Promise<ApiPrincipal | null> {
	switch (options.auth) {
		case 'user':
			return apiUser(event.locals);
		case 'verified':
			return apiVerified(event.locals);
		case 'admin':
			return apiAdmin(event.locals, env, event.request, event.platform?.env, {
				destructive: options.destructive === true
			});
		case 'public': {
			const current = checkUser(event.locals);
			return current.ok ? { user: current.user, session: current.session } : null;
		}
	}
}

function logLine(fields: Record<string, string | number>): string {
	return JSON.stringify(fields);
}

export function defineApi<E extends ApiEvent = RequestEvent>(
	options: ApiOptions & { auth: 'public' },
	handler: ApiHandler<PublicApiContext<E>>
): ApiRequestHandler<E>;
export function defineApi<E extends ApiEvent = RequestEvent>(
	options: ApiOptions & { auth: 'user' | 'verified' | 'admin' },
	handler: ApiHandler<ApiContext<E>>
): ApiRequestHandler<E>;
export function defineApi<E extends ApiEvent>(
	options: ApiOptions,
	handler: ApiHandler<PublicApiContext<E>> | ApiHandler<ApiContext<E>>
): ApiRequestHandler<E> {
	return (event: E) =>
		runApi(options, event, (context) => {
			if (isPublicHandler(options, handler)) return handler(context);
			return handler(authedContext(context));
		});
}

/** The overloads pair `auth: 'public'` with a public handler; this re-reads that pairing. */
function isPublicHandler<E extends ApiEvent>(
	options: ApiOptions,
	handler: ApiHandler<PublicApiContext<E>> | ApiHandler<ApiContext<E>>
): handler is ApiHandler<PublicApiContext<E>> {
	return options.auth === 'public' && typeof handler === 'function';
}

/** Non-public routes: the guards already threw without a principal; re-checked for the types. */
function authedContext<E extends ApiEvent>(context: PublicApiContext<E>): ApiContext<E> {
	const { event, env, user, session } = context;
	if (!user || !session) throw new ApiError(401, 'AUTH_REQUIRED');
	return { event, env, user, session };
}

async function runApi<E extends ApiEvent>(
	options: ApiOptions,
	event: E,
	invoke: (context: PublicApiContext<E>) => Response | Promise<Response>
): Promise<Response> {
	const route = event.route.id ?? 'unknown';
	try {
		const env = getServerEnv(event.platform);
		const { request } = event;
		const unsafe = UNSAFE_METHODS.has(request.method.toUpperCase());
		if (unsafe) assertSameOrigin(request, env.publicOrigin);

		const principal = await principalOf(options, event, env);
		const user = principal?.user ?? null;
		const session = principal?.session ?? null;

		if (options.rateLimit !== false) {
			await apiRateLimit(
				env,
				{ request, locals: { user, session } },
				{
					group: options.rateLimit.group,
					kind: options.rateLimit.kind ?? (unsafe ? 'write' : 'read'),
					...(options.rateLimit.quotas ? { quotas: options.rateLimit.quotas } : {})
				}
			);
		}
		if (options.turnstile) await apiTurnstile(env, request, options.turnstile);

		return await invoke({ event, env, user, session });
	} catch (error) {
		// T5.2: every 5xx also becomes one `http_5xx` metric (route id + code; no-op without METRICS).
		const metrics = metricsFromEnv(event.platform?.env);
		if (error instanceof ApiError) {
			if (error.status >= 500) {
				console.error(logLine({ event: 'api.error', route, code: error.code }));
				recordServerError(metrics, route, error.code, error.status);
			}
			return apiErrorFrom(error);
		}
		const name = error instanceof Error ? error.name : typeof error;
		console.error(logLine({ event: 'api.error', route, error: name }));
		recordServerError(metrics, route, name, 500);
		return apiError(500, 'INTERNAL');
	}
}
