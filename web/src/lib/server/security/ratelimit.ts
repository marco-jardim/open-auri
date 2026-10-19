// Rate limiting. Two mechanisms, chosen per need:
//
// - Workers RateLimit bindings (RL_AUTH, RL_API, RL_WRITE): cheap, per-location counters with a
//   limit/period fixed per namespace in wrangler (period 10 or 60 s only). Used as coarse burst
//   guards through `rateLimit(binding, key)`.
// - A D1 sliding-window counter (`slidingWindowLimit`), global and exact enough for the precise
//   authentication rules (3/10 s, 3/60 s, 3/300 s...), which need per-rule limits and windows that
//   one binding cannot express, including windows longer than 60 s. KV is not used: it is
//   eventually consistent and has no atomic increment. The table lives in migration 0007 and is
//   pruned daily by the jobs Worker (rate-limit-gc).
//
// Keys never contain a raw IP or e-mail: only keyed hashes (iphash.ts), user ids and route groups.
// The key builders enforce that.
import type { D1Database, D1Result, RateLimit } from '@cloudflare/workers-types';
import { batch, run, sql, type BoundStatement } from '../db.ts';
import { isKeyedHash } from './iphash.ts';
import { TURNSTILE_ACTIONS } from './turnstile.ts';

declare const rateLimitKeyBrand: unique symbol;
/** A key built by {@link rateLimitKey}; raw strings do not type-check. */
export type RateLimitKey = string & { readonly [rateLimitKeyBrand]: true };

export class RateLimitKeyError extends Error {
	constructor(reason: string) {
		super(`Invalid rate-limit key: ${reason}`);
		this.name = 'RateLimitKeyError';
	}
}

const GROUP = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

function checkGroup(group: string): void {
	if (!GROUP.test(group)) throw new RateLimitKeyError('route group');
}

export const rateLimitKey = {
	/** Per user id within a route group. */
	user(group: string, userId: string): RateLimitKey {
		checkGroup(group);
		if (!USER_ID.test(userId)) throw new RateLimitKeyError('user id');
		return `u:${group}:${userId}` as RateLimitKey;
	},
	/** Per client within a route group; `hash` must be an output of the keyed hasher. */
	ip(group: string, hash: string): RateLimitKey {
		checkGroup(group);
		if (!isKeyedHash(hash)) throw new RateLimitKeyError('expected an IP hash, never a raw IP');
		return `ip:${group}:${hash}` as RateLimitKey;
	},
	/** Per pseudonymised identifier (e-mail or username hash) within a route group. */
	id(group: string, hash: string): RateLimitKey {
		checkGroup(group);
		if (!isKeyedHash(hash)) throw new RateLimitKeyError('expected an identifier hash');
		return `id:${group}:${hash}` as RateLimitKey;
	},
	/** Whole route group (global budget). */
	route(group: string): RateLimitKey {
		checkGroup(group);
		return `r:${group}` as RateLimitKey;
	}
};

export type RateLimitOutcome = { ok: true } | { ok: false; reason: 'limited' | 'unavailable' };

/** Workers RateLimit binding check. A failing binding is reported, not treated as success. */
export async function rateLimit(
	binding: Pick<RateLimit, 'limit'>,
	key: RateLimitKey
): Promise<RateLimitOutcome> {
	try {
		const { success } = await binding.limit({ key });
		return success ? { ok: true } : { ok: false, reason: 'limited' };
	} catch {
		return { ok: false, reason: 'unavailable' };
	}
}

export interface WindowRule {
	key: RateLimitKey;
	limit: number;
	windowSeconds: number;
	/**
	 * Check without counting: the rule passes while one more event would still fit. Used for
	 * failure budgets, which are counted separately once a failure happened (`slidingWindowLimit`
	 * with the same rule minus `peek`).
	 */
	peek?: boolean;
}

export type WindowOutcome =
	| { ok: true }
	| { ok: false; reason: 'limited'; retryAfter: number }
	| { ok: false; reason: 'unavailable' };

/**
 * Sliding-window approximation (two fixed windows, the previous one weighted by how much of it
 * still overlaps the sliding window). Every call counts as an attempt, including rejected ones, so
 * a client that keeps hammering stays limited. Rules with `peek` are only read: they fail when one
 * more event would exceed the limit. All rules run in one D1 batch (one round trip, atomic).
 * Returns the first violated rule's outcome; `retryAfter` is the end of the current window.
 */
