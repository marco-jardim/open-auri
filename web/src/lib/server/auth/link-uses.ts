// Single use of the e-mail-change links (Q3-4, table auth_link_uses in migration 0010). The hook
// claims a link right before Better Auth acts on it; only the first claim of a link succeeds.
//
// A link is identified by the SIGNED part of its JWT (`header.payload`), never by the raw token
// text (Q3 round 2, M1): jose decodes the signature leniently (ASCII whitespace ignored, unused
// low bits of the last base64url character ignored), so many different strings verify as the same
// token. The signed part is fixed by the signature; the hook also refuses any token that is not a
// strict compact JWS ({@link isCompactJws}) before Better Auth sees it.
// No `$app/*`: tested inside workerd.
import type { D1Database } from '@cloudflare/workers-types';
import { batch, sql } from '../db.ts';

/** Expired rows removed per claim (keeps the table small without a job). */
const PRUNE_BATCH = 20;

/** Three base64url segments, nothing else (no whitespace, padding or other characters). */
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Whether `token` is a strict compact JWS (`header.payload.signature`, base64url only). */
export function isCompactJws(token: string): boolean {
	return COMPACT_JWS.test(token);
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Stable id of a link: SHA-256 (hex) of the token's signed part `header.payload`. Every string
 * that verifies as the same token has the same id. Throws for anything but a strict compact JWS.
 */
export async function linkUseId(token: string): Promise<string> {
	if (!isCompactJws(token)) throw new TypeError('not a compact JWS');
	return sha256Hex(token.slice(0, token.lastIndexOf('.')));
}

/**
 * Records the first use of the link `id` ({@link linkUseId}). Returns true for the first use,
 * false when the link was already used. `expiresAt` (epoch ms) is the token's own expiry. Throws
 * when D1 fails (the caller refuses the link: failing open would reopen the flood).
 */
export async function claimLinkUse(
	db: D1Database,
	id: string,
	expiresAt: number,
	now: number = Date.now()
): Promise<boolean> {
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
			id,
			now,
			Math.max(expiresAt, now)
		)
	]);
	return (inserted?.results.length ?? 0) > 0;
}
