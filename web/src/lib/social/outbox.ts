// Durable activity outbox (T4.12b): `previewed` (>= 10 s) and `installed` events recorded while
// offline or before the request settles, later sent in batches to POST /api/v1/me/activity/outbox.
//
// Storage follows the client storage contract (#lib/state/README.md): events live in the shared
// IndexedDB `outbox` store (keyPath `id`) through `createOutboxStore`, namespaced by
// `type: 'oa.social.outbox'`, with `id` = the event's `eventId`. Pass the layout's store
// (`app.state.outbox`). Backoff state is kept in the payload, so it survives reloads.
//
// One flusher across tabs: the Web Lock `oa-social-outbox` requested with `ifAvailable`; a tab that
// does not get it skips (`busy`). Without Web Locks the server's `eventId` dedup keeps a concurrent
// flush harmless (a replay answers `duplicate`). `enqueue` and `flush` never throw.
//
// Events belong to the account that acted (FX4.2): `enqueue` refuses unless the session is signed
// in and verified at that moment, and stamps the item with the account id (`owner`). `flush` sends
// only the current account's items and leaves those of any other owner in place, so on a shared
// browser one person's activity is never recorded as another's, and a stale tab (still holding the
// previous account) never deletes the new account's offline events (#25). `purge` clears what the
// current account does not own (everything when signed out); SocialSync calls it once the session
// change is confirmed.
//
// The server binds the batch too (FX4.10): every POST carries `actor` = the owner of its items, and
// a session cookie that now belongs to someone else (another tab switched account while this flush
// or a stale tab was running) answers 409 `actor-mismatch` and records nothing. The flush then
// stops with status `actor-mismatch`, keeps the items (no backoff) and the caller re-reads the
// session (SocialSync does).
import type { JsonValue, PendingEvent } from '#lib/state/outbox.svelte.ts';
import { SocialApiError, type OutboxItemInput, type OutboxResult, type SocialApi } from './api.ts';

export const SOCIAL_OUTBOX_TYPE = 'oa.social.outbox';
export const SOCIAL_OUTBOX_LOCK = 'oa-social-outbox';
/** Minimum audible preview that counts (server: PREVIEW_MIN_MS). */
export const PREVIEW_MIN_MS = 10_000;
/** Longest preview the server accepts (one day). */
export const PREVIEW_MAX_MS = 86_400_000;
/** Events older than this are dropped (the server rejects them as `out-of-window`). */
export const OUTBOX_MAX_AGE_MS = 7 * 86_400_000;
/** Items per POST (server: OUTBOX_MAX_ITEMS). */
export const OUTBOX_BATCH_MAX = 50;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 6 * 3_600_000;

const ID_MAX = 128;
/** Stored payload version; 2 added `owner` (FX4.2). */
const PAYLOAD_VERSION = 2;

export type OutboxActivityKind = 'previewed' | 'installed';

export type EnqueueInput =
	| { kind: 'previewed'; lineageId: string; durationMs: number; shareId?: string }
	| { kind: 'installed'; lineageId: string; shareId?: string };

export interface QueuedActivity {
	eventId: string;
	/** Account id of who acted; only that account's session sends the event. */
	owner: string;
	lineageId: string;
	kind: OutboxActivityKind;
	/** Epoch ms of the event (sent as `at`). */
	at: number;
	durationMs?: number;
	shareId?: string;
	/** Failed sends so far. */
	attempts: number;
	/** Epoch ms before which the event is not sent again. */
	nextAttemptAt: number;
}

export type EnqueueRefusal = 'signed-out' | 'unverified' | 'too-short' | 'invalid' | 'storage';

export type EnqueueResult =
	{ ok: true; event: QueuedActivity } | { ok: false; reason: EnqueueRefusal };

/**
 * `actor-mismatch`: the server's session is not the account the items belong to (409, FX4.10);
 * nothing was recorded and the items stay queued for their owner. Re-read the session.
 */
export type FlushStatus =
	| 'done'
	| 'signed-out'
	| 'unverified'
	| 'offline'
	| 'busy'
	| 'aborted'
	| 'actor-mismatch'
	| 'error';

