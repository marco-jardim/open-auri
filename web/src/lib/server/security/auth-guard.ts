// Pre-handler guard for the Better Auth endpoints (plan T3.5 items 6 and 8). Pure with respect to
// the request: T3.5 calls it from a `hooks.before` middleware with the path, the client IP, the
// identifier from the body and the Turnstile token, and maps a failure to an APIError.
//
// Order: coarse per-IP binding (RL_AUTH) → D1 window rules keyed on the requester (`ip`, `ip+id`,
// `user`) → Turnstile → D1 window rules keyed on a third party's identifier (`id`). Requester rules
// run first so floods are rejected before any outbound Siteverify call; the per-account `id` rules
// (e.g. 10 sign-ins per 5 min per e-mail) are counted only for requests that passed Turnstile, so
// token-less or invalid-token requests can never lock someone else's account. A requester rule
// cannot be spent by a third party: its key contains the requester's own IP or session. Routes
// without Turnstile (resend verification) count their `id` rules right after the requester rules:
// there, the `id` rules are the mailbox's flood budget. Every dependency failure (KV salt,
// binding, D1, Siteverify) fails closed with 503.
import type { RateLimit } from '@cloudflare/workers-types';
import type { ServerEnv } from '../env.ts';
import { createKeyedHasher, getDailySalt, InvalidIpError, type KeyedHasher } from './iphash.ts';
import {
	AUTH_POLICIES,
	authRateLimit,
	isAuthGuardedPath,
	isRequesterScope,
	normalizeIdentifier,
	rateLimit as defaultRateLimit,
	rateLimitKey,
	slidingWindowLimit as defaultWindowLimit,
	type AuthWindowRule,
	type WindowRule
} from './ratelimit.ts';
import { localTestTurnstile, verifyTurnstile as defaultVerifyTurnstile } from './turnstile.ts';

export type AuthGuardCode =
	| 'RATE_LIMITED'
	| 'RATE_LIMIT_UNAVAILABLE'
	| 'TURNSTILE_REQUIRED'
	| 'TURNSTILE_FAILED'
	| 'TURNSTILE_UNAVAILABLE';

export type AuthGuardResult =
	| { ok: true }
	| { ok: false; status: 400 | 403 | 429 | 503; code: AuthGuardCode; retryAfter?: number };

export interface AuthGuardInput {
	/** Better Auth `ctx.path`, e.g. `/sign-in/email`. Unguarded paths pass through. */
	path: string;
	/** Client IP (`cf-connecting-ip`); only hashed here, never stored or logged. */
	ip: string | null;
	/**
	 * Identifier of the per-account rules: e-mail (or username for `/sign-in/username`; the new
	 * e-mail for `/change-email`). The auth hook passes `user:<id>` for a sign-in to an existing
	 * account, so both sign-in paths share one budget per account.
	 */
	email?: string | null;
	/** Signed-in user, when there is one (`/change-email`). */
	userId?: string | null;
	/** `cf-turnstile-response` from the request. */
	turnstileToken?: string | null;
}

export interface AuthGuardLogEvent {
	event: 'auth_guard.denied';
	group: string;
	code: AuthGuardCode;
}

export interface AuthGuardDeps {
	/** `getServerEnv(platform)` satisfies this; tests may pass narrower fakes. */
	env: {
		db: ServerEnv['db'];
		config: Pick<ServerEnv['config'], 'get' | 'put'>;
		rateLimit: { auth: Pick<RateLimit, 'limit'> };
		publicOrigin: string;
		secrets: Pick<ServerEnv['secrets'], 'iphashPepper' | 'turnstileSecret'>;
		/** With `capture` on a localhost origin the local Turnstile stub replaces Siteverify. */
		emailTransport?: ServerEnv['emailTransport'];
	};
	verifyTurnstile?: typeof defaultVerifyTurnstile;
	rateLimit?: typeof defaultRateLimit;
	windowLimit?: typeof defaultWindowLimit;
	/** Expected Turnstile hostname; defaults to the hostname of PUBLIC_ORIGIN. */
	turnstileHostname?: string;
	now?: () => Date;
	/** Receives denial events (no IP, e-mail or token); defaults to a structured console line. */
	log?: (event: AuthGuardLogEvent) => void;
}

/** Hash material for requests without a usable IP (local tools): they share one bucket. */
const NO_IP_MATERIAL = 'ip:none';

