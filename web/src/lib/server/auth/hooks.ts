// Better Auth `hooks.before` / `hooks.after` of open-auri. They run for HTTP requests through
// `auth.handler` and for server-side `auth.api.*` calls alike.
//
// before, in order:
//   0. the admin plugin's endpoints (`/admin/*`, impersonation included) answer 404 over HTTP;
//      server-side `auth.api.*` calls (no request) keep working for the guarded /admin area (T3.8);
//   1. strict origin: state-changing HTTP requests must come from PUBLIC_ORIGIN (Origin, or
//      Referer when Origin is absent), on top of Better Auth's own CSRF/origin checks;
//   2. SIGNUP_ENABLED=false → `/sign-up/email` answers 403 `SIGNUP_DISABLED`;
//   3. nickname rules: `/update-user` never changes the nickname (400
//      `USERNAME_CHANGE_NOT_ALLOWED`; /conta changes it through account/nickname.ts, which writes
//      D1 directly with the 30-day and hold rules); `/sign-up/email` checks format, reserved
//      names, skeleton uniqueness and active holds (held looks taken);
//   4. `/delete-user` without the confirmation token requires the password;
//   5. the T3.3 guard (RL_AUTH → D1 windows → Turnstile) on the guarded paths. The Turnstile
//      token travels in the `x-turnstile-token` request header.
// after:
//   - 2FA session marker after a successful TOTP / backup-code verification;
//   - "password changed" notice after `/change-password`.
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { isNicknameHeld } from '../account/nickname.ts';
import { first, sql } from '../db.ts';
import type { ServerEnv } from '../env.ts';
import type { AuthGuard } from '../security/auth-guard.ts';
import { isAuthGuardedPath } from '../security/ratelimit.ts';
import type { AuthMailer } from './emails.ts';
import { checkUsername, normalizeUsername, usernameSkeleton } from './username.ts';

/** Request header carrying the Turnstile token to the auth endpoints (T3.6 sets it). */
export const TURNSTILE_HEADER = 'x-turnstile-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STATUS_NAME = {
	400: 'BAD_REQUEST',
	403: 'FORBIDDEN',
	404: 'NOT_FOUND',
	429: 'TOO_MANY_REQUESTS',
	503: 'SERVICE_UNAVAILABLE'
} as const;
const TWO_FACTOR_VERIFY_PATHS = new Set([
	'/two-factor/verify-totp',
	'/two-factor/verify-backup-code'
]);

export interface AuthHookDeps {
	env: Pick<ServerEnv, 'db' | 'publicOrigin' | 'flags'>;
	guard: AuthGuard;
	mailer: AuthMailer;
	now?: () => Date;
}

type Body = Record<string, unknown>;

function asBody(value: unknown): Body {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Body)
		: {};
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function requestOrigin(headers: Headers): string | null {
	const origin = headers.get('origin');
	if (origin && origin !== 'null') return origin;
	const referer = headers.get('referer');
	if (!referer) return null;
	try {
		return new URL(referer).origin;
	} catch {
		return null;
	}
}

function fail(status: keyof typeof STATUS_NAME, code: string, message: string): APIError {
	return APIError.from(STATUS_NAME[status], { code, message });
}

/** Identifier the guard keys its per-account limits on, per path. */
function guardIdentifier(path: string, body: Body): string | null {
	if (path === '/sign-in/username') return text(body.username) ?? null;
	if (path === '/change-email') return text(body.newEmail) ?? null;
	return text(body.email) ?? null;
}

const USERNAME_TAKEN = 'USERNAME_IS_ALREADY_TAKEN';
export const USERNAME_CHANGE_NOT_ALLOWED = 'USERNAME_CHANGE_NOT_ALLOWED';

/** Endpoints of Better Auth's admin plugin (all live under `/admin/`). */
export function isAdminPluginPath(path: string | undefined): boolean {
	return typeof path === 'string' && (path === '/admin' || path.startsWith('/admin/'));
}