export async function slidingWindowLimit(
	db: D1Database,
	rules: readonly WindowRule[],
	now: Date = new Date()
): Promise<WindowOutcome> {
	if (rules.length === 0) return { ok: true };
	const nowSeconds = now.getTime() / 1000;
	const statements: BoundStatement[] = [];
	const windows = rules.map((rule) => {
		const start = windowStartOf(nowSeconds, rule.windowSeconds);
		statements.push(
			rule.peek
				? sql(
						db,
						'SELECT count FROM rate_limit_counters WHERE key = ? AND window_start = ?',
						`${rule.key}:${rule.windowSeconds}`,
						start
					)
				: sql(
						db,
						`INSERT INTO rate_limit_counters (key, window_start, count, expires_at)
				 VALUES (?, ?, 1, ?)
				 ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
				 RETURNING count`,
						`${rule.key}:${rule.windowSeconds}`,
						start,
						start + 2 * rule.windowSeconds
					),
			sql(
				db,
				'SELECT count FROM rate_limit_counters WHERE key = ? AND window_start = ?',
				`${rule.key}:${rule.windowSeconds}`,
				start - rule.windowSeconds
			)
		);
		return { rule, start };
	});

	let results: D1Result<{ count: number }>[];
	try {
		results = await batch<{ count: number }>(db, statements);
	} catch {
		return { ok: false, reason: 'unavailable' };
	}

	for (const [index, { rule, start }] of windows.entries()) {
		const current = results[index * 2]?.results[0]?.count ?? 0;
		const previous = results[index * 2 + 1]?.results[0]?.count ?? 0;
		const elapsed = (nowSeconds - start) / rule.windowSeconds;
		const estimate = previous * (1 - elapsed) + current + (rule.peek ? 1 : 0);
		if (estimate > rule.limit) {
			const retryAfter = Math.max(1, Math.ceil(start + rule.windowSeconds - nowSeconds));
			return { ok: false, reason: 'limited', retryAfter };
		}
	}
	return { ok: true };
}

/** Start (epoch seconds) of the fixed window of `windowSeconds` that contains `nowSeconds`. */
function windowStartOf(nowSeconds: number, windowSeconds: number): number {
	if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
		throw new RangeError('windowSeconds must be a positive integer');
	}
	return Math.floor(nowSeconds / windowSeconds) * windowSeconds;
}

/** One unit counted by {@link takeWindowSlot}: the counter row it incremented. */
export interface WindowSlot {
	readonly key: string;
	readonly windowStart: number;
}

export type SlotOutcome =
	| { ok: true; slot: WindowSlot }
	| { ok: false; reason: 'limited'; retryAfter: number }
	| { ok: false; reason: 'unavailable' };

/**
 * Takes one unit of `rule` BEFORE the action it guards, atomically: the increment and the read
 * of the count run in one D1 batch (slidingWindowLimit without `peek`), so whatever the
 * interleaving, N concurrent takers never hold more than `limit` units of the sliding estimate (a
 * peek before the action and a count after it let all N through). A refused take is given back at
 * once, so only taken slots count. The caller gives a taken slot back with
 * {@link releaseWindowSlot} when the action fails, so a failed action consumes nothing. Under
 * concurrency a take may be refused while another taker's unit is still being given back: the
 * limit errs on the side of refusing, never of exceeding.
 */
export async function takeWindowSlot(
	db: D1Database,
	rule: Omit<WindowRule, 'peek'>,
	now: Date = new Date()
): Promise<SlotOutcome> {
	const slot: WindowSlot = {
		key: `${rule.key}:${rule.windowSeconds}`,
		windowStart: windowStartOf(now.getTime() / 1000, rule.windowSeconds)
	};
	const outcome = await slidingWindowLimit(db, [{ ...rule, peek: false }], now);
	if (outcome.ok) return { ok: true, slot };
	if (outcome.reason === 'limited') await releaseWindowSlot(db, slot);
	return outcome;
}

/**
 * Gives back a slot of {@link takeWindowSlot} (the window it was counted in, even if a new window
 * started since). Never below zero. False when D1 is unavailable (the unit then stays counted
 * until its window expires: the limit errs on the side of refusing).
 */
export async function releaseWindowSlot(db: D1Database, slot: WindowSlot): Promise<boolean> {
	try {
		await run(
			sql(
				db,
				'UPDATE rate_limit_counters SET count = count - 1 ' +
					'WHERE key = ? AND window_start = ? AND count > 0',
				slot.key,
				slot.windowStart
			)
		);
		return true;
	} catch {
		return false;
	}
}

