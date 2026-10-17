// OG images in R2 (T4.7): `og/<curveId>-<versionId>.png` (./keys.ts). The bytes of a key never
// change for a given card layout (versions are append-only, curves content-addressed, and the card
// carries no author: FX4.3). Visibility is always checked first, through the repository
// (`getVersionForViewer` with the anonymous viewer = linkable lineage, gate_ok = 1), so a private,
// hidden, retracted or gate-rejected version is never rendered nor served, even when its PNG is
// still in R2 (the jobs Worker's `og-sweep` deletes such objects). A stored object of another card
// layout (`customMetadata.card`) is treated as a miss and overwritten. Concurrency: two
// simultaneous misses render twice at most and write the same bytes (the SVG and the renderer are
// deterministic), so the last write wins harmlessly.
import { strongEtag } from '#lib/server/api/cache.ts';
import type { ServerEnv } from '#lib/server/env.ts';
import { getVersionForViewer } from '#lib/server/social/repo.ts';
import { ANONYMOUS_VIEWER } from '#lib/server/social/types.ts';
import { isCurrentCard, OG_CARD_VERSION, ogKey } from './keys.ts';
import { loadOgFonts, renderPng, toArrayBuffer, type OgAssets } from './render.ts';
import { ogSvg } from './svg.ts';

export { ogKey } from './keys.ts';

export const OG_CONTENT_TYPE = 'image/png';
/**
 * One day, public (FX4.3): visibility is checked on every request, so a version that turns
 * private stops being served at once; this bounds how long browsers and CDNs keep their copy.
 * Revalidation is cheap (strong ETag, 304).
 */
export const OG_CACHE_CONTROL = 'public, max-age=86400';
/** Version ids accepted before touching D1 (anything else is a 404 without a query). */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface OgEnv {
	db: ServerEnv['db'];
	media: Pick<ServerEnv['media'], 'get' | 'put'>;
	publicOrigin: string;
	/** ASSETS binding (fonts); only needed by the default renderer. */
	assets: OgAssets | null;
}

export interface OgContext {
	waitUntil(promise: Promise<unknown>): void;
}

export interface OgDeps {
	/** SVG → PNG. Default: {@link renderPng} with the fonts of web/static/og-font/. */
	render?: (svg: string) => Promise<Uint8Array>;
	/** Runs before a render (cache miss only), e.g. the per-IP rate limit. May throw. */
	beforeRender?: () => Promise<void>;
}

export type OgResult =
	| { ok: true; key: string; body: ArrayBuffer; etag: string; source: 'r2' | 'render' }
	| { ok: false; code: 'not-found' };

export function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

function defaultRender(env: OgEnv): (svg: string) => Promise<Uint8Array> {
	return async (svg) => {
		if (env.assets === null) throw new Error('og: ASSETS binding missing');
		return renderPng(svg, await loadOgFonts(env.assets, env.publicOrigin));
	};
}

/**
 * The OG PNG of a linkable version: from R2 when present, else rendered and written to R2 (the
 * write is handed to `ctx.waitUntil`). `not-found` for unknown, private or otherwise unlinkable ids.
 */
export async function getOrCreateOg(
	env: OgEnv,
	ctx: OgContext,
	versionId: string,
	deps: OgDeps = {}
): Promise<OgResult> {
	if (!ID_PATTERN.test(versionId)) return { ok: false, code: 'not-found' };
	const view = await getVersionForViewer(env.db, versionId, ANONYMOUS_VIEWER);
	if (!view) return { ok: false, code: 'not-found' };
	const key = ogKey(view.curve.id, view.version.id);

	const stored = await env.media.get(key);
	if (stored && isCurrentCard(stored.customMetadata)) {
		const body = await stored.arrayBuffer();
		const etag = stored.customMetadata?.etag ?? (await strongEtag(body));
		return { ok: true, key, body, etag, source: 'r2' };
	}
	// An object of an older card layout (e.g. one that still showed the author) is never served.
	if (stored) await stored.body.cancel();

	await deps.beforeRender?.();
	const svg = ogSvg({
		name: view.version.name,
		license: view.version.license,
		s1: view.curve.s1,
		lang: view.version.lang
	});
	const body = toArrayBuffer(await (deps.render ?? defaultRender(env))(svg));
	const etag = await strongEtag(body);
	ctx.waitUntil(
		env.media
			.put(key, body, {
				httpMetadata: { contentType: OG_CONTENT_TYPE, cacheControl: OG_CACHE_CONTROL },
				customMetadata: { etag, card: OG_CARD_VERSION }
			})
			.then(
				() => undefined,
				(error: unknown) => {
					console.error(JSON.stringify({ event: 'og.put.error', error: errorName(error) }));
				}
			)
	);
	return { ok: true, key, body, etag, source: 'render' };
}

/** Publication hook: renders and stores the OG image in the background (errors are logged). */
export function warmOg(
	env: OgEnv,
	ctx: OgContext,
	info: { versionId: string },
	deps: OgDeps = {}
): void {
	ctx.waitUntil(
		getOrCreateOg(env, ctx, info.versionId, deps).then(
			() => undefined,
			(error: unknown) => {
				console.error(JSON.stringify({ event: 'og.warm.error', error: errorName(error) }));
			}
		)
	);
}
