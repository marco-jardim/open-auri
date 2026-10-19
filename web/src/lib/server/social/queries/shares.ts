// Queries of the shares service (T4.5) that repo.ts does not have. Built with `sql()` and the
// predicates exported by repo.ts; the visibility rule itself is never rewritten here.
import type { D1Database } from '@cloudflare/workers-types';
import { first, sql } from '#lib/server/db.ts';
import { isLinkableTombstone } from '#lib/server/social/queries/curves.ts';
import { isSocialId } from '#lib/server/social/repo.ts';
import type { YoloPublication } from '#lib/server/social/types.ts';

/**
 * True when `lineageId` is a retracted lineage that was linkable before the retraction (public or
 * unlisted, not moderated, head curve passed the gate, owner not banned): the shared page answers
 * 410 instead of 404. Private, moderated, gate-failed or unknown lineages stay a plain 404, so
 * their existence is never revealed. Same rule as the curves service (`isLinkableTombstone`,
 * under the kill switch `yolo`, default 'off').
 */
export function isRetractedLinkable(
	db: D1Database,
	lineageId: string,
	yolo: YoloPublication = 'off'
): Promise<boolean> {
	return isLinkableTombstone(db, lineageId, yolo);
}

/** True when `userId` owns `lineageId` (any state): the lineage author. */
export async function isLineageOwner(
	db: D1Database,
	lineageId: string,
	userId: string
): Promise<boolean> {
	if (!isSocialId(lineageId)) return false;
	const row = await first<{ one: number }>(
		sql(db, 'SELECT 1 AS one FROM lineages WHERE id = ? AND owner_user_id = ?', lineageId, userId)
	);
	return Boolean(row);
}
