// Queries of the personal library service (T4.3) that repo.ts does not have. All are
// owner-scoped (the caller's own rows in any state, like listOwnLineages): the user id must come
// from the session. No visibility rule is involved, so no predicate of repo.ts is needed.
import type { D1Database } from '@cloudflare/workers-types';
import { all, first, run, sql } from '#lib/server/db.ts';
import { LOOKUP_IDS_MAX, SocialRepoError } from '#lib/server/social/types.ts';

/** Lineages owned by the user created at or after `since` (epoch ms), any state. */
export async function countOwnLineagesSince(
	db: D1Database,
	ownerUserId: string,
	since: number
): Promise<number> {
	const row = await first<{ n: number }>(
		sql(
			db,
			'SELECT count(*) AS n FROM lineages WHERE owner_user_id = ? AND created_at >= ?',
			ownerUserId,
			since
		)
	);
	return row?.n ?? 0;
}

/**
 * Deletes the user's attributed `favorited` share events on every share of `lineageId` (run on
 * unfavorite, FX4.6). Owner-scoped like the rest: the user id comes from the session. Returns the
 * number of rows deleted.
 */
export async function deleteFavoritedShareEvents(
	db: D1Database,
	userId: string,
	lineageId: string
): Promise<number> {
	const meta = await run(
		sql(
			db,
			"DELETE FROM share_event_users WHERE user_id = ? AND kind = 'favorited' " +
				'AND share_id IN (SELECT id FROM shares WHERE lineage_id = ?)',
			userId,
			lineageId
		)
	);
	return meta.changes;
}

/** Head version name of each of the owner's lineages among `lineageIds` (others are absent). */
export async function ownHeadNames(
	db: D1Database,
	ownerUserId: string,
	lineageIds: readonly string[]
): Promise<Map<string, string>> {
	if (lineageIds.length > LOOKUP_IDS_MAX) throw new SocialRepoError('limit');
	const names = new Map<string, string>();
	if (lineageIds.length === 0) return names;
	const rows = await all<{ id: string; name: string }>(
		sql(
			db,
			'SELECT l.id AS id, v.name AS name FROM lineages l JOIN versions v ON v.id = l.head_version ' +
				'WHERE l.owner_user_id = ? AND l.id IN (SELECT value FROM json_each(?))',
			ownerUserId,
			JSON.stringify(lineageIds)
		)
	);
	for (const row of rows) names.set(row.id, row.name);
	return names;
}
