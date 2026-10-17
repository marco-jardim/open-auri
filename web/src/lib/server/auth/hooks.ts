// Better Auth `hooks.before` / `hooks.after` of open-auri. They run for HTTP requests through
// `auth.handler` and for server-side `auth.api.*` calls alike.
//
// before, in order:
//   0. over HTTP, the admin plugin's endpoints (`/admin/*`, impersonation included) and the
//      endpoints the app does not use (CLOSED_AUTH_PATHS) answer 404; server-side `auth.api.*`
//      calls (no request) keep working for the guarded /admin area (T3.8);
//   1. strict origin: state-changing HTTP requests must come from PUBLIC_ORIGIN (Origin, or
//      Referer when Origin is absent), on top of Better Auth's own CSRF/origin checks; redirect
//      targets (`callbackURL`, `redirectTo`, `errorCallbackURL`, `newUserCallbackURL`, body or
//      query, every endpoint) must be canonical paths on PUBLIC_ORIGIN (403 INVALID_CALLBACK_URL);
//   2. SIGNUP_ENABLED=false → `/sign-up/email` answers 403 `SIGNUP_DISABLED`;
//   3. nickname and name rules: `/update-user` never changes the nickname (400
//      `USERNAME_CHANGE_NOT_ALLOWED`; /conta changes it through account/nickname.ts, which writes
//      D1 directly with the 30-day and hold rules); `/sign-up/email` checks format, reserved
//      names, skeleton uniqueness and active holds (held looks taken); `name` is bounded (64
//      characters, no control or bidi characters: it is the greeting of some e-mails);
//   4. `/delete-user` without the confirmation token requires the password;
//   5. the T3.3 guard (RL_AUTH → requester windows → Turnstile → per-account windows) on the
//      guarded paths (GET `/verify-email` included: per-IP window, no Turnstile). The Turnstile
//      token travels in the `x-turnstile-token` request header. Sign-in by e-mail or nickname of
//      an existing account is keyed on the user id (one per-account budget for both paths);
//   6. signed-in secret checks (auth/secret-guard.ts): admins with 2FA need the session's 2FA
//      marker for 2FA management; every password / second-factor check of a session counts
//      against the per-user limits; `/change-email` needs a fresh session (10 min) or the correct
//      current password (`password` in the body, verified here);
//   7. `/verify-email`: only strict compact JWS tokens pass; an e-mail-change token is single use,
//      claimed on its signed part (auth/link-uses.ts).
// after:
//   - wrong password / second factor of a session → counted toward the lockout budget;
//   - 2FA session marker after a successful TOTP / backup-code verification;
//   - "password changed" notice after `/change-password`;
//   - one `signup` Analytics Engine metric after a successful `/sign-up/email` (T5.2).
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { verifyJWT } from 'better-auth/crypto';
import { MAX_NEXT_LENGTH } from '#lib/components/auth/next.ts';
import { isNicknameHeld } from '../account/nickname.ts';
import { first, sql } from '../db.ts';
import type { ServerEnv } from '../env.ts';
import { recordSignup } from '../observability/metrics.ts';
import type { AuthGuard } from '../security/auth-guard.ts';
import { isAuthGuardedPath } from '../security/ratelimit.ts';
import type { AuthMailer } from './emails.ts';
import { claimLinkUse, isCompactJws, linkUseId } from './link-uses.ts';
import {
	beginSecretAttempt,
	checkUserPassword,
	recordSecretFailure,
	type SecretKind
} from './secret-guard.ts';
import {
	FRESH_SESSION_MS,
	hasTwoFactorMarker,
	isFreshSession,
	type PolicySession
} from './session-policy.ts';
import { checkUsername, normalizeUsername, usernameSkeleton } from './username.ts';

/** Request header carrying the Turnstile token to the auth endpoints (T3.6 sets it). */
export const TURNSTILE_HEADER = 'x-turnstile-token';

