// Better Auth HTTP endpoints (`/api/auth/*`). The instance is the one hooks.server.ts built for
// this request (`locals.auth`), so there is exactly one handler: hooks.server.ts does not call
// `svelteKitHandler`. Responses still pass through the security-header and access-log hooks.
import type { RequestHandler } from './$types';

export const prerender = false;

const handle: RequestHandler = ({ locals, request }) => {
	if (!locals.auth) return new Response(null, { status: 503 });
	return locals.auth.handler(request);
};

export const GET = handle;
export const POST = handle;
