// Single use of the e-mail-change links (Q3-4, table auth_link_uses in migration 0010). The hook
// claims a link right before Better Auth acts on it; only the first claim of a token succeeds.
// No `$app/*`: tested inside workerd.
import type { D1Database } from '@cloudflare/workers-types';
import { batch, sql } from '../db.ts';

/** Expired rows removed per claim (keeps the table small without a job). */
const PRUNE_BATCH = 20;

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Records the first use of `token`. Returns true for the first use, false when the token was
 * already used. `expiresAt` (epoch ms) is the token's own expiry. Throws when D1 fails (the caller
 * refuses the link: failing open would reopen the flood).
 */
export async function claimLinkUse(
	db: D1Database,
	token: string,
	expiresAt: number,
	now: number = Date.now()
): Promise<boolean> {
	const hash = await sha256Hex(token);
	const [, inserted] = await batch<{ token_hash: string }>(db, [
		sql(
			db,
			'DELETE FROM auth_link_uses WHERE token_hash IN ' +
				'(SELECT token_hash FROM auth_link_uses WHERE expires_at < ? LIMIT ?)',
			now,
			PRUNE_BATCH
		),
		sql(
			db,
			'INSERT INTO auth_link_uses (token_hash, used_at, expires_at) VALUES (?, ?, ?) ' +
				'ON CONFLICT (token_hash) DO NOTHING RETURNING token_hash',
			hash,
			now,
			Math.max(expiresAt, now)
		)
	]);
	return (inserted?.results.length ?? 0) > 0;
}
