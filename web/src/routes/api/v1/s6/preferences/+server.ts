// GET /api/v1/s6/preferences: the "Comunidade prefere" JSON (T4.9), written daily to R2 MEDIA by
// the s6-aggregate job. Public, CACHE_PUBLIC_60 with a strong ETag. Before the first run it answers
// 200 with an empty document of the same shape (`generatedAt: null`, no items, no pairs).
import { CACHE_PUBLIC_60, cached, defineApi } from '#lib/server/api/index.ts';
import {
	S6_CONSENT_VERSION,
	S6_PREFERENCES_KEY,
	type S6Preferences
} from '#lib/server/social/s6.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

const EMPTY: Omit<S6Preferences, 'generatedAt'> & { generatedAt: null } = {
	generatedAt: null,
	consentVersion: S6_CONSENT_VERSION,
	items: [],
	pairs: 0,
	converged: true
};

export const GET: RequestHandler = defineApi(
	{ auth: 'public', rateLimit: { group: 'api.s6.read' } },
	async ({ event, env }) => {
		const object = await env.media.get(S6_PREFERENCES_KEY);
		const body = object ? await object.text() : JSON.stringify(EMPTY);
		return cached(event.request, body, {
			cacheControl: CACHE_PUBLIC_60,
			contentType: 'application/json; charset=utf-8'
		});
	}
);
