// Public nickname changes from /conta (plan §3.7). Format, reserved names and the confusable
// skeleton come from T3.5 (auth/username.ts); this module adds what T3.5 left to the account area:
//   - the first choice (account without a nickname) needs a verified e-mail and has no wait;
//   - later changes at most once every 30 days (clock: `username_changed_at`); changes that keep
//     the skeleton (case or compatibility forms only) are cosmetic and always allowed;
//   - the previous nickname is held for 90 days (username_holds, by skeleton) and redirects to the
//     owner's current one; only the previous owner may take it back during the hold;
//   - uniqueness against current nicknames AND active holds, both by skeleton.
// The write is a single D1 batch (hold + redirects + user row); the unique index on
// "user"."usernameSkeleton" settles races between two accounts.
import type { D1Database } from '@cloudflare/workers-types';
import { all, batch, first, sql, type BoundStatement } from '../db.ts';
import { checkUsername, normalizeUsername, usernameSkeleton } from '../auth/username.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
export const NICKNAME_CHANGE_INTERVAL_MS = 30 * DAY_MS;
export const NICKNAME_HOLD_MS = 90 * DAY_MS;

export type NicknameError = 'unverified' | 'invalid' | 'taken' | 'too-soon' | 'unchanged';

export type NicknameResult =
	| { ok: true; username: string; displayUsername: string; kind: 'first' | 'change' | 'cosmetic' }
	| { ok: false; error: NicknameError; retryAt?: number };

interface NicknameRow {
	username: string | null;
	displayUsername: string | null;
	usernameSkeleton: string | null;
	username_changed_at: number | null;
	emailVerified: number | boolean | null;
}

/** Display form of the nickname as typed: NFKC + trim, case kept. */
export function displayNickname(value: string): string {
	return value.normalize('NFKC').trim();
}

/**
 * When the next skeleton-changing nickname change is allowed (epoch ms), or null when allowed now.
 * Never-changed nicknames (set at sign-up, or none yet) may change at once.
 */
export function nextNicknameChangeAt(
	state: { username: string | null; changedAt: number | null },
	now: number
): number | null {
	if (state.username === null || state.changedAt === null) return null;
	const next = state.changedAt + NICKNAME_CHANGE_INTERVAL_MS;
	return next > now ? next : null;
}

interface HoldRow {
	user_id: string | null;
	redirect_to: string | null;
	username: string;
}

/** Active hold on `skeleton`, if any. */
async function activeHold(db: D1Database, skeleton: string, now: number): Promise<HoldRow | null> {
	return first<HoldRow>(
		sql(
			db,
			'SELECT user_id, redirect_to, username FROM username_holds ' +
				'WHERE skeleton = ? AND released_at > ?',
			skeleton,
			now
		)
	);
}

/**
 * Whether `value` is held for someone other than `userId` (a hold of `userId` itself does not
 * count). For the sign-up hook (T3.5) and the nickname form alike.
 */
export async function isNicknameHeld(
	db: D1Database,
	value: string,
	now: number,
	userId: string | null = null
): Promise<boolean> {
	const hold = await activeHold(db, usernameSkeleton(value), now);
	return hold !== null && (userId === null || hold.user_id !== userId);
}

