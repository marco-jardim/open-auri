// Queries of the S6 service (FX4.7) that repo.ts does not have. Read-only. Visibility comes from
// the predicates exported by repo.ts (never rewritten here).
import type { D1Database } from '@cloudflare/workers-types';
import { all, first, sql } from '#lib/server/db.ts';
import { publicLineageSql } from '#lib/server/social/repo.ts';
import { S6_CHOICES, isOneOf, type S6Choice } from '#lib/server/social/types.ts';

/** Ids per `json_each` lookup (one bound parameter, so this only bounds the work per statement). */
export const S6_LOOKUP_CHUNK = 500;

/**
 * The ids in `ids` that are the curve of the HEAD version of a publicly LISTABLE lineage. Curves
 * of older versions (FX4.9), and of unlisted, private, retracted, hidden or banned-owner lineages,
 * are never returned.
 */
export async function listableCurveIds(
	db: D1Database,
	ids: readonly string[]
): Promise<Set<string>> {
	const found = new Set<string>();
	const unique = [...new Set(ids)];
	for (let start = 0; start < unique.length; start += S6_LOOKUP_CHUNK) {
		const chunk = unique.slice(start, start + S6_LOOKUP_CHUNK);
		const rows = await all<{ id: string }>(
			sql(
				db,
				'SELECT DISTINCT v.curve_id AS id FROM lineages l JOIN versions v ON v.id = l.head_version ' +
					`WHERE v.curve_id IN (SELECT value FROM json_each(?)) AND ${publicLineageSql('l')}`,
				JSON.stringify(chunk)
			)
		);
		for (const row of rows) found.add(row.id);
	}
	return found;
}

export interface S6WindowPair {
	id: number;
	a: string;
	b: string;
	choice: S6Choice;
}

/**
 * Smallest pair id of the batches stored on or after `fromDay` (uses the `s6_batches_day` and
 * `s6_pairs_batch` indexes), or null when there is none. Bounds the descending scan below.
 */
export async function s6WindowStartId(db: D1Database, fromDay: string): Promise<number | null> {
	const row = await first<{ id: number | null }>(
		sql(
			db,
			'SELECT MIN(p.id) AS id FROM s6_batches b JOIN s6_pairs p ON p.batch_id = b.id ' +
				'WHERE b.day >= ?',
			fromDay
		)
	);
	return typeof row?.id === 'number' ? row.id : null;
}

export interface S6WindowPage {
	pairs: S6WindowPair[];
	/** Rows read (before dropping an invalid choice) and the smallest id read, for the keyset. */
	rows: number;
	lastId: number | null;
}

/**
 * One page of the pairs of batches stored on or after `fromDay`, newest first (descending id,
 * keyset on `beforeId`), never below `minId`. The day is filtered, never returned.
 */
export async function listS6WindowPairs(
	db: D1Database,
	options: { fromDay: string; minId: number; beforeId: number; limit: number }
): Promise<S6WindowPage> {
	const limit = Math.min(Math.max(Math.trunc(options.limit), 1), 5000);
	const rows = await all<{ id: number; a: string; b: string; choice: string }>(
		sql(
			db,
			'SELECT p.id AS id, p.a AS a, p.b AS b, p.choice AS choice FROM s6_pairs p ' +
				'JOIN s6_batches b ON b.id = p.batch_id ' +
				'WHERE p.id >= ? AND p.id < ? AND b.day >= ? ORDER BY p.id DESC LIMIT ?',
			options.minId,
			options.beforeId,
			options.fromDay,
			limit
		)
	);
	const pairs: S6WindowPair[] = [];
	for (const row of rows) {
		if (isOneOf(S6_CHOICES, row.choice)) {
			pairs.push({ id: row.id, a: row.a, b: row.b, choice: row.choice });
		}
	}
	const last = rows[rows.length - 1];
	return { pairs, rows: rows.length, lastId: last ? last.id : null };
}
