// Server-side shapes shared by hooks, endpoints and server modules.
//
// `Env` is written by hand instead of using `wrangler types`: the generated file declares the
// Workers runtime as globals (clashing with lib.dom used by client code and component tests) and
// pulls the build output into the program. The module form of @cloudflare/workers-types exports
// the same types without touching globals. test/tools/render-wrangler.test.mjs fails when this
// interface drifts from web/wrangler.template.jsonc (bindings + vars, every environment) or from
// the secret list in tools/render-wrangler.mjs.
import type {
	AnalyticsEngineDataset,
	CacheStorage,
	D1Database,
	ExecutionContext,
	Fetcher,
	IncomingRequestCfProperties,
	KVNamespace,
	Queue,
	R2Bucket,
	RateLimit
} from '@cloudflare/workers-types';

export interface Env {
	// Bindings (wrangler.template.jsonc)
	ASSETS: Fetcher;
	DB: D1Database;
	CONFIG: KVNamespace;
	MEDIA: R2Bucket;
	ACCESS_LOG_QUEUE: Queue;
	RL_AUTH: RateLimit;
	RL_API: RateLimit;
	RL_WRITE: RateLimit;
	/** Analytics Engine metrics (T5.2); optional: absent in tests and local dev (no-op). */
	METRICS?: AnalyticsEngineDataset;
	// Vars (wrangler.template.jsonc), always strings
	PUBLIC_ORIGIN: string;
	GITHUB_URL: string;
	ACCESS_LOG_ENABLED: string;
	SIGNUP_ENABLED: string;
	ADMIN_2FA_REQUIRED: string;
	RESEND_FROM: string;
	/** `resend` (default) | `capture` (local e2e only; refused by getServerEnv elsewhere). */
	EMAIL_TRANSPORT: string;
	// Secrets (wrangler secret / .dev.vars; tools/render-wrangler.mjs SECRETS)
	BETTER_AUTH_SECRET: string;
	RESEND_API_KEY: string;
	TURNSTILE_SECRET: string;
	IPHASH_PEPPER: string;
	ACCESS_LOG_KEY: string;
	RESEND_WEBHOOK_SECRET?: string;
}

/**
 * `event.platform`. Kit 3's adapter-cloudflare does not pass one: hooks.server.ts rebuilds it from
 * `cloudflare:workers` (`env`, `waitUntil`). Only `ctx.waitUntil` is used by the app.
 */
export interface WorkerPlatform {
	env: Env;
	ctx: Pick<ExecutionContext, 'waitUntil'>;
	caches?: CacheStorage;
	cf?: IncomingRequestCfProperties;
}

// Minimal request-scoped auth shapes for `App.Locals`. hooks.server.ts maps Better Auth's
// user/session onto these (web/src/lib/server/auth.ts `toAuthLocals`); nothing here carries
// secrets or tokens (the session token is deliberately left out).

export type UserRole = 'user' | 'admin';

export interface AuthUser {
	id: string;
	email: string;
	/** Private account name (never shown publicly; the public name is `username`). */
	name: string;
	emailVerified: boolean;
	role: UserRole;
	/** Public nickname, normalized (NFKC + lowercase); null until chosen. */
	username: string | null;
	displayUsername: string | null;
	banned: boolean;
	twoFactorEnabled: boolean;
}

export interface AuthSession {
	id: string;
	userId: string;
	createdAt: Date;
	expiresAt: Date;
	/** When the second factor was passed in this session (TOTP or backup code), else null. */
	twoFactorVerifiedAt: Date | null;
	/** Shorthand for `twoFactorVerifiedAt !== null`. */
	twoFactorVerified: boolean;
	/** Admin id when this is an impersonation session (admin plugin). */
	impersonatedBy: string | null;
}