function isUniqueViolation(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export async function changeNickname(
	db: D1Database,
	userId: string,
	input: string,
	now: number
): Promise<NicknameResult> {
	const row = await first<NicknameRow>(
		sql(
			db,
			'SELECT "username", "displayUsername", "usernameSkeleton", "username_changed_at", ' +
				'"emailVerified" FROM "user" WHERE "id" = ?',
			userId
		)
	);
	if (!row) return { ok: false, error: 'invalid' };
	if (row.emailVerified !== 1 && row.emailVerified !== true) {
		return { ok: false, error: 'unverified' };
	}
	if (typeof input !== 'string') return { ok: false, error: 'invalid' };

	const problem = checkUsername(input);
	if (problem === 'invalid') return { ok: false, error: 'invalid' };
	// Reserved names look taken (no probing of the list), as in the sign-up hook.
	if (problem === 'reserved') return { ok: false, error: 'taken' };

	const username = normalizeUsername(input);
	const display = displayNickname(input);
	const skeleton = usernameSkeleton(username);
	const current = row.username;
	const currentSkeleton = row.usernameSkeleton ?? (current ? usernameSkeleton(current) : null);
	const nowIso = new Date(now).toISOString();

	if (current !== null && currentSkeleton === skeleton) {
		if (current === username && (row.displayUsername ?? current) === display) {
			return { ok: false, error: 'unchanged' };
		}
		// Same skeleton: nobody else can hold it, no hold to create, no clock to restart.
		await batch(db, [
			sql(
				db,
				'UPDATE "user" SET "username" = ?, "displayUsername" = ?, "updatedAt" = ? WHERE "id" = ?',
				username,
				display,
				nowIso,
				userId
			)
		]);
		return { ok: true, username, displayUsername: display, kind: 'cosmetic' };
	}

	const retryAt = nextNicknameChangeAt(
		{ username: current, changedAt: row.username_changed_at },
		now
	);
	if (retryAt !== null) return { ok: false, error: 'too-soon', retryAt };

	const owner = await first<{ id: string }>(
		sql(db, 'SELECT "id" FROM "user" WHERE "usernameSkeleton" = ? AND "id" <> ?', skeleton, userId)
	);
	if (owner) return { ok: false, error: 'taken' };
	if (await isNicknameHeld(db, username, now, userId)) return { ok: false, error: 'taken' };

	const statements: BoundStatement[] = [
		// An expired hold on the new name, or the user's own hold (taking an old nickname back).
		sql(
			db,
			'DELETE FROM username_holds WHERE skeleton = ? AND (released_at <= ? OR user_id = ?)',
			skeleton,
			now,
			userId
		)
	];
	if (current !== null && currentSkeleton !== null) {
		statements.push(
			sql(
				db,
				'INSERT INTO username_holds (skeleton, username, user_id, released_at, redirect_to) ' +
					'VALUES (?, ?, ?, ?, ?) ON CONFLICT (skeleton) DO UPDATE SET ' +
					'username = excluded.username, user_id = excluded.user_id, ' +
					'released_at = excluded.released_at, redirect_to = excluded.redirect_to',
				currentSkeleton,
				current,
				userId,
				now + NICKNAME_HOLD_MS,
				username
			),
			// Older nicknames still on hold now redirect to the newest one.
			sql(
				db,
				'UPDATE username_holds SET redirect_to = ? WHERE user_id = ? AND released_at > ?',
				username,
				userId,
				now
			)
		);
	}
	statements.push(
		sql(
			db,
			'UPDATE "user" SET "username" = ?, "displayUsername" = ?, "usernameSkeleton" = ?, ' +
				'"username_changed_at" = ?, "updatedAt" = ? WHERE "id" = ?',
			username,
			display,
			skeleton,
			now,
			nowIso,
			userId
		)
	);
	try {
		await batch(db, statements);
	} catch (error) {
		if (isUniqueViolation(error)) return { ok: false, error: 'taken' };
		throw error;
	}
	const kind = current === null ? 'first' : 'change';
	return { ok: true, username, displayUsername: display, kind };
}

export type NicknameLookup =
	| { kind: 'user'; userId: string; username: string; displayUsername: string }
	| { kind: 'redirect'; to: string }
	| { kind: 'held' };

/**
 * Resolves `/u/<value>` (F4): the current owner, a redirect from a held previous nickname to the
 * owner's current one, `held` for a nickname held without owner (closed account), or null.
 */
export async function resolveNickname(
	db: D1Database,
	value: string,
	now: number
): Promise<NicknameLookup | null> {
	if (typeof value !== 'string' || value.length > 64) return null;
	const skeleton = usernameSkeleton(value);
	const user = await first<{ id: string; username: string; displayUsername: string | null }>(
		sql(
			db,
			'SELECT "id", "username", "displayUsername" FROM "user" WHERE "usernameSkeleton" = ?',
			skeleton
		)
	);
	if (user) {
		return {
			kind: 'user',
			userId: user.id,
			username: user.username,
			displayUsername: user.displayUsername ?? user.username
		};
	}
	const hold = await activeHold(db, skeleton, now);
	if (!hold) return null;
	if (hold.user_id !== null && hold.redirect_to !== null) {
		return { kind: 'redirect', to: hold.redirect_to };
	}
	return { kind: 'held' };
}

/** Nicknames of `userId` still on hold (for /conta and the data export). */
export async function listNicknameHolds(
	db: D1Database,
	userId: string,
	now: number
): Promise<{ username: string; releasedAt: number }[]> {
	const rows = await all<{ username: string; released_at: number }>(
		sql(
			db,
			'SELECT username, released_at FROM username_holds WHERE user_id = ? AND released_at > ? ' +
				'ORDER BY released_at',
			userId,
			now
		)
	);
	return rows.map((row) => ({ username: row.username, releasedAt: row.released_at }));
}