/**
 * Better Auth endpoints closed over HTTP because the app does not use them (Q3-7). Server-side
 * `auth.api.*` calls still reach them (tests, future server code). Kept open on purpose:
 * sign-in/up/out, get-session, verification and reset, change-email/password, delete-user (+
 * callback), the 2FA verification and enable/disable endpoints, and `/revoke-session(s)` /
 * `/revoke-other-sessions` (they only remove the caller's own sessions, like /conta does).
 */
export const CLOSED_AUTH_PATHS = [
	// The 2FA marker is a session field: no client-side session updates.
	'/update-session',
	// /conta edits the profile through its own actions; `name`/`image` would be unbounded here.
	'/update-user',
	// Exact-match probe (no confusables, no holds, no throttle); sign-up answers taken/held itself.
	'/is-username-available',
	// /conta lists and revokes sessions from D1.
	'/list-sessions',
	// A password oracle with no use in the app.
	'/verify-password',
	// The reset e-mail links to /redefinir-senha, which POSTs /reset-password.
	'/reset-password/:token',
	// Secrets of an enabled 2FA: shown once at enable time; nothing re-reads or regenerates them.
	'/two-factor/get-totp-uri',
	'/two-factor/generate-backup-codes',
	// No OTP delivery is configured.
	'/two-factor/send-otp',
	'/two-factor/verify-otp',
	// No social providers / linked accounts.
	'/sign-in/social',
	'/callback/:id',
	'/link-social',
	'/unlink-account',
	'/list-accounts',
	'/account-info',
	'/get-access-token',
	'/refresh-token'
] as const;

const CLOSED_PATHS: ReadonlySet<string> = new Set(CLOSED_AUTH_PATHS);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STATUS_NAME = {
	400: 'BAD_REQUEST',
	401: 'UNAUTHORIZED',
	403: 'FORBIDDEN',
	404: 'NOT_FOUND',
	429: 'TOO_MANY_REQUESTS',
	503: 'SERVICE_UNAVAILABLE'
} as const;

/** Paths whose success sets the session's 2FA marker. */
const TWO_FACTOR_VERIFY_PATHS = new Set([
	'/two-factor/verify-totp',
	'/two-factor/verify-backup-code'
]);
/** Second-factor checks: limited per user when they verify an existing session. */
const SECOND_FACTOR_PATHS = new Set([...TWO_FACTOR_VERIFY_PATHS, '/two-factor/verify-otp']);
/** Endpoints where Better Auth checks the current password of the session's user. */
const PASSWORD_PATHS = new Set([
	'/change-password',
	'/two-factor/enable',
	'/two-factor/disable',
	'/two-factor/get-totp-uri',
	'/two-factor/generate-backup-codes',
	'/verify-password'
]);
/** 2FA management: an admin with 2FA enabled needs the 2FA marker in this session. */
const TWO_FACTOR_MANAGEMENT_PATHS = new Set([
	'/two-factor/enable',
	'/two-factor/disable',
	'/two-factor/get-totp-uri',
	'/two-factor/generate-backup-codes'
]);
/** Better Auth error codes meaning "the secret was wrong". */
const WRONG_SECRET_CODES: Readonly<Record<SecretKind, ReadonlySet<string>>> = {
	password: new Set(['INVALID_PASSWORD']),
	'second-factor': new Set(['INVALID_CODE', 'INVALID_BACKUP_CODE'])
};

export const NAME_MAX = 64;

/** C0/C1 controls and bidirectional marks/overrides/isolates (they reorder e-mail greetings). */
function hasForbiddenNameChar(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x061c ||
			code === 0x200e ||
			code === 0x200f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			return true;
		}
	}
	return false;
}

