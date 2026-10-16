// Access helpers for server code (load functions, actions, endpoints). The core is plain
// TypeScript returning typed results, testable in workerd; `kit.ts` turns failures into SvelteKit
// `error(401 | 403)`.
import type { AuthSession, AuthUser } from '../types.ts';

export interface AuthLocals {
	user: AuthUser | null;
	session: AuthSession | null;
}

export type AccessFailure =
	| { ok: false; status: 401; code: 'UNAUTHENTICATED' }
	| { ok: false; status: 403; code: 'EMAIL_NOT_VERIFIED' | 'BANNED' };

export type AccessResult = { ok: true; user: AuthUser; session: AuthSession } | AccessFailure;

/** Signed in (and not banned). */
export function checkUser(locals: AuthLocals): AccessResult {
	const { user, session } = locals;
	if (!user || !session || session.userId !== user.id) {
		return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
	}
	if (user.banned) return { ok: false, status: 403, code: 'BANNED' };
	return { ok: true, user, session };
}

/** Signed in with a verified e-mail: the precondition of every social action (plan §3.7). */
export function checkVerified(locals: AuthLocals): AccessResult {
	const result = checkUser(locals);
	if (!result.ok) return result;
	if (!result.user.emailVerified) return { ok: false, status: 403, code: 'EMAIL_NOT_VERIFIED' };
	return result;
}

export class AccessError extends Error {
	readonly status: AccessFailure['status'];
	readonly code: AccessFailure['code'];
	constructor(failure: AccessFailure) {
		super(failure.code);
		this.name = 'AccessError';
		this.status = failure.status;
		this.code = failure.code;
	}
}

/** Throwing variants for code that is not SvelteKit-aware (throws {@link AccessError}). */
export function assertUser(locals: AuthLocals): { user: AuthUser; session: AuthSession } {
	const result = checkUser(locals);
	if (!result.ok) throw new AccessError(result);
	return { user: result.user, session: result.session };
}

export function assertVerified(locals: AuthLocals): { user: AuthUser; session: AuthSession } {
	const result = checkVerified(locals);
	if (!result.ok) throw new AccessError(result);
	return { user: result.user, session: result.session };
}
