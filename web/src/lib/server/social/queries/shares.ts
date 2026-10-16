// Queries of the shares service (T4.5) that repo.ts does not have. Built with `sql()` and the
// predicates exported by repo.ts; the visibility rule itself is never rewritten here.
import type { D1Database } from '@cloudflare/workers-types';
import { first, sql } from '#lib/server/db.ts';
import { isSocialId, ownerNotBannedSql } from '#lib/server/social/repo.ts';

/**
 * True when `lineageId` is a retracted lineage that was linkable before the retraction (public or
 * unlisted, not moderated, owner not banned): the shared page answers 410 instead of 404. Private,
 * moderated or unknown lineages stay a plain 404, so their existence is never revealed.
 */
export async function isRetractedLinkable(db: D1Database, lineageId: string): Promise<boolean> {
	if (!isSocialId(lineageId)) return false;
	const row = await first<{ one: number }>(
		sql(
			db,
			"SELECT 1 AS one FROM lineages l WHERE l.id = ? AND l.status = 'retracted' " +
				"AND l.visibility IN ('public', 'unlisted') AND l.moderation = 'visible' " +
				`AND ${ownerNotBannedSql('l')}`,
			lineageId
		)
	);
	return Boolean(row);
}
