import type { RequestHandler } from '@sveltejs/kit';
import { buildAndroidAppLinks } from '#lib/server/android/app-links.ts';
import { getServerEnv } from '#lib/server/env.ts';

export const prerender = false;

function respond(platform: App.Platform | undefined, head: boolean): Response {
	const env = getServerEnv(platform);
	const links = buildAndroidAppLinks(env.androidAppId, env.androidCertSha256);
	if (!links) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
	return new Response(head ? null : JSON.stringify(links), {
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=3600'
		}
	});
}

export const GET: RequestHandler = ({ platform }) => respond(platform, false);
export const HEAD: RequestHandler = ({ platform }) => respond(platform, true);
