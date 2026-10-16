// LGPD data export: POST from the /conta form, answered with the JSON as an attachment. POST only
// (SvelteKit answers 405 to anything else). Logic and checks in #lib/server/account/endpoints.ts.
import type { RequestHandler } from '@sveltejs/kit';
import { handleExportRequest } from '#lib/server/account/index.ts';
import { getServerEnv } from '#lib/server/env.ts';

export const prerender = false;

export const POST: RequestHandler = ({ locals, platform, request }) => {
	const env = getServerEnv(platform);
	return handleExportRequest({ request, locals, db: env.db, publicOrigin: env.publicOrigin });
};
