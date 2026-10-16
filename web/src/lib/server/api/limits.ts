// Rate limits and Turnstile of /api/v1.
//
// - Burst guard: Workers RateLimit binding, RL_API for reads and RL_WRITE for writes, keyed by
//   `<group>` + user id when signed in, else + the daily-salted IP hash (never the raw IP).
// - Quotas (optional): D1 sliding windows (`slidingWindowLimit`), same subject, default window one
//   day. Only for writes worth an exact global count (publish, report...).
// Fails closed: a binding, KV or D1 failure answers 503 `RATE_LIMIT_UNAVAILABLE`.
import type { RateLimit } from '@cloudflare/workers-types';
import type { ServerEnv } from '../env.ts';
import { createKeyedHasher, getDailySalt, InvalidIpError, ipHash } from '../security/iphash.ts';
import {
	rateLimit,
	rateLimitKey,
	slidingWindowLimit,
	type RateLimitKey,
	type WindowRule
} from '../security/ratelimit.ts';
import {
	localTestTurnstile,
	verifyTurnstile,
	type TurnstileAction
} from '../security/turnstile.ts';
import type { AuthLocals } from '../auth/guards.ts';
import { ApiError } from './errors.ts';

/** Retry-After sent when the burst binding refuses (its period, seconds). */
export const BINDING_RETRY_AFTER = 60;
const DAY_SECONDS = 86_400;
/** Hashed in place of an IP when `cf-connecting-ip` is missing or invalid (one shared bucket). */
const NO_IP_MATERIAL = 'api:no-ip';

export type ApiRateKind = 'read' | 'write';

export interface ApiQuota {
	limit: number;
	/** Window in seconds (default 86 400: a daily quota). */
	windowSeconds?: number;
}

export interface ApiRateRule {
	/** Route group in keys, e.g. `api.curves.publish` ([a-z0-9][a-z0-9_.:-]{0,63}). */
	group: string;
	/** `read` → RL_API, `write` → RL_WRITE. */
	kind: ApiRateKind;
	quotas?: readonly ApiQuota[];
}

/** The part of ServerEnv the limiter uses (a ServerEnv is one). */
export interface ApiLimitEnv {
	db: ServerEnv['db'];
	config: Pick<ServerEnv['config'], 'get' | 'put'>;
	rateLimit: { api: Pick<RateLimit, 'limit'>; write: Pick<RateLimit, 'limit'> };
	secrets: Pick<ServerEnv['secrets'], 'iphashPepper'>;
}

export interface ApiLimitEvent {
	request: Request;
	locals: AuthLocals;
}

function unavailable(cause?: unknown): ApiError {
	return new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', undefined, { cause });
}

function limited(retryAfter: number): ApiError {
	return new ApiError(429, 'RATE_LIMITED', undefined, {
		headers: { 'retry-after': String(retryAfter) }
	});
}

async function clientHash(env: ApiLimitEnv, request: Request, now: Date): Promise<string> {
	const salt = await getDailySalt(env.config, now);
	const pepper = env.secrets.iphashPepper;
	const ip = request.headers.get('cf-connecting-ip');
	if (ip) {
		try {
			return await ipHash(ip, { pepper, salt });
		} catch (error) {
			if (!(error instanceof InvalidIpError)) throw error;
		}
	}
	return (await createKeyedHasher({ pepper, salt })).value(NO_IP_MATERIAL);
}

/** Key builder for one group: user id when signed in, else the IP hash. */
async function subjectKey(
	env: ApiLimitEnv,
	event: ApiLimitEvent,
	now: Date
): Promise<(group: string) => RateLimitKey> {
	const { user, session } = event.locals;
	if (user && session && session.userId === user.id) {
		const id = user.id;
		return (group) => rateLimitKey.user(group, id);
	}
	const hash = await clientHash(env, event.request, now);
	return (group) => rateLimitKey.ip(group, hash);
}

/**
 * Burst guard (+ optional quotas). Throws 429 `RATE_LIMITED` with `retry-after`, or 503
 * `RATE_LIMIT_UNAVAILABLE` when a binding, the salt store or D1 fails.
 */
export async function apiRateLimit(
	env: ApiLimitEnv,
	event: ApiLimitEvent,
	rule: ApiRateRule,
	now: Date = new Date()
): Promise<void> {
	let keyOf: (group: string) => RateLimitKey;
	let burstKey: RateLimitKey;
	let quotaRules: WindowRule[];
	try {
		keyOf = await subjectKey(env, event, now);
		burstKey = keyOf(rule.group);
		quotaRules = (rule.quotas ?? []).map((quota, index) => ({
			key: keyOf(`${rule.group}.q${index}`),
			limit: quota.limit,
			windowSeconds: quota.windowSeconds ?? DAY_SECONDS
		}));
	} catch (error) {
		// SaltUnavailableError, RateLimitKeyError (bad group or user id shape): fail closed.
		throw unavailable(error);
	}

	const binding = rule.kind === 'write' ? env.rateLimit.write : env.rateLimit.api;
	const burst = await rateLimit(binding, burstKey);
	if (!burst.ok) throw burst.reason === 'limited' ? limited(BINDING_RETRY_AFTER) : unavailable();

	if (quotaRules.length === 0) return;
	let windows: Awaited<ReturnType<typeof slidingWindowLimit>>;
	try {
		windows = await slidingWindowLimit(env.db, quotaRules, now);
	} catch (error) {
		// RangeError from a non-integer window: a route bug, still fail closed.
		throw unavailable(error);
	}
	if (windows.ok) return;
	throw windows.reason === 'limited' ? limited(windows.retryAfter) : unavailable();
}

export const TURNSTILE_HEADER = 'x-turnstile-token';

/** The part of ServerEnv Turnstile uses (a ServerEnv is one). */
export interface ApiTurnstileEnv {
	publicOrigin: string;
	emailTransport?: ServerEnv['emailTransport'];
	secrets: Pick<ServerEnv['secrets'], 'turnstileSecret'>;
}

/**
 * Verifies the `x-turnstile-token` header for `action` against the hostname of PUBLIC_ORIGIN.
 * Missing, invalid, mismatched or unverifiable tokens all answer 403 `TURNSTILE_FAILED` (the
 * reason is not exposed). Uses the local stub only where turnstile.ts allows it.
 */
export async function apiTurnstile(
	env: ApiTurnstileEnv,
	request: Request,
	action: TurnstileAction
): Promise<void> {
	const verify = localTestTurnstile(env) ?? verifyTurnstile;
	const result = await verify({
		token: request.headers.get(TURNSTILE_HEADER),
		action,
		hostname: new URL(env.publicOrigin).hostname,
		secret: env.secrets.turnstileSecret
	});
	if (!result.ok) throw new ApiError(403, 'TURNSTILE_FAILED');
}