export interface AuthHookDeps {
	/** `metrics` (T5.2) is optional: hooks built without it record no sign-up metric. */
	env: Pick<ServerEnv, 'db' | 'publicOrigin' | 'flags'> & Partial<Pick<ServerEnv, 'metrics'>>;
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

function limitedError(retryAfter: number): APIError {
	return new APIError(
		STATUS_NAME[429],
		{ code: 'RATE_LIMITED', message: 'RATE_LIMITED' },
		{ 'Retry-After': String(retryAfter) }
	);
}

/**
 * Identifier the guard keys its per-account limits on: the submitted name, never a lookup. Keying on
 * whether an account exists would make the (pre-Turnstile) `ip+id` window answer differently for
 * registered and unregistered names, i.e. an account-existence oracle (Q3 round 3). E-mail and
 * nickname sign-in share the rule group, so the same string spends one budget on both paths.
 */
function guardIdentifier(path: string, body: Body): string | null {
	if (path === '/sign-in/email') return text(body.email) ?? null;
	if (path === '/sign-in/username') return text(body.username) ?? null;
	if (path === '/change-email') return text(body.newEmail) ?? null;
	return text(body.email) ?? null;
}

/** Which secret a request checks for its session's user, if any. */
function secretKind(path: string, body: Body): SecretKind | null {
	if (SECOND_FACTOR_PATHS.has(path)) return 'second-factor';
	if (PASSWORD_PATHS.has(path)) return 'password';
	// Deletion by mailed token checks no password; `/change-email` checks one only when sent.
	if ((path === '/delete-user' || path === '/change-email') && text(body.password)) {
		return 'password';
	}
	return null;
}

/** `{ user, session }` of the request's session, loosely typed (plugin fields included). */
interface SessionView {
	user: Record<string, unknown> & { id: string; email: string };
	session: PolicySession;
}

function sessionView(value: unknown): SessionView | null {
	if (typeof value !== 'object' || value === null) return null;
	const { user, session } = value as { user?: unknown; session?: unknown };
	if (typeof user !== 'object' || user === null || typeof session !== 'object' || !session) {
		return null;
	}
	const record = user as Record<string, unknown>;
	if (typeof record.id !== 'string' || typeof record.email !== 'string') return null;
	return {
		user: record as SessionView['user'],
		session: session as PolicySession
	};
}

/** Code of a Better Auth APIError (`body.code`). */
function apiErrorCode(error: unknown): string | null {
	const body: unknown = Reflect.get(error as object, 'body');
	const code = typeof body === 'object' && body !== null ? Reflect.get(body, 'code') : undefined;
	return typeof code === 'string' ? code : null;
}

/**
 * Request fields Better Auth turns into a redirect (its `originCheck` reads the same names, from
 * the body and, for `callbackURL`, the query).
 */
export const CALLBACK_FIELDS = [
	'callbackURL',
	'redirectTo',
	'errorCallbackURL',
	'newUserCallbackURL'
] as const;

export const INVALID_CALLBACK_URL = 'INVALID_CALLBACK_URL';

/** Longest accepted redirect target: the same limit as the pages' `?next=` (Q3 round 3, m-c). */
export const MAX_CALLBACK_URL_LENGTH = MAX_NEXT_LENGTH;

/**
 * Whether `value` is a redirect target the app accepts: a path on PUBLIC_ORIGIN, relative (`/x?y`)
 * or absolute (`https://origin/x`), in canonical form. Refused (Q3 round 2, M2): anything that
 * resolves to another origin (`https://evil`, `//evil`), backslashes (`/\evil`: browsers read `\`
 * as `/`), whitespace and control characters, and paths the URL parser would rewrite: dot
 * segments (`/.//evil` resolves to the path `//evil`, which a later `pathname`-based Location turns
 * into a protocol-relative URL, as Better Auth's own `appendQueryParams` does), empty segments
 * (`//`), percent-encoded `/`, `\` or `.`, and characters the parser re-encodes. Values longer
 * than MAX_CALLBACK_URL_LENGTH are refused too: the callback ends up in mailed links.
 */
export function isSafeCallbackURL(value: string, publicOrigin: string): boolean {
	if (value === '' || value.length > MAX_CALLBACK_URL_LENGTH) return false;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		// Controls, space, DEL and `\`.
		if (code <= 0x20 || code === 0x7f || code === 0x5c) return false;
	}
	let origin: string;
	try {
		origin = new URL(publicOrigin).origin;
	} catch {
		return false;
	}
	let relative: string;
	if (value.startsWith('/')) relative = value;
	else if (value === origin) relative = '/';
	else if (value.startsWith(`${origin}/`)) relative = value.slice(origin.length);
	else return false;
	if (relative.startsWith('//')) return false;
	let url: URL;
	try {
		url = new URL(relative, origin);
	} catch {
		return false;
	}
	if (url.origin !== origin) return false;
	const rawPath = relative.split(/[?#]/, 1)[0] ?? '';
	return rawPath === url.pathname && !url.pathname.includes('//') && !/%(2f|5c|2e)/i.test(rawPath);
}

/**
 * Same answer shape as Better Auth's own link errors: back to the page (a safe `callbackURL`)
 * with `?error=<code>`; null when there is no callback (the caller answers JSON). The Location is
 * rebuilt as `pathname + search + hash` only after checking the resolved target is on
 * PUBLIC_ORIGIN and its path does not start with `//`; otherwise it is `/`.
 */
function errorRedirect(callbackURL: unknown, publicOrigin: string, code: string): APIError | null {
	if (typeof callbackURL !== 'string' || callbackURL === '') return null;
	let location = '/';
	if (isSafeCallbackURL(callbackURL, publicOrigin)) {
		const origin = new URL(publicOrigin).origin;
		const target = new URL(callbackURL, origin);
		if (target.origin === origin && !target.pathname.startsWith('//')) {
			target.searchParams.set('error', code);
			location = `${target.pathname}${target.search}${target.hash}`;
		}
	}
	return new APIError('FOUND', undefined, new Headers({ location }));
}

const USERNAME_TAKEN = 'USERNAME_IS_ALREADY_TAKEN';
export const USERNAME_CHANGE_NOT_ALLOWED = 'USERNAME_CHANGE_NOT_ALLOWED';
export const LINK_ALREADY_USED = 'LINK_ALREADY_USED';
/** Better Auth's code for a bad verification token (we answer it for malformed ones too). */
const INVALID_TOKEN = 'INVALID_TOKEN';
/** `requestType` of the change-email link mailed to the current address. */
const CHANGE_EMAIL_CONFIRMATION = 'change-email-confirmation';

/** Endpoints of Better Auth's admin plugin (all live under `/admin/`). */
export function isAdminPluginPath(path: string | undefined): boolean {
	return typeof path === 'string' && (path === '/admin' || path.startsWith('/admin/'));
}

export function createBeforeHook(deps: AuthHookDeps) {
	const now = deps.now ?? (() => new Date());
	return createAuthMiddleware(async (ctx) => {
		const request = ctx.request;
		const path = ctx.path;
		const body = asBody(ctx.body);
		const db = deps.env.db;

		if (request && (isAdminPluginPath(path) || CLOSED_PATHS.has(path))) {
			throw fail(404, 'NOT_FOUND', 'Not found');
		}

		if (request && !SAFE_METHODS.has(request.method)) {
			if (requestOrigin(request.headers) !== deps.env.publicOrigin) {
				throw fail(403, 'INVALID_ORIGIN', 'Invalid origin');
			}
		}

		// Redirect targets, on every endpoint and before Better Auth (whose own check accepts
		// `/.//host`): body and query alike. Same status and code as Better Auth's own refusal.
		const query = asBody(ctx.query);
		for (const source of [body, query]) {
			for (const field of CALLBACK_FIELDS) {
				const value = source[field];
				if (value === undefined || value === null || value === '') continue;
				if (typeof value !== 'string' || !isSafeCallbackURL(value, deps.env.publicOrigin)) {
					throw fail(403, INVALID_CALLBACK_URL, 'Invalid callback URL');
				}
			}
		}

		if (path === '/sign-up/email' && !deps.env.flags.signupEnabled) {
			throw fail(403, 'SIGNUP_DISABLED', 'Sign-up is disabled');
		}

		if (path === '/update-user' && ('username' in body || 'displayUsername' in body)) {
			throw fail(400, USERNAME_CHANGE_NOT_ALLOWED, 'The nickname changes only in the account area');
		}

		if ((path === '/sign-up/email' || path === '/update-user') && 'name' in body) {
			const name = body.name;
			if (typeof name !== 'string' || name.length > NAME_MAX || hasForbiddenNameChar(name)) {
				throw fail(400, 'INVALID_NAME', 'Invalid name');
			}
		}

		let signUpNickname: string | undefined;
		let signUpNicknameBlocked = false;
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
				// Format first: anything that is not a well-formed nickname is "invalid", blocked
				// or not, so the format answer never reveals the list (FUX.Q N3).
				const problem = checkUsername(username);
				if (problem === 'invalid') throw fail(400, 'INVALID_USERNAME', 'Invalid nickname');
				// Taken/held is answered only after the guard (Turnstile, limits): otherwise token-less
				// sign-ups would be an unthrottled nickname-existence oracle (Q3 round 3). A reserved
				// or blocked nickname is answered there too, as taken, so it is indistinguishable
				// from a taken one (before the guard it would be an unthrottled list probe).
				signUpNickname = username;
				signUpNicknameBlocked = problem === 'reserved';
			}
		}

		if (path === '/delete-user' && !text(body.token) && !text(body.password)) {
			throw fail(400, 'PASSWORD_REQUIRED', 'Password is required');
		}

		// The session is read at most once, and only by the steps that need it.
		let cached: Promise<SessionView | null> | undefined;
		const currentSession = (): Promise<SessionView | null> => {
			cached ??= getSessionFromCtx(ctx).then(sessionView);
			return cached;
		};

		if (isAuthGuardedPath(path)) {
			const headers = request?.headers ?? ctx.headers ?? new Headers();
			const userId = path === '/change-email' ? ((await currentSession())?.user.id ?? null) : null;
			const identifier = guardIdentifier(path, body);
			const result = await deps.guard({
				path,
				ip: headers.get('cf-connecting-ip'),
				email: identifier,
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

		if (signUpNickname !== undefined) {
			const row = await first<{ id: string }>(
				sql(
					db,
					'SELECT id FROM "user" WHERE usernameSkeleton = ? LIMIT 1',
					usernameSkeleton(signUpNickname)
				)
			);
			// A reserved or blocked nickname, and one on its 90-day hold, answer exactly like a
			// taken one (same place, after the same lookup).
			if (
				signUpNicknameBlocked ||
				row ||
				(await isNicknameHeld(db, signUpNickname, now().getTime()))
			) {
				throw fail(400, USERNAME_TAKEN, 'Nickname is already taken');
			}
		}

		const kind = secretKind(path, body);
		if (kind || path === '/change-email' || TWO_FACTOR_MANAGEMENT_PATHS.has(path)) {
			// Without a session Better Auth answers 401 itself, or (second factor) runs the sign-in
			// challenge, which has its own per-challenge and per-account lockout.
			const current = await currentSession();
			if (current) {
				const at = now();
				const { user, session } = current;
				if (
					TWO_FACTOR_MANAGEMENT_PATHS.has(path) &&
					user.role === 'admin' &&
					user.twoFactorEnabled === true &&
					!hasTwoFactorMarker(session)
				) {
					throw fail(403, 'TWO_FACTOR_REQUIRED', 'Verify the second factor first');
				}
				if (path === '/change-email') {
					const password = text(body.password);
					if (password) {
						const check = await checkUserPassword(db, user.id, password, at);
						if (check.result === 'limited') throw limitedError(check.retryAfter ?? 60);
						if (check.result === 'unavailable') {
							throw fail(503, 'RATE_LIMIT_UNAVAILABLE', 'RATE_LIMIT_UNAVAILABLE');
						}
						if (check.result === 'wrong') throw fail(400, 'INVALID_PASSWORD', 'Invalid password');
					} else if (!isFreshSession(session, FRESH_SESSION_MS, at.getTime())) {
						throw fail(403, 'SESSION_NOT_FRESH', 'Session is not fresh enough for this action');
					}
				} else if (kind) {
					const attempt = await beginSecretAttempt(db, kind, user.id, at);
					if (!attempt.ok) {
						if (attempt.status === 429) throw limitedError(attempt.retryAfter);
						throw fail(503, 'RATE_LIMIT_UNAVAILABLE', 'RATE_LIMIT_UNAVAILABLE');
					}
				}
			}
		}

		if (path === '/verify-email') {
			const rawToken = query.token;
			// Only strict compact JWS reach Better Auth: jose would also accept the same token with
			// whitespace or other padding characters in its signature (Q3 round 2, M1).
			if (rawToken !== undefined && (typeof rawToken !== 'string' || !isCompactJws(rawToken))) {
				throw (
					errorRedirect(query.callbackURL, deps.env.publicOrigin, INVALID_TOKEN) ??
					fail(401, INVALID_TOKEN, 'Invalid token')
				);
			}
			const token = text(rawToken);
			const payload = token ? await verifyJWT(token, ctx.context.secret) : null;
			const owner = text(payload?.email);
			const updateTo = text(payload?.updateTo);
			if (token && payload && owner && updateTo) {
				// Claim only a link Better Auth is about to act on, so a link opened in the wrong
				// browser (signed in as someone else) still works afterwards in the right one.
				const found = await ctx.context.internalAdapter.findUserByEmail(owner);
				const current = await currentSession();
				if (found && (!current || current.user.email === owner)) {
					const expiresAt = typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
					let linkId: string;
					let firstUse: boolean;
					try {
						// Keyed on the signed part, so every spelling of one token is one link.
						linkId = await linkUseId(token);
						firstUse = await claimLinkUse(db, linkId, expiresAt, now().getTime());
					} catch {
						throw fail(503, 'SERVICE_UNAVAILABLE', 'Try again later');
					}
					if (!firstUse) {
						throw (
							errorRedirect(query.callbackURL, deps.env.publicOrigin, LINK_ALREADY_USED) ??
							fail(400, LINK_ALREADY_USED, 'This link was already used')
						);
					}
					if (payload.requestType === CHANGE_EMAIL_CONFIRMATION) {
						// Better Auth now mails the new address; key that mail on this link.
						deps.mailer.noteChangeConfirmation(found.user.id, updateTo, linkId);
					}
				}
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

		if (isAPIError(returned)) {
			// Wrong secret checked for a session (a sign-in 2FA challenge has no session here and is
			// counted by Better Auth's own lockout). `/change-email` is counted in the before hook.
			const kind = secretKind(ctx.path, asBody(ctx.body));
			const code = apiErrorCode(returned);
			if (kind && ctx.path !== '/change-email' && code && WRONG_SECRET_CODES[kind].has(code)) {
				const userId = sessionView(ctx.context.session)?.user.id;
				if (userId) await recordSecretFailure(deps.env.db, kind, userId, now());
			}
			return;
		}
		if (returned === undefined || returned === null) return;
		if (returned instanceof Response && !returned.ok) return;

		if (ctx.path === '/sign-up/email') {
			// T5.2: one `signup` metric per accepted sign-up (no user id, address or name).
			if (returnedUser(returned)) recordSignup(deps.env.metrics, 'email');
			return;
		}

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
