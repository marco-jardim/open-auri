// Dev-only job trigger of the local e2e suite: the web Worker has no cron, so Playwright asks for
// one run of a scheduled job of the jobs Worker (`rankings`, `s6-aggregate`, `trades-expire`,
// `regate`), executed here with the same web modules the jobs Worker imports.
//
// Same guard as the dev mailbox (#lib/server/email/capture.ts), all three must hold:
//   1. getServerEnv refuses EMAIL_TRANSPORT=capture unless PUBLIC_ORIGIN is localhost/127.0.0.1;
//   2. the handler re-checks the transport (`capture`) and the origin (loopback);
//   3. the request itself was made to a loopback host.
// Anything else answers an empty 404 for every method (indistinguishable from a missing route), and
// so does an unknown job name. Always the current time: a run "in the future" would make every
// later real run of the rankings look stale (the repository ignores older runs).
// Logs carry the job name and counts only.
import { getServerEnv, isLocalOrigin, type ServerEnv } from '#lib/server/env.ts';
import { regateStale } from '#lib/server/social/gate.ts';
import { runRankingsJob } from '#lib/server/social/rankings.ts';
import { aggregate, S6_PREFERENCES_KEY } from '#lib/server/social/s6.ts';
import { runTradeMaintenance } from '#lib/server/social/trades.ts';
import type { RequestHandler } from './$types';

// Same values as the jobs Worker (workers/jobs/src/jobs/regate.ts, s6-aggregate.ts). The web
// build must not import Worker modules: their ambient types are not part of this program.
const REGATE_LIMIT = 200;
const S6_CACHE_CONTROL = 'public, max-age=300';

export const prerender = false;

const NO_STORE = { 'cache-control': 'no-store' };

type JobEnv = Pick<ServerEnv, 'db' | 'media'>;

const JOBS: Readonly<Record<string, (env: JobEnv, now: number) => Promise<unknown>>> = {
	rankings: async (env, now) => {
		const summary = await runRankingsJob(env.db, now);
		return {
			computedAt: summary.computedAt,
			applied: summary.applied,
			skipped: summary.skipped,
			rows: summary.rows,
			failed: summary.failed
		};
	},
	's6-aggregate': async (env, now) => {
		const preferences = await aggregate(env.db, new Date(now));
		const body = JSON.stringify(preferences);
		await env.media.put(S6_PREFERENCES_KEY, body, {
			httpMetadata: { contentType: 'application/json', cacheControl: S6_CACHE_CONTROL }
		});
		return { pairs: preferences.pairs, items: preferences.items.length };
	},
	'trades-expire': (env, now) => runTradeMaintenance(env.db, now),
	regate: (env, now) => regateStale(env.db, REGATE_LIMIT, now)
};

function isLoopbackRequest(request: Request): boolean {
	try {
		return isLocalOrigin(new URL(request.url).origin);
	} catch {
		return false;
	}
}

function notFound(): Response {
	return new Response(null, { status: 404, headers: NO_STORE });
}

interface DevJobEvent {
	request: Request;
	params: { name?: string };
	platform?: { readonly env?: unknown } | undefined;
}

async function respond(event: DevJobEvent): Promise<Response> {
	const env = getServerEnv(event.platform);
	if (
		env.emailTransport !== 'capture' ||
		!isLocalOrigin(env.publicOrigin) ||
		!isLoopbackRequest(event.request)
	) {
		return notFound();
	}
	const name = event.params.name ?? '';
	const job = Object.hasOwn(JOBS, name) ? JOBS[name] : undefined;
	if (!job) return notFound();
	if (event.request.method !== 'POST') {
		return new Response(null, { status: 405, headers: { ...NO_STORE, allow: 'POST' } });
	}
	const result = await job(env, Date.now());
	console.log(JSON.stringify({ event: 'dev.job', job: name }));
	return Response.json({ job: name, result }, { headers: NO_STORE });
}

export const POST: RequestHandler = (event) => respond(event);

/** Every other method: the same 404 outside a local capture env, 405 inside it. */
export const fallback: RequestHandler = (event) => respond(event);
