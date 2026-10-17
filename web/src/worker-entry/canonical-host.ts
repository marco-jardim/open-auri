// Worker entry wrapper (#33, T5.4b). `npm run build` runs web/scripts/wrap-worker.mjs after
// `vite build`: it moves the adapter's `.svelte-kit/cloudflare/_worker.js` (the wrangler `main`)
// to `_sveltekit.js` and writes a `_worker.js` that exports `withCanonicalHost(<its handler>)`.
//
// Why: @sveltejs/adapter-cloudflare's worker serves prerendered pages and static files straight
// from ASSETS (files/worker.js, before `server.respond`), so hooks.server.ts, and with it the
// canonical-host step, never sees them, even when the Worker runs first. In production,
// `assets.run_worker_first` (web/wrangler.template.jsonc, `/*` except `/_app/*`) sends those
// requests here, so a prerendered page on the `*.workers.dev` host gets the same 301 (GET/HEAD)
// or 421 (other methods) as a dynamic route.
//
// One decision: `canonicalHostResponse` of src/lib/server/security/canonical-host.ts, the function
// the hook calls, on the same input: the PUBLIC_ORIGIN var, which getServerEnv validates and passes
// on unchanged. No PUBLIC_ORIGIN (or not a string) passes through, as do a loopback or
// `*.workers.dev` origin (local dev, preview, e2e, staging) and the canonical host itself. The hook
// stays: it covers every environment and path the wrapper does not run for.
import { canonicalHostResponse } from '../lib/server/security/canonical-host.ts';

/** The handler object a module Worker exports by default; only `fetch` is wrapped. */
export interface WorkerHandler {
	fetch?(request: Request, env: unknown, ctx: unknown): Response | Promise<Response>;
}

/** PUBLIC_ORIGIN of the Worker env, or '' when it is not configured. */
export function publicOriginOf(env: unknown): string {
	if (typeof env !== 'object' || env === null || !('PUBLIC_ORIGIN' in env)) return '';
	const value = env.PUBLIC_ORIGIN;
	return typeof value === 'string' ? value : '';
}

/**
 * `handler` with a `fetch` that answers the canonical-host response first and otherwise delegates
 * to the original `fetch` (same request, env and context). Every other property of the handler
 * (`scheduled`, `queue`...) is kept as is; a handler without `fetch` is returned unchanged.
 */
export function withCanonicalHost<H extends WorkerHandler>(handler: H): H {
	const inner = handler.fetch;
	if (inner === undefined) return handler;
	const wrapped: WorkerHandler = {
		fetch(request, env, ctx) {
			const origin = publicOriginOf(env);
			const response = origin ? canonicalHostResponse(request, origin) : null;
			return response ?? inner.call(handler, request, env, ctx);
		}
	};
	return { ...handler, ...wrapped };
}
