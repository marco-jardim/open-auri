// Test-only password check. Raw scrypt comparison against the credential account of `userId`,
// WITHOUT the per-user attempt limits: product code never checks a password this way (the /conta
// actions hand it to Better Auth, whose hooks apply the limits in auth/secret-guard.ts).
import type { D1Database } from '@cloudflare/workers-types';
import { verifyUserPassword } from '#lib/server/auth/secret-guard.ts';

export function verifyCurrentPassword(
	db: D1Database,
	userId: string,
	password: string
): Promise<boolean> {
	return verifyUserPassword(db, userId, password);
}
