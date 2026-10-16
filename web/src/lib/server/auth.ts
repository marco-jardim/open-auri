// Better Auth for open-auri (T3.5). One instance per request: the Workers env (D1, secrets,
// flags) is only known per request, so nothing here keeps env at module level. No `$app/*`
// imports: hooks.server.ts passes the SvelteKit pieces in (`sveltekitCookies` as the last plugin),
// and the integration tests drive `auth.handler(request)` directly inside workerd.
//
// Decisions (details in web/src/lib/server/auth/README.md):
// - D1 natively (`database: env.DB`, Kysely D1 dialect, no interactive transactions). The
//   schema is hand-written in migrations/0001_auth.sql; runtime schema introspection is off
//   (it would run on every request with per-request instances) and a test checks it instead.
// - Passwords: scrypt in auth/password.ts (PF3). Rate limiting: Better Auth's is off; the T3.3
//   guard runs in `hooks.before` (auth/hooks.ts) together with Turnstile and the sign-up switch,
//   and so do the per-user limits on password / second-factor checks (auth/secret-guard.ts) and
//   the freshness rule of the sensitive endpoints (Better Auth's freshAge does not cover them).
// - No IP stored (`disableIpTracking`), session user agent reduced to browser + OS.
// - Cookies: HttpOnly, SameSite=Lax, Secure (and `__Secure-` names) when the origin is https.
// - Session freshness 10 min (`freshAge`, plus the hook rule above); no cookie cache (every
//   request reads D1, so revocation and bans apply immediately).
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import { admin } from 'better-auth/plugins/admin';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { username } from 'better-auth/plugins/username';
import { emailChangeRequestedAt } from './account/email-change.ts';
import { batch } from './db.ts';
import { createEmailProvider, type EmailProvider } from './email/index.ts';
import type { ServerEnv } from './env.ts';
import { deleteAcceptancesStatement } from './legal/acceptance.ts';
import { createAuthGuard, type AuthGuard } from './security/auth-guard.ts';
import type { AuthSession, AuthUser } from './types.ts';
import { createAuthMailer, LINK_TTL_SECONDS } from './auth/emails.ts';
import {
	CLOSED_AUTH_PATHS,
	createAfterHook,
	createBeforeHook,
	USERNAME_CHANGE_NOT_ALLOWED
} from './auth/hooks.ts';
import { createAuthLogger, type AuthLogEntry } from './auth/logger.ts';
import { MAX_PASSWORD_LENGTH, passwordHasher } from './auth/password.ts';
import { FRESH_SESSION_MS } from './auth/session-policy.ts';
import { reduceUserAgent } from './auth/user-agent.ts';
import {
	isValidUsername,
	normalizeUsername,
	USERNAME_MAX,
	USERNAME_MIN,
	usernameSkeleton
} from './auth/username.ts';

export {
	FRESH_SESSION_MS,
	hasTwoFactorMarker,
	isAdminEffective,
	isFreshSession,
	requireFreshSession,
	StaleSessionError
} from './auth/session-policy.ts';
export {
	CLOSED_AUTH_PATHS,
	isAdminPluginPath,
	TURNSTILE_HEADER,
	USERNAME_CHANGE_NOT_ALLOWED
} from './auth/hooks.ts';

export const AUTH_BASE_PATH = '/api/auth';
export const MIN_PASSWORD_LENGTH = 10;
export { MAX_PASSWORD_LENGTH };

/** The user being deleted, as Better Auth hands it to `beforeDelete`. */
export interface DeletedUser {
	id: string;
	email: string;
}

/**
 * Content-deletion policy hook (T3.7 replaces the default with the full policy: keep CC content
 * anonymized or delete it, always delete private content). Runs before the user row is deleted;
 * throwing aborts the deletion.
 */
export type BeforeDeleteUser = (user: DeletedUser) => Promise<void>;

/** F3 default: drop the policy acknowledgements (the only per-user rows outside the auth tables). */
export function defaultBeforeDeleteUser(db: ServerEnv['db']): BeforeDeleteUser {
	return async (user) => {
		await batch(db, [deleteAcceptancesStatement(db, user.id)]);
	};
}

