// Server hooks, composed in this order (each wraps the ones after it):
//   a. platform shim: rebuilds `event.platform` (see below).
//   b. canonical host (T5.4b, security/canonical-host.ts): when PUBLIC_ORIGIN is a custom domain,
//      `*.workers.dev` requests get 301 (GET/HEAD) or 421 (other methods) before anything else;
//      staging (PUBLIC_ORIGIN on workers.dev) and local dev pass through.
//   c. request log (T5.2, observability/request-log.ts): one JSON line per request, wrapping all
//      the steps below so its latency covers them (the read-only 503 included).
// Then the steps whose order lives in #lib/server/auth/compose.ts (unit-tested):
//   0. read-only switch (T3.8): while on, writes outside the allowlist (and Better Auth's two
//      state-changing GET links) get 503 `READ_ONLY` first; that response still gets the
//      security headers and the access-log record (steps 3 and 4, through `finish`).
//   1. paraglide: locale from cookie/headers; fills %lang% / %dir% in app.html.
//   2. auth: per-request Better Auth instance (`locals.auth`) and `locals.user` / `locals.session`
//      from `auth.api.getSession` (null when signed out; a lookup failure never breaks a page).
//      `/api/auth/*` itself is served by src/routes/api/auth/[...all]/+server.ts with that same
//      instance, so it gets a route id for the access log and passes through the hooks below.
//   3. security headers (§3.8) on every response.
//   4. Marco Civil access log (T3.3) after resolve, when ACCESS_LOG_ENABLED.
// While prerendering there is no platform: auth, headers and the access log step aside (static
// files get their headers from web/_headers). Kit 3's adapter-cloudflare does not pass `platform`;
// the first step rebuilds it from `cloudflare:workers` so loads, actions and endpoints keep using
// `event.platform`.
import { building } from '$app/env';
import { getRequestEvent } from '$app/server';
import { sequence, type Handle, type HandleServerError } from '@sveltejs/kit/hooks';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { env as workerEnv, waitUntil as workerWaitUntil } from 'cloudflare:workers';
import { getTextDirection } from '#lib/paraglide/runtime.js';
import { paraglideMiddleware } from '#lib/paraglide/server.js';
import { accountDeletionHook } from '#lib/server/account/deletion.ts';
import { isReadOnly } from '#lib/server/admin/read-only.ts';
import { createAuth, toAuthLocals } from '#lib/server/auth.ts';
import { createReadOnlyHandle, orderedHandles } from '#lib/server/auth/compose.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { createRequestLogHandle } from '#lib/server/observability/request-log.ts';
import { logServerError } from '#lib/server/observability/server-error.ts';
import { captureAccess } from '#lib/server/security/access-log.ts';
import { createCanonicalHostHandle } from '#lib/server/security/canonical-host.ts';
import { applySecurityHeaders } from '#lib/server/security/headers.ts';

const platformShim: Handle = ({ event, resolve }) => {
	if (building || event.platform) return resolve(event);
	const platform: App.Platform = {
		env: workerEnv,
		ctx: { waitUntil: (promise: Promise<unknown>) => workerWaitUntil(promise) }
	};
	return resolve({ ...event, platform });
};

const paraglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		return resolve(
			{ ...event, request },
			{
				transformPageChunk: ({ html }) =>
					html.replace('%lang%', locale).replace('%dir%', getTextDirection(locale))
			}
		);
	});

const auth: Handle = async ({ event, resolve }) => {
	event.locals.auth = null;
	event.locals.user = null;
	event.locals.session = null;
	if (building) return resolve(event);

	const platform = event.platform;
	if (!platform) return resolve(event);
	const env = getServerEnv(platform);
	const instance = createAuth(env, {
		plugins: [sveltekitCookies(getRequestEvent)],
		waitUntil: (promise) => platform.ctx.waitUntil(promise),
		// T3.7 content-deletion policy (recorded mode, holds, e-mail change rows, acceptances).
		beforeDeleteUser: accountDeletionHook(env),
		// Read-only switch (T3.8): no session-refresh writes while it is on.
		readOnly: await isReadOnly(env)
	});
	event.locals.auth = instance;
	try {
		const current = toAuthLocals(await instance.api.getSession({ headers: event.request.headers }));
		event.locals.user = current?.user ?? null;
		event.locals.session = current?.session ?? null;
	} catch (error) {
		// Anonymous fallback; the log line carries no request data.
		console.warn(
			JSON.stringify({
				event: 'auth.session_lookup_failed',
				reason: error instanceof Error ? error.name : 'unknown'
			})
		);
	}
	return resolve(event);
};

type HookEvent = Parameters<Handle>[0]['event'];

function withSecurityHeaders(event: HookEvent, response: Response): Response {
	if (building) return response;
	return applySecurityHeaders(response, { origin: getServerEnv(event.platform).publicOrigin });
}

function recordAccess(event: HookEvent, response: Response): Response {
	const platform = event.platform;
	if (building || !platform) return response;
	const env = getServerEnv(platform);
	void captureAccess(event, {
		queue: env.accessLogQueue,
		enabled: env.flags.accessLogEnabled,
		waitUntil: (promise) => platform.ctx.waitUntil(promise),
		key: env.secrets.accessLogKey,
		status: response.status,
		userId: event.locals.user?.id ?? null
	});
	return response;
}

const securityHeaders: Handle = async ({ event, resolve }) =>
	withSecurityHeaders(event, await resolve(event));

const accessLog: Handle = async ({ event, resolve }) => recordAccess(event, await resolve(event));

// The 503 READ_ONLY skips the steps below, so it gets the same headers and access record here
// (locals.user is still null: the record carries no user id).
const readOnly = createReadOnlyHandle({
	building,
	env: getServerEnv,
	finish: (event, response) => withSecurityHeaders(event, recordAccess(event, response))
});

const canonicalHost = createCanonicalHostHandle({ building });

const requestLog = createRequestLogHandle({ building });

export const handle: Handle = sequence(
	platformShim,
	canonicalHost,
	requestLog,
	...orderedHandles({ readOnly, paraglide, auth, securityHeaders, accessLog })
);

// Replaces SvelteKit's default error log (message and stack, which may carry user input) with one
// PII-free JSON line per unexpected error: route id, status and error class only
// (observability/server-error.ts). The user-facing body stays `{ message: 'Internal Error' }`.
export const handleError: HandleServerError = (input) => logServerError(input);