/** `details.reason` of the server's 409 when the batch `actor` is not the session's user. */
export const OUTBOX_ACTOR_MISMATCH = 'actor-mismatch';

/** True for the 409 that refuses a batch sent under another account's session (FX4.10). */
export function isActorMismatch(error: unknown): boolean {
	if (!(error instanceof SocialApiError) || error.code !== 'CONFLICT') return false;
	const details: unknown = error.details;
	if (typeof details !== 'object' || details === null || Array.isArray(details)) return false;
	return Reflect.get(details, 'reason') === OUTBOX_ACTOR_MISMATCH;
}

export interface FlushReport {
	status: FlushStatus;
	/** Items sent to the server (accepted or not). */
	sent: number;
	/** Items removed after a `recorded`, `duplicate` or `rejected` answer. */
	removed: number;
	/** Items removed locally: older than 7 days or unreadable. */
	dropped: number;
	/** Items still queued after this flush (another account's items included: `purge` clears them). */
	kept: number;
	/** Code of the failure that stopped the flush (`status: 'error'`). */
	error?: string;
}

/** The part of `createOutboxStore` (#lib/state) used here. */
export interface OutboxStore {
	list(): Promise<readonly PendingEvent[]>;
	append(input: {
		id?: string;
		type: string;
		payload: JsonValue;
		updatedAt?: number;
	}): Promise<PendingEvent | null>;
	remove(id: string): Promise<void>;
}

/** Subset of the Web Locks API (`navigator.locks`). */
export interface OutboxLockManager {
	request<T>(
		name: string,
		options: { ifAvailable: true },
		callback: (lock: object | null) => Promise<T>
	): Promise<T>;
}

export interface SocialSessionFlags {
	readonly signedIn: boolean;
	readonly verified: boolean;
	/** Id of the signed-in account; null when signed out (`createSocialSession().accountId`). */
	readonly accountId: string | null;
}

export interface SocialOutboxOptions {
	store: OutboxStore;
	/** Whose events may be sent: the social session (`createSocialSession`). */
	session: SocialSessionFlags;
	/** `null` disables the cross-tab lock; default `navigator.locks` when present. */
	locks?: OutboxLockManager | null;
	now?: () => number;
	online?: () => boolean;
	randomId?: () => string;
	/** Jitter source in [0, 1): delays are scaled by `0.5 + random / 2`. */
	random?: () => number;
	log?: (message: string, detail: string) => void;
}

function browserLocks(): OutboxLockManager | null {
	if (typeof navigator === 'undefined') return null;
	const locks: unknown = Reflect.get(navigator, 'locks');
	if (typeof locks !== 'object' || locks === null) return null;
	const request: unknown = Reflect.get(locks, 'request');
	if (typeof request !== 'function') return null;
	const manager = navigator.locks;
	return {
		async request<T>(
			name: string,
			options: { ifAvailable: true },
			callback: (lock: object | null) => Promise<T>
		): Promise<T> {
			return await manager.request(name, options, callback);
		}
	};
}