export function createBeforeHook(deps: AuthHookDeps) {
	return createAuthMiddleware(async (ctx) => {
		const request = ctx.request;
		const path = ctx.path;
		const body = asBody(ctx.body);

		if (request && isAdminPluginPath(path)) {
			throw fail(404, 'NOT_FOUND', 'Not found');
		}

		if (request && !SAFE_METHODS.has(request.method)) {
			if (requestOrigin(request.headers) !== deps.env.publicOrigin) {
				throw fail(403, 'INVALID_ORIGIN', 'Invalid origin');
			}
		}

		if (path === '/sign-up/email' && !deps.env.flags.signupEnabled) {
			throw fail(403, 'SIGNUP_DISABLED', 'Sign-up is disabled');
		}

		if (path === '/update-user' && ('username' in body || 'displayUsername' in body)) {
			throw fail(400, USERNAME_CHANGE_NOT_ALLOWED, 'The nickname changes only in the account area');
		}

		if (path === '/sign-up/email') {
			const username = typeof body.username === 'string' ? body.username : undefined;
			const display = typeof body.displayUsername === 'string' ? body.displayUsername : undefined;
			if (
				display !== undefined &&
				(username === undefined || normalizeUsername(display) !== normalizeUsername(username))
			) {
				throw fail(400, 'DISPLAY_USERNAME_MISMATCH', 'Display nickname must match the nickname');
			}
			if (username !== undefined) {
				const problem = checkUsername(username);
				if (problem === 'invalid') throw fail(400, 'INVALID_USERNAME', 'Invalid nickname');
				// A reserved nickname looks taken: no list probing.
				if (problem === 'reserved') throw fail(400, USERNAME_TAKEN, 'Nickname is already taken');
				const row = await first<{ id: string }>(
					sql(
						deps.env.db,
						'SELECT id FROM "user" WHERE usernameSkeleton = ? LIMIT 1',
						usernameSkeleton(username)
					)
				);
				const now = (deps.now?.() ?? new Date()).getTime();
				// A nickname on its 90-day hold answers exactly like a taken one.
				if (row || (await isNicknameHeld(deps.env.db, username, now))) {
					throw fail(400, USERNAME_TAKEN, 'Nickname is already taken');
				}
			}
		}

		if (path === '/delete-user' && !text(body.token) && !text(body.password)) {
			throw fail(400, 'PASSWORD_REQUIRED', 'Password is required');
		}

		if (isAuthGuardedPath(path)) {
			const headers = request?.headers ?? ctx.headers ?? new Headers();
			let userId: string | null = null;
			if (path === '/change-email') userId = (await getSessionFromCtx(ctx))?.user.id ?? null;
			const result = await deps.guard({
				path,
				ip: headers.get('cf-connecting-ip'),
				email: guardIdentifier(path, body),
				userId,
				turnstileToken: headers.get(TURNSTILE_HEADER)
			});
			if (!result.ok) {
				throw new APIError(
					STATUS_NAME[result.status],
					{ code: result.code, message: result.code },
					result.retryAfter === undefined ? undefined : { 'Retry-After': String(result.retryAfter) }
				);
			}
		}
	});
}

function returnedToken(returned: unknown): string | null {
	if (typeof returned !== 'object' || returned === null) return null;
	const token = (returned as { token?: unknown }).token;
	return typeof token === 'string' && token !== '' ? token : null;
}

interface ReturnedUser {
	id: string;
	email: string;
	name?: string | null;
	emailVerified?: boolean | null;
}

function returnedUser(returned: unknown): ReturnedUser | null {
	if (typeof returned !== 'object' || returned === null) return null;
	const user = (returned as { user?: unknown }).user;
	if (typeof user !== 'object' || user === null) return null;
	const { id, email, name, emailVerified } = user as Record<string, unknown>;
	if (typeof id !== 'string' || typeof email !== 'string') return null;
	return {
		id,
		email,
		name: typeof name === 'string' ? name : null,
		emailVerified: emailVerified === true
	};
}

export function createAfterHook(deps: AuthHookDeps) {
	const now = deps.now ?? (() => new Date());
	return createAuthMiddleware(async (ctx) => {
		const returned: unknown = ctx.context.returned;
		if (returned === undefined || returned === null || isAPIError(returned)) return;
		if (returned instanceof Response && !returned.ok) return;

		if (TWO_FACTOR_VERIFY_PATHS.has(ctx.path)) {
			// A session created by this request (sign-in challenge, or the TOTP verification that
			// enables 2FA and rotates the session) wins over the token echoed in the body.
			const token = ctx.context.newSession?.session.token ?? returnedToken(returned);
			if (token) {
				await ctx.context.internalAdapter.updateSession(token, { twoFactorVerifiedAt: now() });
			}
			return;
		}

		if (ctx.path === '/change-password') {
			const user = returnedUser(returned);
			if (user) {
				await deps.mailer
					.passwordChanged(user, String(now().getTime()), ctx.request)
					.catch(() => undefined);
			}
		}
	});
}