export interface CreateAuthOptions {
	/** `platform.ctx.waitUntil`: e-mails are delivered after the response. */
	waitUntil: (promise: Promise<unknown>) => void;
	/** Extra plugins, appended last (hooks.server.ts passes `sveltekitCookies(getRequestEvent)`). */
	plugins?: BetterAuthPlugin[];
	/** Defaults to PUBLIC_ORIGIN. */
	baseURL?: string;
	beforeDeleteUser?: BeforeDeleteUser;
	/**
	 * The T3.8 read-only switch is on (`isReadOnly(env)`): Better Auth's session refresh (the
	 * `expiresAt` write of `getSession` once `updateAge` passed) is turned off for this instance.
	 * Other session writes of a GET remain (see admin/README.md, "Read-only switch").
	 */
	readOnly?: boolean;
	/** Test seams. */
	emailProvider?: EmailProvider;
	guard?: AuthGuard;
	log?: (entry: AuthLogEntry) => void;
	now?: () => Date;
}

function isHttps(origin: string): boolean {
	try {
		return new URL(origin).protocol === 'https:';
	} catch {
		return false;
	}
}

type Row = Record<string, unknown>;

/** Adds the confusable skeleton whenever a nickname is written (unique index in 0001). */
function withSkeleton<T extends object>(data: T): T {
	if (!('username' in data)) return data;
	const value = (data as Row).username;
	return {
		...data,
		usernameSkeleton: typeof value === 'string' && value !== '' ? usernameSkeleton(value) : null
	} as T;
}

export function createAuth(env: ServerEnv, options: CreateAuthOptions) {
	const baseURL = options.baseURL ?? env.publicOrigin;
	const secure = isHttps(baseURL);
	const mailer = createAuthMailer({
		provider: options.emailProvider ?? createEmailProvider(env),
		origin: env.publicOrigin,
		waitUntil: options.waitUntil,
		emailChangeRequestedAt: (userId, newEmail) =>
			emailChangeRequestedAt(env.db, userId, newEmail, options.now?.().getTime())
	});
	const guard = options.guard ?? createAuthGuard({ env });
	const beforeDeleteUser = options.beforeDeleteUser ?? defaultBeforeDeleteUser(env.db);
	const hookDeps = { env, guard, mailer, ...(options.now ? { now: options.now } : {}) };

	return betterAuth({
		appName: 'open-auri',
		baseURL,
		basePath: AUTH_BASE_PATH,
		secret: env.secrets.betterAuthSecret,
		database: env.db,
		trustedOrigins: [env.publicOrigin],
		telemetry: { enabled: false },
		logger: createAuthLogger(options.log),
		// Better Auth's limiter is off: the T3.3 guard and the per-user secret limits
		// (auth/secret-guard.ts) in hooks.before replace it, including its `/two-factor/*` throttle.
		rateLimit: { enabled: false },
		// Endpoints the app does not use answer 404 over HTTP (Q3-7; list and reasons in
		// auth/hooks.ts CLOSED_AUTH_PATHS). The router matches literal paths only, so the hook also
		// closes the parameterized ones.
		disabledPaths: CLOSED_AUTH_PATHS.filter((path) => !path.includes(':')),

		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			minPasswordLength: MIN_PASSWORD_LENGTH,
			maxPasswordLength: MAX_PASSWORD_LENGTH,
			password: passwordHasher,
			autoSignIn: false,
			resetPasswordTokenExpiresIn: LINK_TTL_SECONDS.resetPassword,
			revokeSessionsOnPasswordReset: true,
			sendResetPassword: async ({ user, token }, request) => {
				await mailer.resetPassword(user, token, request);
			},
			onPasswordReset: async ({ user }, request) => {
				await mailer.passwordChanged(user, `reset:${Date.now()}`, request);
			}
		},

		emailVerification: {
			sendOnSignUp: true,
			sendOnSignIn: false,
			// Opening the sign-up verification link does not sign anyone in: the user signs in with the
			// password. Exception (Better Auth behaviour, documented in auth/README.md): the final
			// change-email link, opened without a session, signs its opener in to the account, since
			// the change was already approved from the current mailbox. That link is single-use.
			autoSignInAfterVerification: false,
			expiresIn: LINK_TTL_SECONDS.verification,
			sendVerificationEmail: async ({ user, url, token }, request) => {
				await mailer.verification(user, url, token, request);
			}
		},

		user: {
			additionalFields: {
				usernameSkeleton: {
					type: 'string',
					required: false,
					input: false,
					returned: false,
					unique: true
				}
			},
			changeEmail: {
				enabled: true,
				// Verified users: the CURRENT address confirms first, then the new one verifies.
				sendChangeEmailConfirmation: async ({ user, url, token }, request) => {
					await mailer.changeEmailConfirmation(user, url, token, request);
				}
			},
			deleteUser: {
				enabled: true,
				deleteTokenExpiresIn: LINK_TTL_SECONDS.deleteAccount,
				sendDeleteAccountVerification: async ({ user, url, token }, request) => {
					await mailer.confirmAccountDeletion(user, url, token, request);
				},
				beforeDelete: async (user) => {
					await beforeDeleteUser({ id: user.id, email: user.email });
				},
				afterDelete: async (user, request) => {
					await mailer.accountDeleted(user, request);
				}
			}
		},

		session: {
			freshAge: FRESH_SESSION_MS / 1000,
			cookieCache: { enabled: false },
			// One instance per request, so this follows the read-only switch of that request.
			disableSessionRefresh: options.readOnly === true,
			additionalFields: {
				twoFactorVerifiedAt: { type: 'date', required: false, input: false }
			}
		},

		databaseHooks: {
			user: {
				create: { before: async (user) => ({ data: withSkeleton(user) }) },
				// Nickname changes must go through account/nickname.ts (30-day interval, 90-day holds),
				// which writes D1 directly. Any Better Auth endpoint that would write the nickname
				// (`/update-user`, the admin plugin's `/admin/update-user`, even server-side) is
				// refused here; internal updates outside an endpoint keep the skeleton in sync.
				update: {
					before: async (user, context) => {
						if (context && ('username' in user || 'displayUsername' in user)) {
							throw APIError.from('BAD_REQUEST', {
								code: USERNAME_CHANGE_NOT_ALLOWED,
								message: 'The nickname changes only in the account area'
							});
						}
						return { data: withSkeleton(user) };
					}
				}
			},
			session: {
				create: {
					before: async (session) => ({
						data: { ...session, ipAddress: null, userAgent: reduceUserAgent(session.userAgent) }
					})
				}
			}
		},

		advanced: {
			ipAddress: { disableIpTracking: true },
			// Cookie names `open-auri.*` (`__Secure-open-auri.*` on https); appName does not set them.
			cookiePrefix: 'open-auri',
			useSecureCookies: secure,
			defaultCookieAttributes: { httpOnly: true, secure, sameSite: 'lax', path: '/' },
			disableCSRFCheck: false,
			disableOriginCheck: false,
			database: { validateSchema: false }
		},

		hooks: {
			before: createBeforeHook(hookDeps),
			after: createAfterHook(hookDeps)
		},

		plugins: [
			username({
				minUsernameLength: USERNAME_MIN,
				maxUsernameLength: USERNAME_MAX,
				usernameNormalization: normalizeUsername,
				usernameValidator: (value) => isValidUsername(normalizeUsername(value)),
				validationOrder: { username: 'post-normalization', displayUsername: 'pre-normalization' }
			}),
			admin({ defaultRole: 'user', adminRoles: ['admin'] }),
			twoFactor({ issuer: 'open-auri' }),
			...(options.plugins ?? [])
		]
	});
}

