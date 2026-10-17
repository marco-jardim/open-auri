// S7 queries of the trades service (T4.10) that the repository does not have: the join target
// (ownership, public listing and gate verdict of a version), the pairing candidates (other users,
// other lineages, both lineages still tradeable, curves still approved, both users verified and
// not banned), the waiting trades the hourly job retries, the partners that stopped qualifying,
// and the partner facts shown after the reveal; plus the gate cache (`gate_ver`) of the curves a
// trade rests on, so the service re-gates stale verdicts before trusting them (FX4.9).
// Visibility comes from the predicates of repo.ts.
// The only write is `cancelPairWithUnavailablePartner` (one conditional UPDATE).
import type { D1Database } from '@cloudflare/workers-types';
import { all, first, run, sql } from '#lib/server/db.ts';
import { countedUserSql, linkableLineageSql, publicLineageSql } from '#lib/server/social/repo.ts';

/** Strict SQL alias (interpolated into SQL text). */
const ALIAS = /^[a-z][a-z0-9_]{0,15}$/;

/**
 * A lineage S7 may hand out in a trade of the user whose id is the SQL expression `userExpr`:
 * publicly listable, or that user's own lineage while active and not hidden by moderation. The
 * curve of the traded version must also have passed the gate (checked by each caller).
 * `userExpr` is internal SQL (a column such as `m.user_id`, or `?`), never user input.
 */
function tradeableLineageSql(lineageAlias: string, userExpr: string): string {
	if (!ALIAS.test(lineageAlias)) throw new Error(`Invalid SQL alias: ${lineageAlias}`);
	const l = lineageAlias;
	return (
		`(${publicLineageSql(l)} OR (${l}.owner_user_id IS NOT NULL AND ${l}.owner_user_id = ${userExpr} ` +
		`AND ${l}.status = 'active' AND ${l}.moderation = 'visible'))`
	);
}

/**
 * 1 when the partner trade `p` (aliases `pl` lineage, `pc` curve of its version, LEFT JOINed)
 * still qualifies to have its curve served, else 0 (never NULL).
 */
const PARTNER_OK_SQL = `CASE WHEN pl.id IS NOT NULL AND pc.gate_ok = 1 AND ${tradeableLineageSql('pl', 'p.user_id')} THEN 1 ELSE 0 END`;
const PARTNER_FROM_SQL =
	'FROM trades t JOIN trades p ON p.id = t.match_id ' +
	'LEFT JOIN lineages pl ON pl.id = p.lineage_id ' +
	'LEFT JOIN versions pv ON pv.id = p.version_id ' +
	'LEFT JOIN curves pc ON pc.id = pv.curve_id';

export interface TradeTarget {
	lineageId: string;
	versionId: string;
	/** The caller owns the lineage (any state). */
	own: boolean;
	/** Publicly listable (public, active, visible, head approved, owner not banned). */
	listable: boolean;
	/** S7 may trade it for the caller: listable, or own while active and visible. */
	tradeable: boolean;
	/** The curve of this version passed the gate (stored verdict). */
	gateOk: boolean;
	/**
	 * Gate cache of the curves the verdicts above rest on (this version's curve and the head's):
	 * the service re-gates a stale one and reads the target again (FX4.9).
	 */
	curves: CurveGateRef[];
}

/** A curve and the gate version its cached verdict was computed under. */
export interface CurveGateRef {
	curveId: string;
	gateVer: string;
}

/** A curve a trade's eligibility rests on (see `tradeCurveGates`). */
export interface TradeCurveGateRef extends CurveGateRef {
	tradeId: string;
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
		tradeable: number;
		gate_ok: number;
		curve_id: string;
		gate_ver: string;
		head_curve_id: string | null;
		head_gate_ver: string | null;
	}>(
		sql(
			db,
			'SELECT l.id AS lineage_id, v.id AS version_id, ' +
				'(l.owner_user_id IS NOT NULL AND l.owner_user_id = ?) AS own, ' +
				`(${publicLineageSql('l')}) AS listable, ` +
				`(${tradeableLineageSql('l', '?')}) AS tradeable, c.gate_ok AS gate_ok, ` +
				'c.id AS curve_id, c.gate_ver AS gate_ver, ' +
				'hc.id AS head_curve_id, hc.gate_ver AS head_gate_ver ' +
				'FROM lineages l JOIN versions v ON v.lineage_id = l.id AND v.id = COALESCE(?, l.head_version) ' +
				'JOIN curves c ON c.id = v.curve_id ' +
				'LEFT JOIN versions hv ON hv.id = l.head_version LEFT JOIN curves hc ON hc.id = hv.curve_id ' +
				'WHERE l.id = ?',
			userId,
			userId,
			versionId,
			lineageId
		)
	);
	if (!row) return null;
	const curves: CurveGateRef[] = [{ curveId: row.curve_id, gateVer: row.gate_ver }];
	if (row.head_curve_id !== null && row.head_gate_ver !== null) {
		curves.push({ curveId: row.head_curve_id, gateVer: row.head_gate_ver });
	}
	return {
		lineageId: row.lineage_id,
		versionId: row.version_id,
		own: row.own === 1,
		listable: row.listable === 1,
		tradeable: row.tradeable === 1,
		gateOk: row.gate_ok === 1,
		curves
	};
}

/**
 * Gate cache of the curves the eligibility of each trade in `tradeIds` rests on: the curve of its
 * traded version and the head curve of its lineage, with the trade each one belongs to. Unordered,
 * possibly with repeated curves. Internal use (no owner check): callers pass trade ids they
 * already scoped (the caller's own trades, their partners, or pairing candidates).
 */
