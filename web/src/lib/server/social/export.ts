// Social section of the LGPD export (art. 18, II and V; T4.1). Only rows of the requesting user:
// their lineages with every version, favorites, activity, shares with the aggregate funnel (counts
// only), the share events attributed to them, packs, reports they filed and their trades. Never
// another user's identity: no partner of a trade, no names of an audience, no reported user id.
import type { D1Database } from '@cloudflare/workers-types';
import type { ExportSection } from '#lib/server/account/export.ts';
import { all, sql } from '#lib/server/db.ts';
import { SHARE_EVENT_KINDS, isOneOf, type ShareEventKind } from '#lib/server/social/types.ts';

function iso(value: number | null): string | null {
	return value === null ? null : new Date(value).toISOString();
}

async function lineagesOf(db: D1Database, userId: string) {
	const [lineages, versions] = await Promise.all([
		all<{
			id: string;
			visibility: string;
			status: string;
			moderation: string;
			curated: number;
			forked_from_version: string | null;
			head_version: string | null;
			created_at: number;
			updated_at: number;
		}>(
			sql(
				db,
				'SELECT id, visibility, status, moderation, curated, forked_from_version, head_version, ' +
					'created_at, updated_at FROM lineages WHERE owner_user_id = ? ORDER BY created_at, id',
				userId
			)
		),
		all<{
			id: string;
			lineage_id: string;
			parent_id: string | null;
			curve_id: string;
			s1: string;
			name: string;
			description: string;
			license: string;
			recipe: string | null;
			lang: string;
			labels: string | null;
			created_at: number;
		}>(
			sql(
				db,
				'SELECT v.id, v.lineage_id, v.parent_id, v.curve_id, c.s1, v.name, v.description, ' +
					'v.license, v.recipe, v.lang, v.labels, v.created_at FROM versions v ' +
					'JOIN lineages l ON l.id = v.lineage_id JOIN curves c ON c.id = v.curve_id ' +
					'WHERE l.owner_user_id = ? ORDER BY v.created_at, v.id',
				userId
			)
		)
	]);
	return lineages.map((lineage) => ({
		id: lineage.id,
		visibility: lineage.visibility,
		status: lineage.status,
		moderation: lineage.moderation,
		curated: lineage.curated === 1,
		forkedFromVersion: lineage.forked_from_version,
		headVersion: lineage.head_version,
		createdAt: iso(lineage.created_at),
		updatedAt: iso(lineage.updated_at),
		versions: versions
			.filter((version) => version.lineage_id === lineage.id)
			.map((version) => ({
				id: version.id,
				parentId: version.parent_id,
				curveId: version.curve_id,
				s1: version.s1,
				name: version.name,
				description: version.description,
				license: version.license,
				recipe: version.recipe,
				lang: version.lang,
				// Filter labels by wire index of `s1` (migration 0012), as stored; null when none.
				labels: exportedLabels(version.labels),
				createdAt: iso(version.created_at)
			}))
	}));
}

