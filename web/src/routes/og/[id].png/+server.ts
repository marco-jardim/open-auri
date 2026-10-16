// Public OG image of a version: /og/<versionId>.png (T4.7). Logic in #lib/server/og/route.ts.
import { ogResponse } from '#lib/server/og/route.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const GET: RequestHandler = (event) => ogResponse(event);
