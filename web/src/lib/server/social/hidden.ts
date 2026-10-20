import type { D1Database } from '@cloudflare/workers-types';
import { ApiError } from '#lib/server/api/errors.ts';
import { all, run, sql } from '#lib/server/db.ts';
import { hiddenLabel, type HiddenList, type HiddenTarget } from '#lib/social/hidden.ts';

export interface HiddenItem extends HiddenTarget {
	createdAt: number;
	label: string | null;
}

/** Internal SQL expressions only. Check the lineage's author, not the trader offering it. */
export function tradePartnerVisibleSql(viewerExpr: string, lineageExpr: string): string {
	return (
		`NOT EXISTS (SELECT 1 FROM hidden_items hi WHERE hi.user_id = ${viewerExpr} AND (` +
		`(hi.target_type = 'curve' AND hi.target_id = ${lineageExpr}) OR ` +
		`(hi.target_type = 'author' AND hi.target_id IN (` +
		`SELECT u.public_author_id FROM lineages l JOIN "user" u ON u.id = l.owner_user_id WHERE l.id = ${lineageExpr}))))`
	);
}

export async function readHidden(db: D1Database, userId: string): Promise<{ items: HiddenItem[] }> {
	const items = await all<HiddenItem>(
		sql(
			db,
			'SELECT target_type AS targetType, target_id AS targetId, created_at AS createdAt, label ' +
				'FROM hidden_items WHERE user_id = ? ORDER BY created_at, target_type, target_id',
			userId
		)
	);
	return { items };
}

/** Additive, idempotent union. Never replaces another device's preferences. */
export async function putHidden(db: D1Database, userId: string, list: HiddenList, now: number) {
	const targets: HiddenTarget[] = [
		...list.authors.map((targetId) => ({ targetType: 'author' as const, targetId })),
		...list.curves.map((targetId) => ({ targetType: 'curve' as const, targetId }))
	];
	try {
		// JSON1 keeps a full 1000-target merge to one statement, well below D1's query and
		// bind-variable limits. The quota trigger aborts the whole statement atomically.
		await run(
			sql(
				db,
				'INSERT INTO hidden_items (user_id, target_type, target_id, created_at, label) ' +
					"SELECT ?1, json_extract(value, '$.targetType'), json_extract(value, '$.targetId'), ?2, json_extract(value, '$.label') " +
					'FROM json_each(?3) WHERE true ' +
					'ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET label = COALESCE(excluded.label, hidden_items.label)',
				userId,
				now,
				JSON.stringify(
					targets.map((target) => ({
						...target,
						label: hiddenLabel(list, target.targetType, target.targetId)
					}))
				)
			)
		);
	} catch (error) {
		if (error instanceof Error && error.message.includes('hidden_items_limit')) {
			throw new ApiError(409, 'QUOTA_EXCEEDED');
		}
		throw error;
	}
	return readHidden(db, userId);
}

export async function deleteHidden(db: D1Database, userId: string, target: HiddenTarget) {
	await run(
		sql(
			db,
			'DELETE FROM hidden_items WHERE user_id = ? AND target_type = ? AND target_id = ?',
			userId,
			target.targetType,
			target.targetId
		)
	);
	return readHidden(db, userId);
}
