// Social part of the account-closure policy (plan §3.8, T4.1). Runs inside the single batch of
// account/deletion.ts, before the account parts and before Better Auth deletes the user row.
//
// Both modes delete everything personal: the user's favorites, activity, attributed share events,
// shares (and their funnel), trades, and every report about the user. Reports the user FILED are
// deleted while open (they must not keep counting towards auto-hide) and kept anonymized
// (reporter NULL) once resolved, so the moderation history of other people's content survives.
//
//   'delete-all': every lineage (with all its versions) and every pack of the user is deleted.
//   'anonymize':  lineages that are public AND active, and public packs, are kept with
//                 owner_user_id = NULL ("autor removido"); every other lineage (private, unlisted,
//                 retracted) and pack is deleted.
//
// Forks made by other users always survive: lineages.forked_from_version is ON DELETE SET NULL.
// Partners of the user's active trades (and of trades on deleted lineages) are cancelled. Curves
// are content-addressed, hold no author and stay as the gate cache. S6 batches have no user.
// Every statement is idempotent (account/deletion.ts retries the whole batch).
import type { D1Database } from '@cloudflare/workers-types';
import type { DeletionMode, DeletionPart } from '#lib/server/account/deletion.ts';
import { sql, type BoundStatement } from '#lib/server/db.ts';

/** Lineages of the user that the mode deletes (owner_user_id = ? is the only parameter). */
function doomedLineages(mode: DeletionMode): string {
	return mode === 'delete-all'
		? 'SELECT id FROM lineages WHERE owner_user_id = ?'
		: "SELECT id FROM lineages WHERE owner_user_id = ? AND NOT (visibility = 'public' AND status = 'active')";
}

function doomedPacks(mode: DeletionMode): string {
	return mode === 'delete-all'
		? 'SELECT id FROM packs WHERE owner_user_id = ?'
		: "SELECT id FROM packs WHERE owner_user_id = ? AND visibility <> 'public'";
}

export function socialDeletionStatements(
	db: D1Database,
	userId: string,
	mode: DeletionMode
): BoundStatement[] {
	const lineages = doomedLineages(mode);
	const packs = doomedPacks(mode);
	const statements: BoundStatement[] = [
		// Trades: free the partners first (their match goes away with these rows).
		sql(
			db,
			"UPDATE trades SET status = 'cancelled' WHERE status IN ('waiting', 'matched') " +
				`AND match_id IN (SELECT id FROM trades WHERE user_id = ? OR lineage_id IN (${lineages}))`,
			userId,
			userId
		),
		sql(db, `DELETE FROM trades WHERE user_id = ? OR lineage_id IN (${lineages})`, userId, userId),
		// Reports about the user and about content that is about to disappear.
		sql(
			db,
			"DELETE FROM reports WHERE (target_kind = 'user' AND target_id = ?) " +
				`OR (target_kind = 'lineage' AND target_id IN (${lineages})) ` +
				`OR (target_kind = 'pack' AND target_id IN (${packs}))`,
			userId,
			userId,
			userId
		),
		// Reports the user filed: open ones go, resolved ones stay without the reporter.
		sql(db, 'DELETE FROM reports WHERE reporter_user_id = ? AND resolution IS NULL', userId),
		sql(db, 'UPDATE reports SET reporter_user_id = NULL WHERE reporter_user_id = ?', userId),
		// Personal activity.
		sql(db, 'DELETE FROM share_event_users WHERE user_id = ?', userId),
		sql(db, 'DELETE FROM shares WHERE owner_user_id = ?', userId),
		sql(db, 'DELETE FROM favorites WHERE user_id = ?', userId),
		sql(db, 'DELETE FROM activity WHERE user_id = ?', userId),
		// Content.
		sql(db, `DELETE FROM packs WHERE id IN (${packs})`, userId),
		sql(db, `DELETE FROM lineages WHERE id IN (${lineages})`, userId)
	];
	if (mode === 'anonymize') {
		statements.push(
			sql(db, 'UPDATE packs SET owner_user_id = NULL WHERE owner_user_id = ?', userId),
			sql(db, 'UPDATE lineages SET owner_user_id = NULL WHERE owner_user_id = ?', userId)
		);
	}
	return statements;
}

export const socialContentPart: DeletionPart = {
	name: 'social',
	statements: (db, userId, mode) => socialDeletionStatements(db, userId, mode)
};
