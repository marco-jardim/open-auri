// SvelteKit wrappers of the access helpers: `error(401)` when signed out, `error(403)` when the
// e-mail is not verified or the account is banned. Keep this file thin; the logic is in guards.ts.
import { error } from '@sveltejs/kit';
import { checkUser, checkVerified, type AccessResult, type AuthLocals } from './guards.ts';
import type { AuthSession, AuthUser } from '../types.ts';

function unwrap(result: AccessResult): { user: AuthUser; session: AuthSession } {
	if (!result.ok) error(result.status, result.code);
	return { user: result.user, session: result.session };
}

export function requireUser(locals: AuthLocals): { user: AuthUser; session: AuthSession } {
	return unwrap(checkUser(locals));
}

export function requireVerified(locals: AuthLocals): { user: AuthUser; session: AuthSession } {
	return unwrap(checkVerified(locals));
}
