// Queries of the packs service (T4.11) that repo.ts does not have. Visibility comes from the
// predicates exported by repo.ts (never rewritten here).
import type { D1Database } from '@cloudflare/workers-types';
import { all, sql } from '#lib/server/db.ts';
import { readableLineageSql } from '#lib/server/social/repo.ts';
import { LICENSES, PACK_ITEMS_MAX, isOneOf, type License } from '#lib/server/social/types.ts';

/**
 * License of the head version of each lineage in `lineageIds` that `ownerUserId` may put in a
 * pack (the same readability rule setPackItems applies). Lineages missing from the map are
 * unknown or unreadable for that user.
 */
export async function headLicensesForOwner(
	db: D1Database,
	ownerUserId: string,
	lineageIds: readonly string[]
): Promise<Map<string, License>> {
	const licenses = new Map<string, License>();
	if (lineageIds.length === 0 || lineageIds.length > PACK_ITEMS_MAX) return licenses;
	const readable = readableLineageSql('l', { userId: ownerUserId });
	const rows = await all<{ id: string; license: string }>(
		sql(
			db,
			'SELECT l.id AS id, v.license AS license FROM lineages l ' +
				'JOIN versions v ON v.id = l.head_version ' +
				`WHERE l.id IN (SELECT value FROM json_each(?)) AND ${readable.text}`,
			JSON.stringify(lineageIds),
			...readable.params
		)
	);
	for (const row of rows) {
		if (isOneOf(LICENSES, row.license)) licenses.set(row.id, row.license);
	}
	return licenses;
}
