import {
	ApiError,
	apiErrorFrom,
	apiRateLimit,
	CACHE_IMMUTABLE,
	ifNoneMatch
} from '#lib/server/api/index.ts';
import { getServerEnv } from '#lib/server/env.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

const DUMP_FILE = /^(latest|\d{4}-\d{2}-\d{2})\.json\.gz$/;

function notFound(): Response {
	return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
}

export const GET: RequestHandler = async ({ request, params, platform, locals }) => {
	const file = params.file;
	// Compare the entire match too: JavaScript's `$` also accepts a final newline.
	if (DUMP_FILE.exec(file)?.[0] !== file) return notFound();

	const env = getServerEnv(platform);
	try {
		await apiRateLimit(env, { request, locals }, { group: 'dump', kind: 'read' });
	} catch (error) {
		if (!(error instanceof ApiError)) throw error;
		const response = apiErrorFrom(error);
		return request.method === 'HEAD' ? new Response(null, response) : response;
	}

	const key = `public/dump/${file}`;
	const object =
		request.method === 'HEAD'
			? await env.media
					.head(key)
					.then((metadata) => (metadata ? { httpEtag: metadata.httpEtag, body: null } : null))
			: await env.media.get(key);
	if (!object) return notFound();

	const headers = new Headers({
		'content-type': 'application/gzip',
		'content-disposition': `attachment; filename="open-auri-dump-${file}"`,
		etag: object.httpEtag,
		'cache-control': file === 'latest.json.gz' ? 'public, max-age=3600' : CACHE_IMMUTABLE
	});
	if (ifNoneMatch(request, object.httpEtag)) {
		await object.body?.cancel();
		return new Response(null, { status: 304, headers });
	}
	// R2 uses the Workers module's stream type; it is the same native stream at runtime.
	return new Response(object.body as ReadableStream<Uint8Array> | null, { headers });
};

export const HEAD: RequestHandler = GET;