// --- Authentication rules (plan T3.5 item 6) -------------------------------------------------

/** Better Auth paths guarded before the handler. */
export const AUTH_GUARDED_PATHS = [
	'/sign-up/email',
	'/sign-in/email',
	'/sign-in/username',
	'/request-password-reset',
	'/change-email',
	'/send-verification-email',
	// GET of the e-mailed verification / change-email links (Q3 round 2, m1).
	'/verify-email'
] as const;
export type AuthGuardedPath = (typeof AUTH_GUARDED_PATHS)[number];

/**
 * `ip+id`: HMAC of the IP combined with the normalized identifier when there is one (falls back to
 * the IP hash alone); `id`: the identifier alone, across IPs (stops IP rotation against one
 * account or mailbox); `ip`: the client alone; `user`: the signed-in user.
 */
export type AuthScope = 'ip+id' | 'id' | 'ip' | 'user';

export interface AuthLimit {
	scope: AuthScope;
	limit: number;
	windowSeconds: number;
}

export interface AuthRoutePolicy {
	/** Route group used in keys and logs. */
	group: string;
	/** Turnstile action required, or `null` when the route is not behind Turnstile. */
	turnstileAction: string | null;
	limits: readonly AuthLimit[];
}

export const AUTH_POLICIES: Readonly<Record<AuthGuardedPath, AuthRoutePolicy>> = {
	'/sign-in/email': {
		group: 'auth.sign-in',
		turnstileAction: TURNSTILE_ACTIONS.signIn,
		limits: [
			{ scope: 'ip+id', limit: 3, windowSeconds: 10 },
			{ scope: 'id', limit: 10, windowSeconds: 300 },
			{ scope: 'ip', limit: 30, windowSeconds: 60 }
		]
	},
	'/sign-in/username': {
		group: 'auth.sign-in',
		turnstileAction: TURNSTILE_ACTIONS.signIn,
		limits: [
			{ scope: 'ip+id', limit: 3, windowSeconds: 10 },
			{ scope: 'id', limit: 10, windowSeconds: 300 },
			{ scope: 'ip', limit: 30, windowSeconds: 60 }
		]
	},
	'/sign-up/email': {
		group: 'auth.sign-up',
		turnstileAction: TURNSTILE_ACTIONS.signUp,
		limits: [
			{ scope: 'ip', limit: 3, windowSeconds: 60 },
			{ scope: 'id', limit: 3, windowSeconds: 60 },
			{ scope: 'ip', limit: 10, windowSeconds: 3600 }
		]
	},
	'/request-password-reset': {
		group: 'auth.reset',
		turnstileAction: TURNSTILE_ACTIONS.reset,
		limits: [
			{ scope: 'ip+id', limit: 3, windowSeconds: 60 },
			{ scope: 'id', limit: 5, windowSeconds: 3600 },
			{ scope: 'ip', limit: 10, windowSeconds: 60 }
		]
	},
	'/send-verification-email': {
		group: 'auth.verify-resend',
		turnstileAction: null,
		limits: [
			{ scope: 'ip+id', limit: 3, windowSeconds: 300 },
			{ scope: 'id', limit: 3, windowSeconds: 300 },
			{ scope: 'ip', limit: 10, windowSeconds: 300 },
			// Daily cap per address: no Turnstile here, so this is what bounds the mail a third party
			// can make one mailbox receive (IP rotation included).
			{ scope: 'id', limit: 10, windowSeconds: 86_400 }
		]
	},
	'/verify-email': {
		group: 'auth.verify-link',
		// A link click: no widget and no identifier in the request. Per client only; the RL_AUTH
		// burst guard runs first. Fails closed like the other routes.
		turnstileAction: null,
		limits: [{ scope: 'ip', limit: 30, windowSeconds: 600 }]
	},
	'/change-email': {
		group: 'auth.change-email',
		turnstileAction: TURNSTILE_ACTIONS.changeEmail,
		limits: [
			{ scope: 'user', limit: 3, windowSeconds: 300 },
			{ scope: 'ip+id', limit: 3, windowSeconds: 300 },
			{ scope: 'id', limit: 3, windowSeconds: 300 },
			{ scope: 'ip', limit: 10, windowSeconds: 300 }
		]
	}
};

