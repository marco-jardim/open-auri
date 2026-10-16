// Extra reads of the curves service (T4.2). Built only from the predicates exported by repo.ts.
import type { D1Database } from '@cloudflare/workers-types';
import { first, sql } from '#lib/server/db.ts';
import { headGateOkSql, isSocialId, ownerNotBannedSql } from '#lib/server/social/repo.ts';

/**
 * True when `lineageId` is a tombstone that anyone with the id could have opened before the
 * retraction: status 'retracted' and every other rule of linkableLineageSql (public or unlisted,
 * not moderated, head curve passed the gate, owner not banned). Private, moderated or unknown
 * lineages are not tombstones (they stay a plain 404, so their existence never leaks).
 */
export async function isLinkableTombstone(db: D1Database, lineageId: string): Promise<boolean> {
	if (!isSocialId(lineageId)) return false;
	const row = await first<{ id: string }>(
		sql(
			db,
			"SELECT l.id AS id FROM lineages l WHERE l.id = ? AND l.status = 'retracted' " +
				"AND l.visibility IN ('public', 'unlisted') AND l.moderation = 'visible' " +
				`AND ${headGateOkSql('l')} AND ${ownerNotBannedSql('l')}`,
			lineageId
		)
	);
	return Boolean(row);
}
