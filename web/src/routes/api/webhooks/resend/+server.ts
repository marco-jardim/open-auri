// Resend webhook endpoint (svix-signed). All logic lives in #lib/server/email/webhook.ts so it is
// tested without SvelteKit. Only POST is exported: SvelteKit answers 405 to other methods.
import type { RequestHandler } from '@sveltejs/kit';
import { respondToResendWebhook } from '#lib/server/email/webhook.ts';
import { getServerEnv } from '#lib/server/env.ts';

export const prerender = false;

export const POST: RequestHandler = ({ request, platform }) =>
	respondToResendWebhook(request, getServerEnv(platform));
