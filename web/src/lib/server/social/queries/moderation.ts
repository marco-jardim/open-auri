// Queries of the moderation service (T4.8) that repo.ts does not have: report targets as seen by a
// viewer (built on the exported visibility predicates, never rewriting them) and the admin queue
// preview (reason counts, notes, target facts). Only admin code reads notes and reporter-free
// aggregates; nothing here returns a reporter id.
import type { D1Database } from '@cloudflare/workers-types';
import { resolveNickname } from '#lib/server/account/nickname.ts';
import { all, first, sql } from '#lib/server/db.ts';
import { readableLineageSql, readablePackSql } from '#lib/server/social/repo.ts';
import type {
	ModerationState,
	ReportReason,
	ReportTargetKind,
	Viewer
} from '#lib/server/social/types.ts';

/** What the moderation rules need to know about a report target. */
export interface TargetFacts {
	kind: ReportTargetKind;
	id: string;
	/** Author of a lineage or pack (null when anonymized); the user itself for user targets. */
	ownerUserId: string | null;
	/** Moderation state of a lineage or pack; null for users. */
	moderation: ModerationState | null;
}

/**
 * The target if `viewer` can read it (lineage and pack: the repo predicates; user: a profile with
 * a nickname whose account is not banned), else null. User targets are resolved by nickname;
 * only explicit admin callers may pass internal user ids.
 */
export async function findTarget(
	db: D1Database,
	kind: ReportTargetKind,
	id: string,
	viewer: Viewer,
	now: number = Date.now()
): Promise<TargetFacts | null> {
	if (kind === 'lineage') {
		const readable = readableLineageSql('l', viewer);
		const row = await first<{ id: string; owner_user_id: string | null; moderation: string }>(
			sql(
				db,
				`SELECT l.id, l.owner_user_id, l.moderation FROM lineages l WHERE l.id = ? AND ${readable.text}`,
				id,
				...readable.params
			)
		);
		return row
			? {
					kind,
					id: row.id,
					ownerUserId: row.owner_user_id,
					moderation: row.moderation as ModerationState
				}
			: null;
	}
	if (kind === 'pack') {
		const readable = readablePackSql('p', viewer);
		const row = await first<{ id: string; owner_user_id: string | null; moderation: string }>(
			sql(
				db,
				`SELECT p.id, p.owner_user_id, p.moderation FROM packs p WHERE p.id = ? AND ${readable.text}`,
				id,
				...readable.params
			)
		);
		return row
			? {
					kind,
					id: row.id,
					ownerUserId: row.owner_user_id,
					moderation: row.moderation as ModerationState
				}
			: null;
	}
	let userId = id;
	if (viewer.admin !== true) {
		let nickname = await resolveNickname(db, id, now);
		if (nickname?.kind === 'redirect') nickname = await resolveNickname(db, nickname.to, now);
		if (nickname?.kind !== 'user') return null;
		userId = nickname.userId;
	}
	const visible =
		viewer.admin === true ? '1 = 1' : `u."username" IS NOT NULL AND COALESCE(u."banned", 0) = 0`;
	const row = await first<{ id: string }>(
		sql(db, `SELECT u."id" AS id FROM "user" u WHERE u."id" = ? AND ${visible}`, userId)
	);
	return row ? { kind, id: row.id, ownerUserId: row.id, moderation: null } : null;
}

export interface OpenReportSummary {
	reasons: { reason: ReportReason; count: number }[];
	/** Most recent non-empty notes of open reports (admin eyes only). */
	notes: { note: string; reason: ReportReason; at: number }[];
}

export const QUEUE_NOTES_MAX = 5;

