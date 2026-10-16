// Signed-in acknowledgement of the current privacy policy and terms (PolicyBanner `onAccept`):
// JSON `{ "version": "YYYY-MM-DD" }`. Logic and checks in #lib/server/account/endpoints.ts.
import type { RequestHandler } from '@sveltejs/kit';
import { handlePolicyRequest } from '#lib/server/account/index.ts';
import { getServerEnv } from '#lib/server/env.ts';

export const prerender = false;

export const POST: RequestHandler = ({ locals, platform, request }) => {
	const env = getServerEnv(platform);
	return handlePolicyRequest({ request, locals, db: env.db, publicOrigin: env.publicOrigin });
};
