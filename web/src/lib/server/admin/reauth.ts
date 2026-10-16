// Re-authentication for destructive admin actions: a TOTP code verified through Better Auth
// (`auth.api.verifyTOTP` with the admin's own session). On success the auth after-hook stamps
// `session.twoFactorVerifiedAt` (auth/hooks.ts), which makes the session fresh again for 10
// minutes (`isFreshSession`). Better Auth does not count failures for an existing session; the auth
// before-hook applies the per-user second-factor rule to that very call (auth/secret-guard.ts,
// D1: 5 attempts per 5 min, 20 wrong codes per day), so this module and a direct POST of
// /two-factor/verify-totp share one budget. A refusal there comes back as RATE_LIMITED. The
// optional RL_AUTH binding is only an extra per-location burst guard in front of it. Every attempt
// is audited. Admins without 2FA (only possible with ADMIN_2FA_REQUIRED=false) re-authenticate by
// signing out and in again. No `$app/*`: tested inside workerd.
import type { D1Database, RateLimit } from '@cloudflare/workers-types';
import { isAPIError } from 'better-auth/api';
import type { Auth } from '../auth.ts';
import { audit, AUDIT_ACTIONS, type AuditOptions } from './audit.ts';

export type ReauthResult =
	{ ok: true } | { ok: false; code: 'NO_SECOND_FACTOR' | 'INVALID_CODE' | 'RATE_LIMITED' };

export interface ReauthDeps {
	db: D1Database;
	auth: Pick<Auth, 'api'>;
	headers: Headers;
	/** Optional coarse burst guard (RL_AUTH); the D1 per-user rule applies regardless. */
	rateLimit?: Pick<RateLimit, 'limit'>;
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

/** The secret-attempt rule (429) or its storage being down (503): no code was checked. */
function isLimitError(error: unknown): boolean {
	if (!isAPIError(error)) return false;
	const status: unknown = Reflect.get(error, 'statusCode');
	return status === 429 || status === 503;
}

export async function reauthenticate(deps: ReauthDeps, rawCode: unknown): Promise<ReauthResult> {
	if (!deps.user.twoFactorEnabled) return { ok: false, code: 'NO_SECOND_FACTOR' };
	if (deps.rateLimit) {
		const limited = await deps.rateLimit
			.limit({ key: `admin-reauth:${deps.user.id}` })
			.then((outcome) => !outcome.success)
			// Fail closed: without the limiter, no unlimited guessing.
			.catch(() => true);
		if (limited) return { ok: false, code: 'RATE_LIMITED' };
	}

	const code = normalizeTotp(rawCode);
	let outcome: 'ok' | 'invalid' | 'limited' = 'invalid';
	if (code) {
		outcome = await deps.auth.api
			.verifyTOTP({ headers: deps.headers, body: { code } })
			.then(() => 'ok' as const)
			.catch((error: unknown) =>
				isLimitError(error) ? ('limited' as const) : ('invalid' as const)
			);
	}
	await audit(
		deps.db,
		{
			actorId: deps.user.id,
			actorKind: 'admin',
			action: AUDIT_ACTIONS.reauth,
			targetKind: 'user',
			targetId: deps.user.id,
			detail: { result: outcome }
		},
		deps.audit
	);
	if (outcome === 'ok') return { ok: true };
	return { ok: false, code: outcome === 'limited' ? 'RATE_LIMITED' : 'INVALID_CODE' };
}
