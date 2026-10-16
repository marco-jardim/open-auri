// Dev-only mailbox of the local e2e suite (EMAIL_TRANSPORT=capture). Answers 404 everywhere else:
// getServerEnv refuses capture on a non-local PUBLIC_ORIGIN and the handler re-checks the transport,
// the origin and the request host. Logic in #lib/server/email/capture.ts (tested in workerd).
import type { RequestHandler } from '@sveltejs/kit';
import { respondToMailboxRequest } from '#lib/server/email/capture.ts';
import { getServerEnv } from '#lib/server/env.ts';

export const prerender = false;

export const GET: RequestHandler = ({ request, platform }) =>
	respondToMailboxRequest(request, getServerEnv(platform));