function browserOnline(): boolean {
	return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** Error label safe for logs: a code or a class name, never a message or user data. */
function errorLabel(error: unknown): string {
	if (error instanceof SocialApiError) return error.code;
	if (error instanceof Error) return error.name;
	return typeof error;
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

function validId(value: unknown): value is string {
	return typeof value === 'string' && value.length >= 1 && value.length <= ID_MAX;
}

function isInt(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value);
}

function toPayload(item: QueuedActivity): JsonValue {
	const payload: { [key: string]: JsonValue } = {
		v: PAYLOAD_VERSION,
		eventId: item.eventId,
		owner: item.owner,
		lineageId: item.lineageId,
		kind: item.kind,
		at: item.at,
		attempts: item.attempts,
		nextAttemptAt: item.nextAttemptAt
	};
	if (item.durationMs !== undefined) payload.durationMs = item.durationMs;
	if (item.shareId !== undefined) payload.shareId = item.shareId;
	return payload;
}

/**
 * Reads a stored payload back; null when it is not a well-formed outbox item. Items without an
 * owner (payload v1, before FX4.2) are not well formed: nobody can prove who acted, so they are
 * dropped instead of being sent as whoever is signed in.
 */
export function parseQueued(payload: JsonValue): QueuedActivity | null {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
	const { v, eventId, owner, lineageId, kind, at, attempts, nextAttemptAt, durationMs, shareId } =
		payload;
	if (v !== PAYLOAD_VERSION || !validId(eventId) || !validId(owner) || !validId(lineageId)) {
		return null;
	}
	if (kind !== 'previewed' && kind !== 'installed') return null;
	if (!isInt(at) || !isInt(attempts) || attempts < 0 || !isInt(nextAttemptAt)) return null;
	const item: QueuedActivity = { eventId, owner, lineageId, kind, at, attempts, nextAttemptAt };
	if (kind === 'previewed') {
		if (!isInt(durationMs) || durationMs < PREVIEW_MIN_MS) return null;
		item.durationMs = durationMs;
	}
	if (shareId !== undefined) {
		if (!validId(shareId)) return null;
		item.shareId = shareId;
	}
	return item;
}

function toWire(item: QueuedActivity): OutboxItemInput {
	const wire: OutboxItemInput = {
		lineageId: item.lineageId,
		kind: item.kind,
		eventId: item.eventId,
		at: item.at
	};
	if (item.durationMs !== undefined) wire.durationMs = item.durationMs;
	if (item.shareId !== undefined) wire.shareId = item.shareId;
	return wire;
}

/** Codes after which retrying cannot help until the session changes (no backoff increment). */
const SESSION_CODES: ReadonlySet<string> = new Set([
	'AUTH_REQUIRED',
	'EMAIL_NOT_VERIFIED',
	'BANNED'
]);

export function createSocialOutbox(options: SocialOutboxOptions) {
	const { store, session } = options;
	const locks = options.locks === undefined ? browserLocks() : options.locks;
	const now = options.now ?? Date.now;
	const online = options.online ?? browserOnline;
	const randomId = options.randomId ?? (() => globalThis.crypto.randomUUID());
	const random = options.random ?? Math.random;
	const log = options.log ?? ((message: string, detail: string) => console.warn(message, detail));
	let running: Promise<FlushReport> | null = null;

	function backoffDelay(attempts: number, retryAfterMs: number | undefined): number {
		const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
		const jitter = 0.5 + Math.min(Math.max(random(), 0), 1) / 2;
		return Math.max(Math.round(base * jitter), retryAfterMs ?? 0);
	}

	/** Account allowed to act right now: signed in, verified and with a known id. */
	function actor(): { ok: true; id: string } | { ok: false; reason: 'signed-out' | 'unverified' } {
		const id = session.accountId;
		if (!session.signedIn || !validId(id)) return { ok: false, reason: 'signed-out' };
		if (!session.verified) return { ok: false, reason: 'unverified' };
		return { ok: true, id };
	}

	/**
	 * Queues an event for the account signed in now. Signed out or unverified: refused and nothing
	 * is stored (anonymous activity is never kept for a later account). `actedAs` is the account id
	 * captured when the action happened (e.g. at the cable write, before an async lookup): when the
	 * session now belongs to someone else (or nobody), the event is refused as `signed-out`.
	 */
	async function enqueue(
		input: EnqueueInput,
		enqueueOptions: { actedAs?: string | null } = {}
	): Promise<EnqueueResult> {
		try {
			const who = actor();
			if (!who.ok) return { ok: false, reason: who.reason };
			if (enqueueOptions.actedAs !== undefined && enqueueOptions.actedAs !== who.id) {
				return { ok: false, reason: 'signed-out' };
			}
			if (!validId(input.lineageId)) return { ok: false, reason: 'invalid' };
			if (input.shareId !== undefined && !validId(input.shareId)) {
				return { ok: false, reason: 'invalid' };
			}
			const at = Math.floor(now());
			const item: QueuedActivity = {
				eventId: randomId(),
				owner: who.id,
				lineageId: input.lineageId,
				kind: input.kind,
				at,
				attempts: 0,
				nextAttemptAt: at
			};
			if (input.kind === 'previewed') {
				const duration = input.durationMs;
				if (!Number.isFinite(duration) || duration < PREVIEW_MIN_MS) {
					return { ok: false, reason: 'too-short' };
				}
				item.durationMs = Math.min(Math.floor(duration), PREVIEW_MAX_MS);
			}
			if (input.shareId !== undefined) item.shareId = input.shareId;
			const stored = await store.append({
				id: item.eventId,
				type: SOCIAL_OUTBOX_TYPE,
				payload: toPayload(item),
				updatedAt: at
			});
			if (stored === null) return { ok: false, reason: 'storage' };
			return { ok: true, event: item };
		} catch (error) {
			log('social outbox: enqueue failed', errorLabel(error));
			return { ok: false, reason: 'storage' };
		}
	}

	interface Entry {
		item: QueuedActivity;
		updatedAt: number;
	}

	async function readAll(): Promise<{ entries: Entry[]; invalid: string[] }> {
		const entries: Entry[] = [];
		const invalid: string[] = [];
		for (const event of await store.list()) {
			if (event.type !== SOCIAL_OUTBOX_TYPE) continue;
			const item = parseQueued(event.payload);
			if (item === null || item.eventId !== event.id) invalid.push(event.id);
			else entries.push({ item, updatedAt: event.updatedAt });
		}
		entries.sort((a, b) => a.item.at - b.item.at || a.item.eventId.localeCompare(b.item.eventId));
		return { entries, invalid };
	}

	/** Queued events of the account signed in now (none when signed out). */
	async function pending(): Promise<QueuedActivity[]> {
		try {
			const owner = session.signedIn ? session.accountId : null;
			if (owner === null) return [];
			const { entries } = await readAll();
			return entries.filter((entry) => entry.item.owner === owner).map((entry) => entry.item);
		} catch (error) {
			log('social outbox: read failed', errorLabel(error));
			return [];
		}
	}

	async function postpone(entries: Entry[], retryAfterMs: number | undefined): Promise<void> {
		const at = now();
		for (const { item, updatedAt } of entries) {
			const attempts = item.attempts + 1;
			const next: QueuedActivity = {
				...item,
				attempts,
				nextAttemptAt: Math.floor(at + backoffDelay(attempts, retryAfterMs))
			};
			await store.append({
				id: item.eventId,
				type: SOCIAL_OUTBOX_TYPE,
				payload: toPayload(next),
				updatedAt: Math.max(Math.floor(at), updatedAt + 1)
			});
		}
	}

	function resultFor(batch: Entry[], results: OutboxResult[], index: number) {
		const result = results.find((candidate) => candidate.index === index);
		if (!result) return null;
		const eventId = batch[index]?.item.eventId;
		if (result.eventId !== null && result.eventId !== eventId) return null;
		return result.status;
	}

	async function drain(
		api: Pick<SocialApi, 'postActivityOutbox'>,
		signal: AbortSignal | undefined,
		owner: string
	): Promise<FlushReport> {
		const report: FlushReport = { status: 'done', sent: 0, removed: 0, dropped: 0, kept: 0 };
		const t = now();
		const { entries, invalid } = await readAll();
		for (const id of invalid) {
			await store.remove(id);
			report.dropped += 1;
		}
		const due: Entry[] = [];
		for (const entry of entries) {
			if (entry.item.owner !== owner) {
				// Another account's activity: never sent under this session, and never removed here
				// either. A stale tab may still hold `owner` while the cookie already belongs to that
				// other account (#25); SocialSync's confirmed `purge` clears it on sign-out/switch.
				report.kept += 1;
			} else if (entry.item.at < t - OUTBOX_MAX_AGE_MS) {
				await store.remove(entry.item.eventId);
				report.dropped += 1;
			} else if (entry.item.nextAttemptAt > t) {
				report.kept += 1;
			} else {
				due.push(entry);
			}
		}
		for (let start = 0; start < due.length; start += OUTBOX_BATCH_MAX) {
			const batch = due.slice(start, start + OUTBOX_BATCH_MAX);
			if (signal?.aborted) {
				report.status = 'aborted';
				report.kept += due.length - start;
				break;
			}
			const who = actor();
			if (!who.ok || who.id !== owner) {
				// The session changed during the flush: the rest waits for its owner.
				report.status = who.ok ? 'signed-out' : who.reason;
				report.kept += due.length - start;
				break;
			}
			let results: OutboxResult[];
			try {
				const answer = await api.postActivityOutbox(
					batch.map((entry) => toWire(entry.item)),
					signal ? { signal, actor: owner } : { actor: owner }
				);
				results = Array.isArray(answer.results) ? answer.results : [];
			} catch (error) {
				report.kept += due.length - start;
				if (isAbort(error)) {
					report.status = 'aborted';
					break;
				}
				if (isActorMismatch(error)) {
					// The cookie belongs to another account now: nothing was recorded; the items wait
					// for their owner (no backoff) and the caller re-reads the session.
					report.status = 'actor-mismatch';
					break;
				}
				report.status = 'error';
				report.error = errorLabel(error);
				if (!(error instanceof SocialApiError && SESSION_CODES.has(error.code))) {
					await postpone(batch, error instanceof SocialApiError ? error.retryAfterMs : undefined);
				}
				break;
			}
			report.sent += batch.length;
			const retry: Entry[] = [];
			for (const [index, entry] of batch.entries()) {
				const status = resultFor(batch, results, index);
				if (status === 'recorded' || status === 'duplicate' || status === 'rejected') {
					await store.remove(entry.item.eventId);
					report.removed += 1;
				} else {
					retry.push(entry);
				}
			}
			if (retry.length > 0) {
				await postpone(retry, undefined);
				report.kept += retry.length;
			}
		}
		return report;
	}

	async function guarded(
		api: Pick<SocialApi, 'postActivityOutbox'>,
		signal: AbortSignal | undefined,
		owner: string
	): Promise<FlushReport> {
		try {
			if (locks === null) return await drain(api, signal, owner);
			return await locks.request(SOCIAL_OUTBOX_LOCK, { ifAvailable: true }, async (lock) =>
				lock === null ? skipped('busy') : drain(api, signal, owner)
			);
		} catch (error) {
			if (isAbort(error)) return skipped('aborted');
			log('social outbox: flush failed', errorLabel(error));
			return { ...skipped('error'), error: errorLabel(error) };
		}
	}

	function skipped(status: FlushStatus): FlushReport {
		return { status, sent: 0, removed: 0, dropped: 0, kept: 0 };
	}

	/**
	 * Sends the current account's due events (signed in, verified and online only); the events of
	 * any other account stay queued (counted as `kept`) for `purge`. Concurrent calls in one tab
	 * share the running flush; another tab holding the lock makes this one answer `busy`.
	 */
	function flush(
		api: Pick<SocialApi, 'postActivityOutbox'>,
		flushOptions: { signal?: AbortSignal } = {}
	): Promise<FlushReport> {
		const who = actor();
		if (!who.ok) return Promise.resolve(skipped(who.reason));
		if (!online()) return Promise.resolve(skipped('offline'));
		if (running) return running;
		const current = guarded(api, flushOptions.signal, who.id).finally(() => {
			if (running === current) running = null;
		});
		running = current;
		return current;
	}

	/**
	 * Removes every queued event not owned by `keep` (default: the account signed in now; all of
	 * them when signed out). Call on sign-out and on account switch. Resolves the number removed;
	 * never throws.
	 */
	async function purge(keep: string | null = session.signedIn ? session.accountId : null) {
		let removed = 0;
		try {
			const { entries, invalid } = await readAll();
			for (const id of invalid) {
				await store.remove(id);
				removed += 1;
			}
			for (const { item } of entries) {
				if (keep !== null && item.owner === keep) continue;
				await store.remove(item.eventId);
				removed += 1;
			}
		} catch (error) {
			log('social outbox: purge failed', errorLabel(error));
		}
		return removed;
	}

	return { enqueue, flush, pending, purge };
}

export type SocialOutbox = ReturnType<typeof createSocialOutbox>;