/** Reason counts and the latest notes of the open reports on one target. */
export async function openReportSummary(
	db: D1Database,
	kind: ReportTargetKind,
	id: string
): Promise<OpenReportSummary> {
	const [reasons, notes] = await Promise.all([
		all<{ reason: string; n: number }>(
			sql(
				db,
				'SELECT reason, count(*) AS n FROM reports WHERE target_kind = ? AND target_id = ? ' +
					'AND resolution IS NULL GROUP BY reason ORDER BY n DESC, reason',
				kind,
				id
			)
		),
		all<{ note: string; reason: string; created_at: number }>(
			sql(
				db,
				'SELECT note, reason, created_at FROM reports WHERE target_kind = ? AND target_id = ? ' +
					"AND resolution IS NULL AND note IS NOT NULL AND note <> '' " +
					'ORDER BY created_at DESC, id DESC LIMIT ?',
				kind,
				id,
				QUEUE_NOTES_MAX
			)
		)
	]);
	return {
		reasons: reasons.map((row) => ({ reason: row.reason as ReportReason, count: row.n })),
		notes: notes.map((row) => ({
			note: row.note,
			reason: row.reason as ReportReason,
			at: row.created_at
		}))
	};
}

/** Admin preview of a target: what it is, its state and its author. */
export interface TargetPreview {
	kind: ReportTargetKind;
	id: string;
	/** Lineage head name, pack name, or the user's nickname. */
	name: string | null;
	visibility: string | null;
	status: string | null;
	moderation: ModerationState | null;
	curated: boolean;
	author: { id: string; nickname: string | null; banned: boolean; admin: boolean } | null;
}

interface PreviewRow {
	id: string;
	name: string | null;
	visibility: string | null;
	status: string | null;
	moderation: string | null;
	curated: number | null;
	owner_id: string | null;
	owner_username: string | null;
	owner_display: string | null;
	owner_banned: number | null;
	owner_role: string | null;
}

const OWNER_COLUMNS =
	'u."id" AS owner_id, u."username" AS owner_username, u."displayUsername" AS owner_display, ' +
	'u."banned" AS owner_banned, u."role" AS owner_role';

/** The preview of a report target for the admin queue, or null when it no longer exists. */
export async function targetPreview(
	db: D1Database,
	kind: ReportTargetKind,
	id: string
): Promise<TargetPreview | null> {
	let row: PreviewRow | null;
	if (kind === 'lineage') {
		row = await first<PreviewRow>(
			sql(
				db,
				'SELECT l.id AS id, v.name AS name, l.visibility AS visibility, l.status AS status, ' +
					`l.moderation AS moderation, l.curated AS curated, ${OWNER_COLUMNS} FROM lineages l ` +
					'LEFT JOIN versions v ON v.id = l.head_version LEFT JOIN "user" u ON u."id" = l.owner_user_id ' +
					'WHERE l.id = ?',
				id
			)
		);
	} else if (kind === 'pack') {
		row = await first<PreviewRow>(
			sql(
				db,
				'SELECT p.id AS id, p.name AS name, p.visibility AS visibility, NULL AS status, ' +
					`p.moderation AS moderation, 0 AS curated, ${OWNER_COLUMNS} FROM packs p ` +
					'LEFT JOIN "user" u ON u."id" = p.owner_user_id WHERE p.id = ?',
				id
			)
		);
	} else {
		row = await first<PreviewRow>(
			sql(
				db,
				'SELECT u."id" AS id, COALESCE(u."displayUsername", u."username") AS name, NULL AS visibility, ' +
					`NULL AS status, NULL AS moderation, 0 AS curated, ${OWNER_COLUMNS} FROM "user" u ` +
					'WHERE u."id" = ?',
				id
			)
		);
	}
	if (!row) return null;
	return {
		kind,
		id: row.id,
		name: row.name,
		visibility: row.visibility,
		status: row.status,
		moderation: row.moderation as ModerationState | null,
		curated: row.curated === 1,
		author:
			row.owner_id === null
				? null
				: {
						id: row.owner_id,
						nickname: row.owner_display ?? row.owner_username,
						banned: row.owner_banned === 1,
						admin: row.owner_role === 'admin'
					}
	};
}
