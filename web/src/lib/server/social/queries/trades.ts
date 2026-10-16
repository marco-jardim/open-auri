// S7 queries of the trades service (T4.10) that the repository does not have: the join target
// (ownership, public listing and gate verdict of a version), the pairing candidates (other users,
// other lineages, curve still approved, both users verified and not banned), the waiting trades
// the hourly job retries, and the partner facts shown after the reveal. Visibility comes from the
// predicates of repo.ts; nothing here writes.
import type { D1Database } from '@cloudflare/workers-types';
import { all, first, sql } from '#lib/server/db.ts';
import { countedUserSql, linkableLineageSql, publicLineageSql } from '#lib/server/social/repo.ts';

export interface TradeTarget {
	lineageId: string;
	versionId: string;
	/** The caller owns the lineage (any state). */
	own: boolean;
	/** Publicly listable (public, active, visible, head approved, owner not banned). */
	listable: boolean;
	/** The curve of this version passed the gate (stored verdict). */
	gateOk: boolean;
}

/** The version to trade (`versionId`, or the head when null) of `lineageId`, or null. */
export async function findTradeTarget(
	db: D1Database,
	userId: string,
	lineageId: string,
	versionId: string | null
): Promise<TradeTarget | null> {
	const row = await first<{
		lineage_id: string;
		version_id: string;
		own: number;
		listable: number;
		gate_ok: number;
	}>(
		sql(
			db,
			'SELECT l.id AS lineage_id, v.id AS version_id, ' +
				'(l.owner_user_id IS NOT NULL AND l.owner_user_id = ?) AS own, ' +
				`(${publicLineageSql('l')}) AS listable, c.gate_ok AS gate_ok ` +
				'FROM lineages l JOIN versions v ON v.lineage_id = l.id AND v.id = COALESCE(?, l.head_version) ' +
				'JOIN curves c ON c.id = v.curve_id WHERE l.id = ?',
			userId,
			versionId,
			lineageId
		)
	);
	if (!row) return null;
	return {
		lineageId: row.lineage_id,
		versionId: row.version_id,
		own: row.own === 1,
		listable: row.listable === 1,
		gateOk: row.gate_ok === 1
	};
}

/**
 * Oldest waiting trades that `tradeId` may pair with at `now`: another user, another lineage,
 * both curves still approved by the gate, both users verified and not banned. Empty when
 * `tradeId` itself is no longer waiting (or its user or curve no longer qualifies).
 */
export async function listPairCandidates(
	db: D1Database,
	tradeId: string,
	now: number,
	limit: number
): Promise<string[]> {
	const rows = await all<{ id: string }>(
		sql(
			db,
			'SELECT c.id AS id FROM trades m ' +
				'JOIN "user" mu ON mu."id" = m.user_id ' +
				'JOIN versions mv ON mv.id = m.version_id JOIN curves mc ON mc.id = mv.curve_id ' +
				"JOIN trades c ON c.status = 'waiting' AND c.expires_at > ? " +
				'AND c.user_id <> m.user_id AND c.lineage_id <> m.lineage_id ' +
				'JOIN "user" cu ON cu."id" = c.user_id ' +
				'JOIN versions cv ON cv.id = c.version_id JOIN curves cc ON cc.id = cv.curve_id ' +
				"WHERE m.id = ? AND m.status = 'waiting' AND m.expires_at > ? " +
				`AND mc.gate_ok = 1 AND cc.gate_ok = 1 AND ${countedUserSql('mu')} AND ${countedUserSql('cu')} ` +
				'ORDER BY c.created_at, c.id LIMIT ?',
			now,
			tradeId,
			now,
			limit
		)
	);
	return rows.map((row) => row.id);
}

/** Oldest unexpired waiting trades (ids only), for the job's pairing retry. */
export async function listWaitingTradeIds(
	db: D1Database,
	now: number,
	limit: number
): Promise<string[]> {
	const rows = await all<{ id: string }>(
		sql(
			db,
			"SELECT id FROM trades WHERE status = 'waiting' AND expires_at > ? ORDER BY created_at, id LIMIT ?",
			now,
			limit
		)
	);
	return rows.map((row) => row.id);
}

/** Current status and match of a trade (no owner check: internal use only). */
export async function readTradeState(
	db: D1Database,
	tradeId: string
): Promise<{ status: string; matchId: string | null } | null> {
	const row = await first<{ status: string; match_id: string | null }>(
		sql(db, 'SELECT status, match_id FROM trades WHERE id = ?', tradeId)
	);
	return row ? { status: row.status, matchId: row.match_id } : null;
}

export interface RevealedPartnerFacts {
	/** Partner's nickname; null without one or when the partner is banned. */
	nickname: string | null;
	/** The partner's lineage can be opened by id (public or unlisted, other public rules). */
	linkable: boolean;
	/** Name of the partner's traded version. */
	versionName: string | null;
}

/**
 * Partner facts of the caller's REVEALED trades among `tradeIds` (owner-scoped by `userId`, so a
 * trade id of someone else yields nothing).
 */
export async function revealedPartnerFacts(
	db: D1Database,
	userId: string,
	tradeIds: readonly string[]
): Promise<Map<string, RevealedPartnerFacts>> {
	if (tradeIds.length === 0) return new Map();
	const rows = await all<{
		trade_id: string;
		nickname: string | null;
		linkable: number;
		version_name: string | null;
	}>(
		sql(
			db,
			'SELECT t.id AS trade_id, ' +
				'CASE WHEN COALESCE(pu."banned", 0) = 0 THEN COALESCE(pu."displayUsername", pu."username") END AS nickname, ' +
				`CASE WHEN pl.id IS NOT NULL AND ${linkableLineageSql('pl')} THEN 1 ELSE 0 END AS linkable, ` +
				'pv.name AS version_name ' +
				'FROM trades t JOIN trades p ON p.id = t.match_id ' +
				'LEFT JOIN "user" pu ON pu."id" = p.user_id ' +
				'LEFT JOIN lineages pl ON pl.id = p.lineage_id ' +
				'LEFT JOIN versions pv ON pv.id = p.version_id ' +
				"WHERE t.user_id = ? AND t.status = 'revealed' AND t.id IN (SELECT value FROM json_each(?))",
			userId,
			JSON.stringify([...tradeIds])
		)
	);
	return new Map(
		rows.map((row) => [
			row.trade_id,
			{ nickname: row.nickname, linkable: row.linkable === 1, versionName: row.version_name }
		])
	);
}
