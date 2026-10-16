/**
 * User-gesture tokens: the only way to authorize a write. A token is created inside a
 * click/keypress handler from a trusted event, is single-use and expires after
 * {@link GESTURE_TTL_MS}. Tokens are opaque objects registered here; nothing else can
 * mint a valid one.
 */
import type { GestureToken, UserActivationLike } from './types.ts';

export const GESTURE_TTL_MS = 1000;

const GESTURE_EVENT_TYPES: ReadonlySet<string> = new Set(['click', 'keydown', 'keyup', 'keypress']);

interface TokenRecord {
	createdAt: number;
	used: boolean;
}

const registry = new WeakMap<object, TokenRecord>();

export interface GestureEventLike {
	readonly isTrusted: boolean;
	readonly type: string;
}

export interface GestureOptions {
	/** Epoch ms; defaults to `Date.now`. Use the same clock as the service. */
	now?: () => number;
	/** `undefined` reads `navigator.userActivation`; `null` means the API is unavailable. */
	userActivation?: UserActivationLike | null;
}

/** `navigator.userActivation` when the browser has it, otherwise null. */
export function browserUserActivation(): UserActivationLike | null {
	const nav = globalThis.navigator as { userActivation?: UserActivationLike } | undefined;
	return nav?.userActivation ?? null;
}

/**
 * Mints a token from a trusted click/keypress event, or returns null when the event is
 * untrusted (synthetic), of another type, or the page has no transient user activation.
 */
export function createGestureToken(
	event: GestureEventLike | null | undefined,
	options: GestureOptions = {}
): GestureToken | null {
	if (event === null || event === undefined) return null;
	if (event.isTrusted !== true || !GESTURE_EVENT_TYPES.has(event.type)) return null;
	const activation =
		options.userActivation === undefined ? browserUserActivation() : options.userActivation;
	if (activation !== null && activation.isActive !== true) return null;
	const token: GestureToken = Object.freeze({ kind: 'cable-gesture' as const });
	registry.set(token, { createdAt: (options.now ?? Date.now)(), used: false });
	return token;
}

/**
 * Consumes a token: true only for a registered, unused token created at most
 * {@link GESTURE_TTL_MS} before `nowMs`. The token is spent even when expired.
 */
export function consumeGestureToken(token: unknown, nowMs: number): boolean {
	if (typeof token !== 'object' || token === null) return false;
	const record = registry.get(token);
	if (record === undefined || record.used) return false;
	record.used = true;
	const age = nowMs - record.createdAt;
	return Number.isFinite(age) && age >= 0 && age <= GESTURE_TTL_MS;
}