async function hashIp(hasher: KeyedHasher, ip: string | null): Promise<string> {
	if (!ip) return hasher.value(NO_IP_MATERIAL);
	try {
		return await hasher.ip(ip);
	} catch (error) {
		if (error instanceof InvalidIpError) return hasher.value(NO_IP_MATERIAL);
		throw error;
	}
}

export function createAuthGuard(deps: AuthGuardDeps) {
	// Local e2e only (EMAIL_TRANSPORT=capture on localhost): see turnstile.ts localTestTurnstile.
	const verify = deps.verifyTurnstile ?? localTestTurnstile(deps.env) ?? defaultVerifyTurnstile;
	const limitBinding = deps.rateLimit ?? defaultRateLimit;
	const limitWindows = deps.windowLimit ?? defaultWindowLimit;
	const now = deps.now ?? (() => new Date());
	const log =
		deps.log ?? ((event: AuthGuardLogEvent) => console.warn(JSON.stringify({ ...event })));
	const hostname = deps.turnstileHostname ?? new URL(deps.env.publicOrigin).hostname;

	return async function guard(input: AuthGuardInput): Promise<AuthGuardResult> {
		if (!isAuthGuardedPath(input.path)) return { ok: true };
		const policy = AUTH_POLICIES[input.path];
		const deny = (
			status: 400 | 403 | 429 | 503,
			code: AuthGuardCode,
			retryAfter?: number
		): AuthGuardResult => {
			log({ event: 'auth_guard.denied', group: policy.group, code });
			return retryAfter === undefined
				? { ok: false, status, code }
				: { ok: false, status, code, retryAfter };
		};

		const at = now();
		let ipHash: string;
		let idHash: string | null = null;
		let ipIdHash: string | null = null;
		try {
			const salt = await getDailySalt(deps.env.config, at);
			const hasher = await createKeyedHasher({ pepper: deps.env.secrets.iphashPepper, salt });
			ipHash = await hashIp(hasher, input.ip);
			const identifier = input.email ? normalizeIdentifier(input.email) : '';
			if (identifier) {
				idHash = await hasher.value(`id:${identifier}`);
				ipIdHash = await hasher.value(`ip+id:${ipHash}:${identifier}`);
			}
		} catch {
			return deny(503, 'RATE_LIMIT_UNAVAILABLE');
		}

		const coarse = await limitBinding(deps.env.rateLimit.auth, rateLimitKey.ip('auth', ipHash));
		if (!coarse.ok) {
			return coarse.reason === 'limited'
				? deny(429, 'RATE_LIMITED', 60)
				: deny(503, 'RATE_LIMIT_UNAVAILABLE');
		}

		let rules: AuthWindowRule[];
		try {
			rules =
				authRateLimit({ path: input.path, ipHash, idHash, ipIdHash, userId: input.userId }) ?? [];
		} catch {
			// RateLimitKeyError (e.g. an unexpected user id shape): fail closed.
			return deny(503, 'RATE_LIMIT_UNAVAILABLE');
		}
		const requesterRules: WindowRule[] = rules.filter((rule) => isRequesterScope(rule.scope));
		const accountRules: WindowRule[] = rules.filter((rule) => !isRequesterScope(rule.scope));
		const checkWindows = async (batch: WindowRule[]): Promise<AuthGuardResult | null> => {
			if (batch.length === 0) return null;
			const windows = await limitWindows(deps.env.db, batch, at);
			if (windows.ok) return null;
			return windows.reason === 'limited'
				? deny(429, 'RATE_LIMITED', windows.retryAfter)
				: deny(503, 'RATE_LIMIT_UNAVAILABLE');
		};

		const requesterDenied = await checkWindows(requesterRules);
		if (requesterDenied) return requesterDenied;

		if (policy.turnstileAction) {
			if (!input.turnstileToken) return deny(400, 'TURNSTILE_REQUIRED');
			const result = await verify({
				token: input.turnstileToken,
				action: policy.turnstileAction,
				hostname,
				secret: deps.env.secrets.turnstileSecret
			});
			if (!result.ok) {
				if (result.reason === 'unavailable') return deny(503, 'TURNSTILE_UNAVAILABLE');
				if (result.reason === 'missing') return deny(400, 'TURNSTILE_REQUIRED');
				return deny(403, 'TURNSTILE_FAILED');
			}
		}

		const accountDenied = await checkWindows(accountRules);
		if (accountDenied) return accountDenied;
		return { ok: true };
	};
}

export type AuthGuard = ReturnType<typeof createAuthGuard>;