export type Auth = ReturnType<typeof createAuth>;

function toDate(value: unknown): Date | null {
	if (value === null || value === undefined) return null;
	const date = value instanceof Date ? value : new Date(value as string | number);
	return Number.isFinite(date.getTime()) ? date : null;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/** Maps `auth.api.getSession()` output to `App.Locals` (null when signed out or malformed). */
export function toAuthLocals(result: unknown): { user: AuthUser; session: AuthSession } | null {
	if (typeof result !== 'object' || result === null) return null;
	const { user, session } = result as { user?: Row; session?: Row };
	if (!user || !session) return null;
	const id = str(user.id);
	const email = str(user.email);
	const sessionId = str(session.id);
	const createdAt = toDate(session.createdAt);
	const expiresAt = toDate(session.expiresAt);
	if (!id || !email || !sessionId || !createdAt || !expiresAt || session.userId !== id) return null;
	const twoFactorVerifiedAt = toDate(session.twoFactorVerifiedAt);
	return {
		user: {
			id,
			email,
			name: typeof user.name === 'string' ? user.name : '',
			emailVerified: user.emailVerified === true,
			role: user.role === 'admin' ? 'admin' : 'user',
			username: str(user.username),
			displayUsername: str(user.displayUsername),
			banned: user.banned === true,
			twoFactorEnabled: user.twoFactorEnabled === true
		},
		session: {
			id: sessionId,
			userId: id,
			createdAt,
			expiresAt,
			twoFactorVerifiedAt,
			twoFactorVerified: twoFactorVerifiedAt !== null,
			impersonatedBy: str(session.impersonatedBy)
		}
	};
}
