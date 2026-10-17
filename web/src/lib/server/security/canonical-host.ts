// Canonical host (T5.4b): production answers on its custom domain (PUBLIC_ORIGIN, e.g.
// https://open-auri.com), but Cloudflare keeps the Worker's `*.workers.dev` hostname reachable.
// Requests that arrive there are sent to the canonical origin so cookies, CSRF origin checks,
// Turnstile hostnames and links all see one host.
//
//   - Active only when PUBLIC_ORIGIN is a custom domain: a `*.workers.dev` PUBLIC_ORIGIN (staging)
//     or a loopback one (local dev, e2e) turns the step off entirely.
//   - Only a request whose host ends with `.workers.dev` and differs from the PUBLIC_ORIGIN host is
//     touched; any other host (the custom domain itself, previews, tests) passes through.
//   - GET / HEAD: `301` to the same path + query on PUBLIC_ORIGIN, `cache-control: no-store` (the
//     redirect target follows configuration, so no cache may pin it).
//   - Any other method: `421 Misdirected Request`, no body. Chosen over 403 because nothing is
//     forbidden to the caller: this host simply does not serve the application. A redirect is not
//     used for writes (a 301/308 would replay or drop the body on another origin, and a write that
//     reaches workers.dev never carries the canonical session cookie anyway).
//
// The step runs right after the platform shim, before the request log and the other hooks, so
// these responses carry no request-log line, access record or security headers (they have no
// body and no route). No `$app/*` imports: hooks.server.ts passes `building`.
import type { Handle } from '@sveltejs/kit/hooks';
import { getServerEnv, isLocalOrigin } from '../env.ts';

export interface CanonicalHostOptions {
	/** `building` from `$app/env`: no platform while prerendering, the step stays out. */
	building?: boolean;
	/** Canonical origin for a platform (default: `getServerEnv(platform).publicOrigin`). */
	publicOrigin?: (platform: { readonly env?: unknown }) => string;
}

const WORKERS_DEV = '.workers.dev';

function isWorkersDevHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === WORKERS_DEV.slice(1) || host.endsWith(WORKERS_DEV);
}

/** True when `publicOrigin` is a custom domain, i.e. neither `*.workers.dev` nor loopback. */
export function isCustomDomainOrigin(publicOrigin: string): boolean {
	if (isLocalOrigin(publicOrigin)) return false;
	let url: URL;
	try {
		url = new URL(publicOrigin);
	} catch {
		// Not a URL: no canonical host to redirect to.
		return false;
	}
	return !isWorkersDevHost(url.hostname);
}

/**
 * The canonical-host response for `request`, or null when it passes through unchanged.
 * Pure: exported for the integration tests.
 */
export function canonicalHostResponse(request: Request, publicOrigin: string): Response | null {
	if (!isCustomDomainOrigin(publicOrigin)) return null;
	const canonical = new URL(publicOrigin);
	const url = new URL(request.url);
	if (url.host.toLowerCase() === canonical.host.toLowerCase()) return null;
	if (!isWorkersDevHost(url.hostname)) return null;

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response(null, { status: 421, headers: { 'cache-control': 'no-store' } });
	}
	const location = `${canonical.origin}${url.pathname}${url.search}`;
	return new Response(null, {
		status: 301,
		headers: { location, 'cache-control': 'no-store' }
	});
}

/** Handle factory: redirects production `*.workers.dev` traffic to PUBLIC_ORIGIN. */
export function createCanonicalHostHandle(options: CanonicalHostOptions = {}): Handle {
	const originOf = options.publicOrigin ?? ((platform) => getServerEnv(platform).publicOrigin);
	return ({ event, resolve }) => {
		const platform = event.platform;
		if (options.building || !platform) return resolve(event);
		const response = canonicalHostResponse(event.request, originOf(platform));
		return response ?? resolve(event);
	};
}