export function isAuthGuardedPath(path: string): path is AuthGuardedPath {
	return (AUTH_GUARDED_PATHS as readonly string[]).includes(path);
}

/** Normalization applied to e-mails/usernames before hashing: NFKC, trimmed, lowercase. */
export function normalizeIdentifier(value: string): string {
	return value.normalize('NFKC').trim().toLowerCase();
}

export interface AuthRateSubject {
	path: string;
	/** Keyed hash of the client IP. */
	ipHash: string;
	/** Keyed hash of the normalized identifier, when the request carries one. */
	idHash?: string | null;
	/** Keyed hash of `ipHash` combined with the normalized identifier. */
	ipIdHash?: string | null;
	userId?: string | null;
}

/** A window rule of an authentication route, with the scope it was built from. */
export interface AuthWindowRule extends WindowRule {
	scope: AuthScope;
}

/**
 * Whether a rule's key belongs to the requester (their IP, their IP combined with the identifier,
 * their own session) rather than to a third party (`id`: someone's e-mail or username). The guard
 * counts requester-owned rules before Turnstile and third-party rules only after Turnstile passed,
 * so token-less requests can never spend a victim's per-account budget (auth-guard.ts).
 */
export function isRequesterScope(scope: AuthScope): boolean {
	return scope !== 'id';
}

/**
 * The window rules that apply to an authentication request, or `null` when `path` is not guarded.
 * Pure: hashing happens before (see auth-guard.ts). Rules whose subject is absent are skipped,
 * except `ip+id`, which falls back to the IP hash alone.
 */
export function authRateLimit(subject: AuthRateSubject): AuthWindowRule[] | null {
	if (!isAuthGuardedPath(subject.path)) return null;
	const policy = AUTH_POLICIES[subject.path];
	const rules: AuthWindowRule[] = [];
	for (const [index, { scope, limit, windowSeconds }] of policy.limits.entries()) {
		const group = `${policy.group}.${index}`;
		let key: RateLimitKey | null = null;
		if (scope === 'ip') key = rateLimitKey.ip(group, subject.ipHash);
		else if (scope === 'ip+id') key = rateLimitKey.ip(group, subject.ipIdHash ?? subject.ipHash);
		else if (scope === 'id' && subject.idHash) key = rateLimitKey.id(group, subject.idHash);
		else if (scope === 'user' && subject.userId) key = rateLimitKey.user(group, subject.userId);
		if (key) rules.push({ key, limit, windowSeconds, scope });
	}
	return rules;
}

// --- Secret checks by a signed-in user (password, second factor) -------------------------------

/**
 * Endpoints that check a secret for an existing session (change password, delete account, 2FA
 * management, second-factor verification of a signed-in session) have no Turnstile and no
 * identifier from the body, so they are limited per user:
 * - `attempts`: counted on every attempt (bounds bursts and concurrent guessing);
 * - `failures`: the lockout budget, checked before each attempt (`peek`) and counted only when the
 *   secret was wrong, so legitimate use (an admin re-verifying TOTP many times a day) never locks.
 */
export type SecretKind = 'password' | 'second-factor';

export interface SecretPolicy {
	group: string;
	attempts: { limit: number; windowSeconds: number };
	failures: { limit: number; windowSeconds: number };
}

export const SECRET_POLICIES: Readonly<Record<SecretKind, SecretPolicy>> = {
	password: {
		group: 'auth.secret.password',
		attempts: { limit: 5, windowSeconds: 300 },
		failures: { limit: 20, windowSeconds: 86_400 }
	},
	'second-factor': {
		group: 'auth.secret.2fa',
		attempts: { limit: 5, windowSeconds: 300 },
		failures: { limit: 20, windowSeconds: 86_400 }
	}
};

/** Rules checked before a secret is verified: count the attempt, read the failure budget. */
export function secretAttemptRules(kind: SecretKind, userId: string): WindowRule[] {
	const policy = SECRET_POLICIES[kind];
	return [
		{ key: rateLimitKey.user(`${policy.group}.attempts`, userId), ...policy.attempts },
		{ ...secretFailureRule(kind, userId), peek: true }
	];
}

/** Rule counted once a secret turned out wrong (the lockout budget). */
export function secretFailureRule(kind: SecretKind, userId: string): WindowRule {
	const policy = SECRET_POLICIES[kind];
	return { key: rateLimitKey.user(`${policy.group}.failures`, userId), ...policy.failures };
}
