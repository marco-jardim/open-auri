// Fixtures of the rankings and feed tests (T4.6). Lineages are published through the repository
// (../repo/helpers.ts); excluded states are applied with direct UPDATEs afterwards, as moderation,
// retraction, re-gating or a ban would. Every id is unique, so the files can share the database.
import { env } from 'cloudflare:workers';
import type { ApiEvent } from '#lib/server/api/index.ts';
import { readRankings } from '#lib/server/social/rankings.ts';
import type { RankingEntry, RankingMetric, RankingWindow } from '#lib/server/social/types.ts';
import { randomIp, signedOut } from '../../api/helpers.ts';

export { ORIGIN } from '../../api/helpers.ts';
export { ban, publish, seedUser, type Published, type SeededUser } from '../repo/helpers.ts';

/** Every entry of a materialized ranking (all pages), best first. */
export async function rankedEntries(
	metric: RankingMetric,
	window: RankingWindow
): Promise<RankingEntry[]> {
	const seen: RankingEntry[] = [];
	let cursor: string | null = null;
	for (let guard = 0; guard < 50; guard += 1) {
		const page = await readRankings(env.DB, metric, window, { cursor, limit: 100 });
		seen.push(...page.items);
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}
	return seen;
}

/** The lineage ids of `entries` that belong to `mine`, in ranking order. */
export function only(entries: readonly RankingEntry[], mine: readonly string[]): string[] {
	return entries.map((entry) => entry.lineage.id).filter((id) => mine.includes(id));
}

export type Exclusion =
	| 'private'
	| 'unlisted'
	| 'hidden'
	| 'auto_hidden'
	| 'removed'
	| 'retracted'
	| 'gate_failed'
	| 'owner_banned';

export const EXCLUSIONS: readonly Exclusion[] = [
	'private',
	'unlisted',
	'hidden',
	'auto_hidden',
	'removed',
	'retracted',
	'gate_failed',
	'owner_banned'
];

/** Puts a published lineage in an excluded state (never listable). */
export async function exclude(
	kind: Exclusion,
	lineage: { lineageId: string; curveId: string; ownerUserId: string }
): Promise<void> {
	const update = (query: string, ...params: string[]) =>
		env.DB.prepare(query)
			.bind(...params)
			.run();
	switch (kind) {
		case 'private':
		case 'unlisted':
			await update('UPDATE lineages SET visibility = ? WHERE id = ?', kind, lineage.lineageId);
			return;
		case 'hidden':
		case 'auto_hidden':
		case 'removed':
			await update('UPDATE lineages SET moderation = ? WHERE id = ?', kind, lineage.lineageId);
			return;
		case 'retracted':
			await update("UPDATE lineages SET status = 'retracted' WHERE id = ?", lineage.lineageId);
			return;
		case 'gate_failed':
			await update('UPDATE curves SET gate_ok = 0 WHERE id = ?', lineage.curveId);
			return;
		case 'owner_banned':
			await update('UPDATE "user" SET "banned" = 1 WHERE "id" = ?', lineage.ownerUserId);
			return;
	}
}

/** A synthetic GET event for a /api/v1 route (signed out, random client IP). */
export function getEvent(
	routeId: string,
	path: string,
	headers: Record<string, string> = {}
): ApiEvent {
	return {
		request: new Request(`${env.PUBLIC_ORIGIN}${path}`, {
			method: 'GET',
			headers: { 'cf-connecting-ip': randomIp(), ...headers }
		}),
		locals: signedOut(),
		platform: { env },
		route: { id: routeId }
	};
}
