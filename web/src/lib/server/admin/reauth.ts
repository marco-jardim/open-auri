// Re-authentication for destructive admin actions: a TOTP code verified through Better Auth
// (`auth.api.verifyTOTP` with the admin's own session). On success the auth after-hook stamps
// `session.twoFactorVerifiedAt` (auth/hooks.ts), which makes the session fresh again for 10
// minutes (`isFreshSession`). Better Auth does not count failures for an existing session, so this
// module limits attempts per admin through the RL_AUTH binding and audits every attempt.
// Admins without 2FA (only possible with ADMIN_2FA_REQUIRED=false) re-authenticate by signing
// out and in again. No `$app/*`: tested inside workerd.
import type { D1Database, RateLimit } from '@cloudflare/workers-types';
import type { Auth } from '../auth.ts';
import { audit, AUDIT_ACTIONS, type AuditOptions } from './audit.ts';

export type ReauthResult =
	{ ok: true } | { ok: false; code: 'NO_SECOND_FACTOR' | 'INVALID_CODE' | 'RATE_LIMITED' };

export interface ReauthDeps {
	db: D1Database;
	auth: Pick<Auth, 'api'>;
	headers: Headers;
	rateLimit: RateLimit;
	user: { id: string; twoFactorEnabled: boolean };
	audit?: AuditOptions;
}

const TOTP = /^\d{6}$/;

/** Normalizes what people type ("123 456", "123-456"). */
export function normalizeTotp(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const code = value.replace(/[\s-]/g, '');
	return TOTP.test(code) ? code : null;
}

export async function reauthenticate(deps: ReauthDeps, rawCode: unknown): Promise<ReauthResult> {
	if (!deps.user.twoFactorEnabled) return { ok: false, code: 'NO_SECOND_FACTOR' };
	const limited = await deps.rateLimit
		.limit({ key: `admin-reauth:${deps.user.id}` })
		.then((outcome) => !outcome.success)
		// Fail closed: without the limiter, no unlimited guessing.
		.catch(() => true);
	if (limited) return { ok: false, code: 'RATE_LIMITED' };

	const code = normalizeTotp(rawCode);
	let ok = false;
	if (code) {
		ok = await deps.auth.api
			.verifyTOTP({ headers: deps.headers, body: { code } })
			.then(() => true)
			.catch(() => false);
	}
	await audit(
		deps.db,
		{
			actorId: deps.user.id,
			actorKind: 'admin',
			action: AUDIT_ACTIONS.reauth,
			targetKind: 'user',
			targetId: deps.user.id,
			detail: { result: ok ? 'ok' : 'invalid' }
		},
		deps.audit
	);
	return ok ? { ok: true } : { ok: false, code: 'INVALID_CODE' };
}
