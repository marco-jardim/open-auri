// OG warm-up on publication (T4.7 hook, wired by T4.12): the curves routes pass
// `onPublished: (info) => scheduleOgWarm(event, info)` to the curves service, so the OG image of a
// new linkable version is rendered and stored in R2 in the background, after the response.
//
// Never blocks the response: `warmOg` hands everything to `platform.ctx.waitUntil` and logs its own
// errors (class name only). Without an execution context (never in production) nothing is
// scheduled: the image is still rendered on the first request to /og/<id>.png. Visibility is
// checked again inside `getOrCreateOg` (anonymous viewer), so a private version is never rendered
// even if a caller schedules it.
import { getServerEnv } from '#lib/server/env.ts';
import type { OgAssets } from './render.ts';
import { warmOg, type OgContext, type OgDeps, type OgEnv } from './store.ts';

export interface OgWarmEvent {
	platform?: { env: unknown; ctx?: OgContext } | undefined;
}

function isAssets(value: unknown): value is OgAssets {
	return (
		typeof value === 'object' && value !== null && typeof Reflect.get(value, 'fetch') === 'function'
	);
}

/** The ASSETS binding (OG fonts), as in ./route.ts. */
function assetsOf(env: unknown): OgAssets | null {
	if (typeof env !== 'object' || env === null) return null;
	const assets: unknown = Reflect.get(env, 'ASSETS');
	return isAssets(assets) ? assets : null;
}

/** Same construction as the /og/[id].png route (./route.ts). */
export function ogEnvOf(platform: OgWarmEvent['platform']): OgEnv {
	const env = getServerEnv(platform);
	return {
		db: env.db,
		media: env.media,
		publicOrigin: env.publicOrigin,
		assets: assetsOf(platform?.env)
	};
}

/**
 * Schedules the OG render of `info.versionId` through `event.platform.ctx.waitUntil`. Returns
 * whether a warm-up was scheduled (false without an execution context). Synchronous apart from
 * the background work; never throws for a failed render (logged by `warmOg`).
 */
export function scheduleOgWarm(
	event: OgWarmEvent,
	info: { versionId: string },
	deps: OgDeps = {}
): boolean {
	const ctx = event.platform?.ctx;
	if (!ctx) return false;
	warmOg(ogEnvOf(event.platform), ctx, info, deps);
	return true;
}
