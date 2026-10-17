// Queries of the activity service (T4.4, FX4.6) that repo.ts does not have. No visibility rule of
// lineages is involved here: one reads the actor's own profile flag, the other deletes the actor's
// own event-id claims from the kit's sliding-window table (migration 0007, `rate_limit_counters`).
import type { D1Database } from '@cloudflare/workers-types';
import { first, run, sql } from '#lib/server/db.ts';

/**
 * True when the user exists and chose `activity_visibility = 'public'`. Only those users are
 * attributed to share funnels (FX4.6): a private actor's preview, install or favorite never shows
 * up in someone else's share statistics.
 */
export async function hasPublicActivity(db: D1Database, userId: string): Promise<boolean> {
	const row = await first<{ one: number }>(
		sql(
			db,
			`SELECT 1 AS one FROM "user" WHERE "id" = ? AND "activity_visibility" = 'public'`,
			userId
		)
	);
	return Boolean(row);
}

/** Characters of a keyed hash (base64url) and of a user id (`rateLimitKey` accepts no others). */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;

/** Exclusive upper bound of the keys that start with `prefix` (last character + 1). */
function prefixEnd(prefix: string): string {
	return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/**
 * Deletes the event-id claims of one user: keys `id:<group><uuid>:<subjectHash>:<window>`
 * (current format, keyed hash of the user id) and `u:<group><uuid>:<userId>:<window>` (format
 * before FX4.6, raw user id). `group` is the claim group prefix (`act.ev:`). Each format is
 * matched by a key range on its prefix (uses the primary key) plus the `:<part>:` segment. No
 * GLOB pattern: the earlier `key GLOB ?` form made D1 (workerd) refuse the statement; plain
 * comparisons and `instr()` are accepted. Returns the number of rows deleted.
 */
export async function deleteEventClaims(
	db: D1Database,
	group: string,
	subjectHash: string,
	userId: string
): Promise<number> {
	if (!/^[a-z0-9.:]+$/.test(group) || !KEY_PART.test(subjectHash) || !KEY_PART.test(userId)) {
		throw new RangeError('invalid claim key part');
	}
	const hashed = `id:${group}`;
	const legacy = `u:${group}`;
	const meta = await run(
		sql(
			db,
			'DELETE FROM rate_limit_counters WHERE ' +
				'(key >= ? AND key < ? AND instr(key, ?) > 0) OR (key >= ? AND key < ? AND instr(key, ?) > 0)',
			hashed,
			prefixEnd(hashed),
			`:${subjectHash}:`,
			legacy,
			prefixEnd(legacy),
			`:${userId}:`
		)
	);
	return meta.changes;
}