/** `versions.labels` JSON → its array (the CHECK guarantees a 10-entry array); null otherwise. */
function exportedLabels(text: string | null): unknown[] | null {
	if (text === null) return null;
	try {
		const value: unknown = JSON.parse(text);
		return Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

async function sharesOf(db: D1Database, userId: string) {
	const [shares, anonymous, users] = await Promise.all([
		all<{
			id: string;
			lineage_id: string;
			version_id: string | null;
			channel: string | null;
			created_at: number;
		}>(
			sql(
				db,
				'SELECT id, lineage_id, version_id, channel, created_at FROM shares ' +
					'WHERE owner_user_id = ? ORDER BY created_at, id',
				userId
			)
		),
		all<{ share_id: string; kind: string; n: number }>(
			sql(
				db,
				'SELECT e.share_id, e.kind, sum(e.anon_count) AS n FROM share_events e ' +
					'JOIN shares s ON s.id = e.share_id WHERE s.owner_user_id = ? GROUP BY e.share_id, e.kind',
				userId
			)
		),
		all<{ share_id: string; kind: string; n: number }>(
			sql(
				db,
				'SELECT e.share_id, e.kind, count(*) AS n FROM share_event_users e ' +
					'JOIN shares s ON s.id = e.share_id WHERE s.owner_user_id = ? GROUP BY e.share_id, e.kind',
				userId
			)
		)
	]);
	return shares.map((share) => {
		const funnel = Object.fromEntries(
			SHARE_EVENT_KINDS.map((kind) => [kind, { anonymous: 0, users: 0 }])
		) as Record<ShareEventKind, { anonymous: number; users: number }>;
		for (const row of anonymous) {
			if (row.share_id === share.id && isOneOf(SHARE_EVENT_KINDS, row.kind)) {
				funnel[row.kind].anonymous = row.n;
			}
		}
		for (const row of users) {
			if (row.share_id === share.id && isOneOf(SHARE_EVENT_KINDS, row.kind)) {
				funnel[row.kind].users = row.n;
			}
		}
		return {
			id: share.id,
			lineageId: share.lineage_id,
			versionId: share.version_id,
			channel: share.channel,
			createdAt: iso(share.created_at),
			funnel
		};
	});
}

async function packsOf(db: D1Database, userId: string) {
	const [packs, items] = await Promise.all([
		all<{
			id: string;
			name: string;
			description: string;
			visibility: string;
			moderation: string;
			created_at: number;
			updated_at: number;
		}>(
			sql(
				db,
				'SELECT id, name, description, visibility, moderation, created_at, updated_at FROM packs ' +
					'WHERE owner_user_id = ? ORDER BY created_at, id',
				userId
			)
		),
		all<{ pack_id: string; lineage_id: string; position: number; license: string }>(
			sql(
				db,
				'SELECT i.pack_id, i.lineage_id, i.position, i.license FROM pack_items i ' +
					'JOIN packs p ON p.id = i.pack_id WHERE p.owner_user_id = ? ORDER BY i.pack_id, i.position',
				userId
			)
		)
	]);
	return packs.map((pack) => ({
		id: pack.id,
		name: pack.name,
		description: pack.description,
		visibility: pack.visibility,
		moderation: pack.moderation,
		createdAt: iso(pack.created_at),
		updatedAt: iso(pack.updated_at),
		items: items
			.filter((item) => item.pack_id === pack.id)
			.map((item) => ({
				lineageId: item.lineage_id,
				position: item.position,
				license: item.license
			}))
	}));
}

export const socialSection: ExportSection = {
	key: 'social',
	async collect({ db, userId }) {
		const [lineages, favorites, activity, shares, shareEvents, packs, reports, trades] =
			await Promise.all([
				lineagesOf(db, userId),
				all<{ lineage_id: string; created_at: number }>(
					sql(
						db,
						'SELECT lineage_id, created_at FROM favorites WHERE user_id = ? ORDER BY created_at, lineage_id',
						userId
					)
				),
				all<{ lineage_id: string; kind: string; first_at: number; last_at: number; count: number }>(
					sql(
						db,
						'SELECT lineage_id, kind, first_at, last_at, count FROM activity WHERE user_id = ? ' +
							'ORDER BY first_at, lineage_id, kind',
						userId
					)
				),
				sharesOf(db, userId),
				all<{ lineage_id: string; kind: string; at: number }>(
					sql(
						db,
						'SELECT s.lineage_id, e.kind, e.at FROM share_event_users e JOIN shares s ON s.id = e.share_id ' +
							'WHERE e.user_id = ? ORDER BY e.at, s.lineage_id, e.kind',
						userId
					)
				),
				packsOf(db, userId),
				all<{
					id: string;
					target_kind: string;
					target_id: string;
					reason: string;
					note: string | null;
					created_at: number;
					resolution: string | null;
					resolved_at: number | null;
				}>(
					sql(
						db,
						'SELECT id, target_kind, target_id, reason, note, created_at, resolution, resolved_at ' +
							'FROM reports WHERE reporter_user_id = ? ORDER BY created_at, id',
						userId
					)
				),
				all<{
					id: string;
					lineage_id: string;
					version_id: string;
					status: string;
					score: number | null;
					created_at: number;
					matched_at: number | null;
					scored_at: number | null;
					expires_at: number;
				}>(
					sql(
						db,
						'SELECT id, lineage_id, version_id, status, score, created_at, matched_at, scored_at, ' +
							'expires_at FROM trades WHERE user_id = ? ORDER BY created_at, id',
						userId
					)
				)
			]);
		return {
			lineages,
			favorites: favorites.map((row) => ({
				lineageId: row.lineage_id,
				createdAt: iso(row.created_at)
			})),
			activity: activity.map((row) => ({
				lineageId: row.lineage_id,
				kind: row.kind,
				firstAt: iso(row.first_at),
				lastAt: iso(row.last_at),
				count: row.count
			})),
			shares,
			// Funnel events attributed to the user on other people's shares (no share id: it would
			// point at the sharer).
			sharedWithMe: shareEvents.map((row) => ({
				lineageId: row.lineage_id,
				kind: row.kind,
				at: iso(row.at)
			})),
			packs,
			reports: reports.map((row) => ({
				id: row.id,
				targetKind: row.target_kind,
				// A reported account is another person: its id is not exported.
				targetId: row.target_kind === 'user' ? null : row.target_id,
				reason: row.reason,
				note: row.note,
				createdAt: iso(row.created_at),
				resolution: row.resolution,
				resolvedAt: iso(row.resolved_at)
			})),
			// The partner of a trade is never exported (neither their trade nor their score).
			trades: trades.map((row) => ({
				id: row.id,
				lineageId: row.lineage_id,
				versionId: row.version_id,
				status: row.status,
				scoreGiven: row.score,
				createdAt: iso(row.created_at),
				matchedAt: iso(row.matched_at),
				scoredAt: iso(row.scored_at),
				expiresAt: iso(row.expires_at)
			}))
		};
	}
};
