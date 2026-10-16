// Content-deletion policy of account closure (plan §3.8, T3.7; T4.1 adds the social parts).
//
// The user picks a mode when requesting the closure in /conta:
//   - 'anonymize': public CC content stays, credited to "autor removido" (F4); the current
//     nickname is held for 90 days without an owner, so nobody can take it to pose as the author
//     of the anonymized content;
//   - 'delete-all': everything goes, the nickname is free at once.
// Private data is always deleted. The choice is stored in account_deletion_requests (0009) and
// read by the Better Auth `beforeDelete` hook when the mailed confirmation link is opened; with
// no recorded choice the policy's default mode applies.
//
// Atomicity (plan §12): all statements of every part run in ONE D1 batch before Better Auth
// deletes the user row (sessions, accounts and 2FA rows cascade from it). Every statement is
// idempotent, so if the user deletion fails afterwards a retry with a new link completes.
//
// Extension (T4.1): add a DeletionPart to ACCOUNT_DELETION_PARTS, before the account parts (they
// may still need the user row and the profile, which Better Auth deletes only afterwards).
import type { D1Database } from '@cloudflare/workers-types';
import type { BeforeDeleteUser } from '../auth.ts';
import { batch, first, run, sql, type BoundStatement } from '../db.ts';
import type { ServerEnv } from '../env.ts';
import { deleteAcceptancesStatement } from '../legal/acceptance.ts';
import { NICKNAME_HOLD_MS } from './nickname.ts';

export const DELETION_MODES = ['anonymize', 'delete-all'] as const;
export type DeletionMode = (typeof DELETION_MODES)[number];

export function isDeletionMode(value: unknown): value is DeletionMode {
	return value === 'anonymize' || value === 'delete-all';
}

/** One table group of the policy. `now` is epoch ms. */
export interface DeletionPart {
	readonly name: string;
	statements(db: D1Database, userId: string, mode: DeletionMode, now: number): BoundStatement[];
}

export interface ContentDeletionPolicy {
	/** Mode applied when the user recorded no choice (closure started outside /conta). */
	readonly mode: DeletionMode;
	/** Every statement of every part, in order; run them with `batch` (atomic). */
	statements(db: D1Database, userId: string, mode: DeletionMode, now?: number): BoundStatement[];
}

/** Nickname holds: the user's own holds go; 'anonymize' holds the current nickname unowned. */
export const nicknameHoldsPart: DeletionPart = {
	name: 'username_holds',
	statements(db, userId, mode, now) {
		const statements = [sql(db, 'DELETE FROM username_holds WHERE user_id = ?', userId)];
		if (mode === 'anonymize') {
			statements.push(
				sql(
					db,
					'INSERT INTO username_holds (skeleton, username, user_id, released_at, redirect_to) ' +
						'SELECT "usernameSkeleton", "username", NULL, ?, NULL FROM "user" ' +
						'WHERE "id" = ? AND "username" IS NOT NULL AND "usernameSkeleton" IS NOT NULL ' +
						'ON CONFLICT (skeleton) DO UPDATE SET username = excluded.username, ' +
						'user_id = NULL, released_at = excluded.released_at, redirect_to = NULL',
					now + NICKNAME_HOLD_MS,
					userId
				)
			);
		}
		return statements;
	}
};

export const emailChangePart: DeletionPart = {
	name: 'email_change_requests',
	statements: (db, userId) => [
		sql(db, 'DELETE FROM email_change_requests WHERE user_id = ?', userId)
	]
};

export const policyAcceptancesPart: DeletionPart = {
	name: 'policy_acceptances',
	statements: (db, userId) => [deleteAcceptancesStatement(db, userId)]
};

/**
 * Parts of F3 (account and profile tables). Sessions, accounts and 2FA rows are Better Auth's and
 * cascade with the user row; the profile columns live on that row. The account_deletion_requests
 * row is deliberately NOT deleted here: it cascades with the user row, so if the user deletion
 * fails after the policy ran, a retry still reads the mode the user chose.
 */
export const ACCOUNT_DELETION_PARTS: readonly DeletionPart[] = [
	nicknameHoldsPart,
	emailChangePart,
	policyAcceptancesPart
];

export function createContentDeletionPolicy(
	parts: readonly DeletionPart[] = ACCOUNT_DELETION_PARTS,
	mode: DeletionMode = 'delete-all'
): ContentDeletionPolicy {
	return {
		mode,
		statements(db, userId, chosen, now = Date.now()) {
			if (typeof userId !== 'string' || userId === '') throw new Error('Invalid user id');
			if (!isDeletionMode(chosen)) throw new Error('Invalid deletion mode');
			return parts.flatMap((part) => part.statements(db, userId, chosen, now));
		}
	};
}

/** Records (or replaces) the mode chosen when the closure was requested. */
export async function recordDeletionRequest(
	db: D1Database,
	userId: string,
	mode: DeletionMode,
	now: number
): Promise<void> {
	if (!isDeletionMode(mode)) throw new Error('Invalid deletion mode');
	await run(
		sql(
			db,
			'INSERT INTO account_deletion_requests (user_id, mode, requested_at) VALUES (?, ?, ?) ' +
				'ON CONFLICT (user_id) DO UPDATE SET mode = excluded.mode, requested_at = excluded.requested_at',
			userId,
			mode,
			now
		)
	);
}

export async function readDeletionRequest(
	db: D1Database,
	userId: string
): Promise<{ mode: DeletionMode; requestedAt: number } | null> {
	const row = await first<{ mode: string; requested_at: number }>(
		sql(db, 'SELECT mode, requested_at FROM account_deletion_requests WHERE user_id = ?', userId)
	);
	if (!row || !isDeletionMode(row.mode)) return null;
	return { mode: row.mode, requestedAt: row.requested_at };
}

export interface AccountDeletionHookOptions {
	policy?: ContentDeletionPolicy;
	now?: () => number;
}

/**
 * Better Auth `beforeDelete` for createAuth's `beforeDeleteUser` option: reads the recorded mode
 * (or the policy default) and runs the policy in one batch. Throwing aborts the deletion.
 */
export function accountDeletionHook(
	env: Pick<ServerEnv, 'db'>,
	options: AccountDeletionHookOptions = {}
): BeforeDeleteUser {
	const policy = options.policy ?? createContentDeletionPolicy();
	const now = options.now ?? Date.now;
	return async (user) => {
		const request = await readDeletionRequest(env.db, user.id);
		const mode = request?.mode ?? policy.mode;
		await batch(env.db, policy.statements(env.db, user.id, mode, now()));
	};
}