export async function tradeCurveGates(
	db: D1Database,
	tradeIds: readonly string[]
): Promise<TradeCurveGateRef[]> {
	if (tradeIds.length === 0) return [];
	const ids = JSON.stringify([...tradeIds]);
	const where = 'x.id IN (SELECT value FROM json_each(?))';
	const rows = await all<{ trade_id: string; curve_id: string; gate_ver: string }>(
		sql(
			db,
			'SELECT x.id AS trade_id, c.id AS curve_id, c.gate_ver AS gate_ver FROM trades x ' +
				`JOIN versions v ON v.id = x.version_id JOIN curves c ON c.id = v.curve_id WHERE ${where} ` +
				'UNION ALL SELECT x.id AS trade_id, hc.id AS curve_id, hc.gate_ver AS gate_ver FROM trades x ' +
				'JOIN lineages l ON l.id = x.lineage_id JOIN versions hv ON hv.id = l.head_version ' +
				`JOIN curves hc ON hc.id = hv.curve_id WHERE ${where}`,
			ids,
			ids
		)
	);
	return rows.map((row) => ({
		tradeId: row.trade_id,
		curveId: row.curve_id,
		gateVer: row.gate_ver
	}));
}

/**
 * Oldest waiting trades that `tradeId` may pair with at `now`: another user, another lineage,
 * both lineages still tradeable for their trade's user (listable, or own while active and not
 * hidden by moderation), both curves still approved by the gate, both users verified and not
 * banned. Empty when `tradeId` itself is no longer waiting (or its user, lineage or curve no
 * longer qualifies).
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
				'JOIN lineages ml ON ml.id = m.lineage_id ' +
				'JOIN versions mv ON mv.id = m.version_id JOIN curves mc ON mc.id = mv.curve_id ' +
				"JOIN trades c ON c.status = 'waiting' AND c.expires_at > ? " +
				'AND c.user_id <> m.user_id AND c.lineage_id <> m.lineage_id ' +
				'JOIN "user" cu ON cu."id" = c.user_id ' +
				'JOIN lineages cl ON cl.id = c.lineage_id ' +
				'JOIN versions cv ON cv.id = c.version_id JOIN curves cc ON cc.id = cv.curve_id ' +
				"WHERE m.id = ? AND m.status = 'waiting' AND m.expires_at > ? " +
				`AND mc.gate_ok = 1 AND cc.gate_ok = 1 AND ${countedUserSql('mu')} AND ${countedUserSql('cu')} ` +
				`AND ${tradeableLineageSql('ml', 'm.user_id')} AND ${tradeableLineageSql('cl', 'c.user_id')} ` +
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

/**
 * The caller's MATCHED or REVEALED trades among `tradeIds` (owner-scoped by `userId`) whose
 * partner's curve may no longer be served: the partner's lineage is gone, no longer tradeable for
 * the partner (listable, or the partner's own while active and not hidden by moderation), or the
 * curve of its traded version no longer passes the gate.
 */
export async function unavailablePartnerTradeIds(
	db: D1Database,
	userId: string,
	tradeIds: readonly string[]
): Promise<Set<string>> {
	if (tradeIds.length === 0) return new Set();
	const rows = await all<{ id: string }>(
		sql(
			db,
			`SELECT t.id AS id ${PARTNER_FROM_SQL} ` +
				"WHERE t.user_id = ? AND t.status IN ('matched', 'revealed') " +
				`AND t.id IN (SELECT value FROM json_each(?)) AND ${PARTNER_OK_SQL} = 0`,
			userId,
			JSON.stringify([...tradeIds])
		)
	);
	return new Set(rows.map((row) => row.id));
}

/**
 * Cancels the caller's MATCHED trade `tradeId` and its partner's (the pair) while the partner's
 * curve still may not be served (same rule as `unavailablePartnerTradeIds`). Conditional, so a
 * pair revealed or expired meanwhile is left alone. Returns the rows cancelled (0 or 2).
 */
export async function cancelPairWithUnavailablePartner(
	db: D1Database,
	userId: string,
	tradeId: string
): Promise<number> {
	const meta = await run(
		sql(
			db,
			"UPDATE trades SET status = 'cancelled' WHERE status = 'matched' AND (id = ? OR match_id = ?) " +
				`AND EXISTS (SELECT 1 ${PARTNER_FROM_SQL} WHERE t.id = ? AND t.user_id = ? AND ${PARTNER_OK_SQL} = 0)`,
			tradeId,
			tradeId,
			tradeId,
			userId
		)
	);
	return meta.changes;
}

export interface RevealedPartnerFacts {
	/** Partner's nickname as displayed; null without one or when the partner is banned. */
	nickname: string | null;
	/** Partner's canonical nickname (the `/u/` link); null exactly when `nickname` is. */
	username: string | null;
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
		username: string | null;
		linkable: number;
		version_name: string | null;
	}>(
		sql(
			db,
			'SELECT t.id AS trade_id, ' +
				'CASE WHEN COALESCE(pu."banned", 0) = 0 AND pu."username" IS NOT NULL ' +
				'THEN COALESCE(pu."displayUsername", pu."username") END AS nickname, ' +
				'CASE WHEN COALESCE(pu."banned", 0) = 0 THEN pu."username" END AS username, ' +
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
			{
				nickname: row.nickname,
				username: row.username,
				linkable: row.linkable === 1,
				versionName: row.version_name
			}
		])
	);
}
