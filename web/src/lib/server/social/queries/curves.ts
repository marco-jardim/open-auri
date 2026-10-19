// Extra reads of the curves service (T4.2). Built only from the predicates exported by repo.ts.
import type { D1Database } from '@cloudflare/workers-types';
import { all, first, sql } from '#lib/server/db.ts';
import {
	gateImplSql,
	headPublishableSql,
	isSocialId,
	linkableLineageSql,
	ownerNotBannedSql
} from '#lib/server/social/repo.ts';
import type { CurveRecord, YoloPublication } from '#lib/server/social/types.ts';

interface StaleCurveRow {
	id: string;
	s1: string;
	canon_key: string;
	gate_ver: string;
	gate_ok: number;
	gate_yolo: number;
	gate_reasons: string;
	level_db: number | null;
	created_at: number;
}

function reasonsOf(text: string): string[] {
	try {
		const value: unknown = JSON.parse(text);
		return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
	} catch {
		// A malformed cache row has no usable reasons; the re-gate rewrites them.
		return [];
	}
}

/**
 * Curves whose cached verdict comes from another gate version and from a GATE_IMPL ordinal not
 * greater than `gateImpl` (rows of a newer implementation are current for a newer isolate), heads
 * of linkable lineages first (the predicate of repo.ts), then oldest first. At most 1000.
 */
export async function listStaleCurvesByPriority(
	db: D1Database,
	gateVer: string,
	limit: number,
	gateImpl: number
): Promise<CurveRecord[]> {
	const rows = await all<StaleCurveRow>(
		sql(
			db,
			'SELECT c.id AS id, c.s1 AS s1, c.canon_key AS canon_key, c.gate_ver AS gate_ver, ' +
				'c.gate_ok AS gate_ok, c.gate_yolo AS gate_yolo, c.gate_reasons AS gate_reasons, ' +
				'c.level_db AS level_db, ' +
				'c.created_at AS created_at FROM curves c ' +
				`WHERE c.gate_ver <> ? AND ${gateImplSql('c.gate_ver')} <= ? ` +
				'ORDER BY CASE WHEN EXISTS (SELECT 1 FROM lineages pl JOIN versions pv ' +
				'ON pv.id = pl.head_version WHERE pv.curve_id = c.id AND ' +
				// Acknowledged YOLO heads whatever the kill switch (served again once it is on).
				`${linkableLineageSql('pl', 'on')}) THEN 0 ELSE 1 END, c.created_at, c.id LIMIT ?`,
			gateVer,
			gateImpl,
			Math.min(Math.max(Math.trunc(limit), 1), 1000)
		)
	);
	return rows.map((row) => ({
		id: row.id,
		s1: row.s1,
		canonKey: row.canon_key,
		gateVer: row.gate_ver,
		gateOk: row.gate_ok === 1,
		gateYolo: row.gate_yolo === 1,
		gateReasons: reasonsOf(row.gate_reasons),
		levelDb: row.level_db,
		createdAt: row.created_at
	}));
}

/**
 * True when `lineageId` is a tombstone that anyone with the id could have opened before the
 * retraction: status 'retracted' and every other rule of linkableLineageSql (public or unlisted,
 * not moderated, publishable head under the kill switch `yolo`: standard, or, while 'on', YOLO
 * acknowledged by the owner; owner not banned). Private, moderated or unknown lineages are not
 * tombstones (they stay a plain 404, so their existence never leaks), nor, while the switch is
 * 'off' (the default), one whose head is YOLO.
 */
export async function isLinkableTombstone(
	db: D1Database,
	lineageId: string,
	yolo: YoloPublication = 'off'
): Promise<boolean> {
	if (!isSocialId(lineageId)) return false;
	const row = await first<{ id: string }>(
		sql(
			db,
			"SELECT l.id AS id FROM lineages l WHERE l.id = ? AND l.status = 'retracted' " +
				"AND l.visibility IN ('public', 'unlisted') AND l.moderation = 'visible' " +
				`AND ${headPublishableSql('l', yolo)} AND ${ownerNotBannedSql('l')}`,
			lineageId
		)
	);
	return Boolean(row);
}
