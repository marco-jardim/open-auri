// Activity tracking (T4.4, plan §3.7 "Rastreio"): "experimentou" (`previewed`, an audible preview
// of at least 10 s) and "instalou" (`installed`, a real successful write to the cable), the
// author's audience view, the user's own history (view and delete) and the offline outbox.
//
// Anti-abuse rules (Q4: forged events, outbox replay, ranking manipulation):
//   - Only verified, non-banned users send events (routes use `auth: 'verified'`); burst limit and
//     D1 quotas per user on every write route.
//   - `previewed` needs `durationMs >= PREVIEW_MIN_MS`. `installed` cannot be proven server-side
//     (the write happens between the browser and the cable): it is a CLIENT CLAIM, bounded by the
//     rules below. Neither kind can inflate public numbers past one per account.
//   - `at` defaults to now and must lie in [now - OUTBOX_MAX_AGE_MS, now + FUTURE_SKEW_MS]; an item
//     outside it is rejected on its own (the rest of an outbox batch still goes through).
//   - The `activity` table keeps ONE row per (user, lineage, kind) with first/last time and a
//     count, and every public number (counts, rankings, audience) counts DISTINCT verified,
//     non-banned users with the lineage owner excluded (repo.ts `countsForLineages`,
//     `getAudience`, `recomputeRankings`). Replaying events only bumps the private `count`.
//   - `eventId` (UUID chosen by the client) makes retries idempotent: the first sighting claims a
//     per-user key in the D1 sliding-window table of the kit (`slidingWindowLimit`, limit 1,
//     window EVENT_ID_WINDOW_SECONDS); a claimed id answers `duplicate` and records nothing. The
//     window (8 days) outlives the accepted age of `at` (7 days + 60 s), so an event cannot be
//     replayed while its timestamp is still accepted. The id is claimed after the cheap checks and
//     before the write: a server error between the two loses that one event instead of counting
//     it twice. Rows are pruned by the jobs Worker (rate-limit-gc) after two windows.
//   - Claim keys never hold the user id (FX4.6): they are `id:act.ev:<uuid>:<subject>` where
//     `subject` = base64url HMAC-SHA256(subkey, user id) and the subkey is HMAC-SHA256(
//     BETTER_AUTH_SECRET, EVENT_CLAIM_KEY_LABEL) (purpose-bound, like the e-mail suppression hash).
//     "Delete my activity" without a filter also deletes the caller's claims. Account deletion
//     cannot reach them from here (account/deletion.ts is not this service's file): they expire
//     with the window, and without the secret the subject cannot be linked to the account.
//   - Daily quota per ITEM: the single-event route counts one unit per request in the kit quota
//     `ACTIVITY_WRITE_GROUP.q1` (ACTIVITY_DAILY_QUOTA); the outbox counts one unit of the same
//     counter per item that passes the cheap checks, so a batch cannot multiply the daily budget.
//     Items over the quota answer status `limited` (the client keeps and retries them).
//   - Only lineages readable by the caller (repo `readableLineageSql`): someone else's private
//     lineage answers 404, exactly like a missing one.
//   - Share funnel: with `shareId`, when the share exists, belongs to the same lineage, was not
//     made by the caller AND the caller's `activity_visibility` is 'public', the attributed user
//     event is recorded once per kind (repo `recordShareEvent`). A private actor is never
//     attributed, so a share sent to one person cannot reveal what that person did (FX4.6).
import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { ApiError } from '#lib/server/api/index.ts';
import type { ApiQuota } from '#lib/server/api/limits.ts';
import { rateLimitKey, slidingWindowLimit } from '#lib/server/security/ratelimit.ts';
import { deleteEventClaims, hasPublicActivity } from '#lib/server/social/queries/activity.ts';
import {
	deleteOwnActivity,
	getAudience,
	getShare,
	isSocialId,
	listOwnActivity,
	recordActivity,
	recordShareEvent
} from '#lib/server/social/repo.ts';
import {
	ACTIVITY_KINDS,
	DAY_MS,
	type ActivityKind,
	type ActivityRecord,
	type Audience,
	type Page,
	type PageRequest
} from '#lib/server/social/types.ts';

/** Minimum audible preview that counts as "experimentou". */
export const PREVIEW_MIN_MS = 10_000;
/** Clock skew tolerated for `at` in the future. */
export const FUTURE_SKEW_MS = 60_000;
/** Oldest `at` accepted (offline outbox). */
export const OUTBOX_MAX_AGE_MS = 7 * DAY_MS;
/** Items per outbox batch. */
export const OUTBOX_MAX_ITEMS = 50;
/** How long a claimed `eventId` is remembered (at least; see the header). */
export const EVENT_ID_WINDOW_SECONDS = 8 * 86_400;
/** Upper bound of `durationMs` (one day): anything larger is a malformed client. */
export const DURATION_MAX_MS = DAY_MS;

/** Kit rate-limit group of the activity writes (single-event route and outbox items). */
export const ACTIVITY_WRITE_GROUP = 'api.activity.write';
/** Per-user daily quota of activity events (requests of the single route, items of the outbox). */
export const ACTIVITY_DAILY_QUOTA = 1000;
/** Quotas of the single-event route; index 1 is the daily one shared with outbox items. */
export const ACTIVITY_WRITE_QUOTAS: readonly ApiQuota[] = [
	{ limit: 120, windowSeconds: 3600 },
	{ limit: ACTIVITY_DAILY_QUOTA }
];
const DAILY_QUOTA_INDEX = 1;
const DAY_SECONDS = 86_400;

/** Label of the purpose-bound subkey that hashes user ids in event-id claim keys. */
export const EVENT_CLAIM_KEY_LABEL = 'open-auri:activity-event-claim:v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_GROUP = 'act.ev:';

const eventFields = {
	kind: z.enum(ACTIVITY_KINDS),
	at: z.number().int().optional(),
	durationMs: z.number().int().min(0).max(DURATION_MAX_MS).optional(),
	eventId: z.string().regex(UUID),
	shareId: z.string().min(1).max(128).optional()
};

/** Body of `POST /api/v1/curves/[id]/activity`. */
export const ActivityEventBody = z.object(eventFields);
export type ActivityEventInput = z.output<typeof ActivityEventBody>;

/** One outbox item: the same shape plus the lineage. */
export const OutboxItem = z.object({ ...eventFields, lineageId: z.string().min(1).max(128) });
export type OutboxItemInput = z.output<typeof OutboxItem>;

/** Body of `POST /api/v1/me/activity/outbox`; items are validated one by one. */
export const OutboxBody = z.object({
	events: z.array(z.unknown()).min(1).max(OUTBOX_MAX_ITEMS)
});

export type ActivityRejection = 'invalid' | 'too-short' | 'out-of-window' | 'not-found';

export type ActivityOutcome =
	| { status: 'recorded'; activity: ActivityRecord; shareAttributed: boolean }
	| { status: 'duplicate' }
	| { status: 'rejected'; reason: ActivityRejection };

/** Checks that need no database: kind, preview length, time window. */
export function checkEvent(
	input: ActivityEventInput,
	now: number
): { ok: true; at: number } | { ok: false; reason: ActivityRejection } {
	if (!UUID.test(input.eventId)) return { ok: false, reason: 'invalid' };
	if (input.kind === 'previewed') {
		const duration = input.durationMs;
		if (duration === undefined || !Number.isFinite(duration) || duration < PREVIEW_MIN_MS) {
			return { ok: false, reason: 'too-short' };
		}
	}
	const at = input.at ?? now;
	if (!Number.isSafeInteger(at)) return { ok: false, reason: 'invalid' };
	if (at > now + FUTURE_SKEW_MS || at < now - OUTBOX_MAX_AGE_MS) {
		return { ok: false, reason: 'out-of-window' };
	}
	return { ok: true, at };
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/**
 * Subject of the event-id claim keys of `userId`: base64url HMAC-SHA256 (43 characters, a keyed
 * hash for `rateLimitKey.id`) under a subkey of `secret` (BETTER_AUTH_SECRET) bound to
 * EVENT_CLAIM_KEY_LABEL. Rotating the secret only forgets pending claims (at most 8 days).
 */
export async function eventClaimSubject(secret: string, userId: string): Promise<string> {
	if (secret.length < 32) throw new RangeError('event claim secret is too short');
	// Copies backed by a plain ArrayBuffer satisfy BufferSource under lib.dom and workers-types.
	const utf8 = (text: string): Uint8Array<ArrayBuffer> =>
		new Uint8Array(new TextEncoder().encode(text));
	const root = await hmacKey(utf8(secret));
	const subkey = await crypto.subtle.sign('HMAC', root, utf8(EVENT_CLAIM_KEY_LABEL));
	const key = await hmacKey(new Uint8Array(subkey));
	const mac = await crypto.subtle.sign('HMAC', key, utf8(userId));
	return base64url(new Uint8Array(mac));
}

/**
 * Claims `eventId` for the claim subject of a user. True the first time within the window, false
 * for a replay. Fails closed (503) when D1 is unavailable.
 */
async function claimEventId(
	db: D1Database,
	subject: string,
	eventId: string,
	now: number
): Promise<boolean> {
	const key = rateLimitKey.id(`${EVENT_GROUP}${eventId.toLowerCase()}`, subject);
	const outcome = await slidingWindowLimit(
		db,
		[{ key, limit: 1, windowSeconds: EVENT_ID_WINDOW_SECONDS }],
		new Date(now)
	);
	if (outcome.ok) return true;
	if (outcome.reason === 'limited') return false;
	throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE');
}

/**
 * Counts one outbox item against the daily quota the single-event route uses (the kit key of
 * `ACTIVITY_WRITE_GROUP` quota index 1, same subject and window). False once the quota is spent;
 * fails closed (503) when D1 is unavailable.
 */
async function consumeDailyQuota(db: D1Database, userId: string, now: number): Promise<boolean> {
	const quota = ACTIVITY_WRITE_QUOTAS[DAILY_QUOTA_INDEX];
	if (!quota) throw new RangeError('activity daily quota is not configured');
	const key = rateLimitKey.user(`${ACTIVITY_WRITE_GROUP}.q${DAILY_QUOTA_INDEX}`, userId);
	const outcome = await slidingWindowLimit(
		db,
		[{ key, limit: quota.limit, windowSeconds: quota.windowSeconds ?? DAY_SECONDS }],
		new Date(now)
	);
	if (outcome.ok) return true;
	if (outcome.reason === 'limited') return false;
	throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE');
}

function utcDay(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

/**
 * Attributes the event to a share of the same lineage, unless the caller made the share or the
 * caller's activity is private (see the header).
 */
async function attributeShare(
	db: D1Database,
	userId: string,
	lineageId: string,
	shareId: string,
	kind: ActivityKind,
	at: number
): Promise<boolean> {
	if (!isSocialId(shareId)) return false;
	const share = await getShare(db, shareId);
	if (!share || share.lineageId !== lineageId || share.ownerUserId === userId) return false;
	if (!(await hasPublicActivity(db, userId))) return false;
	return recordShareEvent(db, { shareId, kind, userId, day: utcDay(at), at });
}

export interface ActivityOptions {
	/** BETTER_AUTH_SECRET (`env.secrets.betterAuthSecret`): keys the event-id claims. */
	claimSecret: string;
	now?: number;
}

/** After the cheap checks: claim, write, attribute. */
async function recordChecked(
	db: D1Database,
	userId: string,
	subject: () => Promise<string>,
	lineageId: string,
	input: ActivityEventInput,
	at: number,
	now: number
): Promise<ActivityOutcome> {
	if (!(await claimEventId(db, await subject(), input.eventId, now))) {
		return { status: 'duplicate' };
	}
	const recorded = await recordActivity(db, userId, lineageId, input.kind, at);
	if (!recorded.ok) {
		return {
			status: 'rejected',
			reason: recorded.code === 'invalid-input' ? 'invalid' : 'not-found'
		};
	}
	const shareAttributed =
		input.shareId === undefined
			? false
			: await attributeShare(db, userId, lineageId, input.shareId, input.kind, at);
	return { status: 'recorded', activity: recorded.value, shareAttributed };
}

/** Records one event of `userId` on `lineageId` (see the rules in the header). */
export async function recordActivityEvent(
	db: D1Database,
	userId: string,
	lineageId: string,
	input: ActivityEventInput,
	options: ActivityOptions
): Promise<ActivityOutcome> {
	const now = options.now ?? Date.now();
	const checked = checkEvent(input, now);
	if (!checked.ok) return { status: 'rejected', reason: checked.reason };
	if (!isSocialId(lineageId)) return { status: 'rejected', reason: 'not-found' };
	const subject = () => eventClaimSubject(options.claimSecret, userId);
	return recordChecked(db, userId, subject, lineageId, input, checked.at, now);
}

export interface OutboxResult {
	index: number;
	/** The item's own event id when it parsed as a UUID, else null. */
	eventId: string | null;
	/** `limited`: the daily quota is spent; nothing was recorded or claimed, retry later. */
	status: 'recorded' | 'duplicate' | 'rejected' | 'limited';
	reason?: ActivityRejection;
}

export interface OutboxOptions {
	/** BETTER_AUTH_SECRET; required as soon as one item reaches the event-id claim. */
	claimSecret?: string;
	now?: number;
}

function eventIdOf(item: unknown): string | null {
	if (typeof item !== 'object' || item === null || !('eventId' in item)) return null;
	const { eventId } = item;
	return typeof eventId === 'string' && UUID.test(eventId) ? eventId : null;
}

/**
 * Offline outbox: each item is validated and recorded on its own (partial acceptance). Items are
 * processed in order, so a repeated `eventId` inside one batch is a duplicate too. Every item
 * that passes the cheap checks costs one unit of the per-user daily quota (see the header); once
 * it is spent, that item and the rest answer `limited` without touching D1 again.
 */
export async function recordOutbox(
	db: D1Database,
	userId: string,
	items: readonly unknown[],
	options: OutboxOptions = {}
): Promise<OutboxResult[]> {
	const now = options.now ?? Date.now();
	let subjectMemo: Promise<string> | null = null;
	const subject = (): Promise<string> => {
		if (options.claimSecret === undefined) {
			return Promise.reject(new Error('recordOutbox: claimSecret is required to claim events'));
		}
		subjectMemo ??= eventClaimSubject(options.claimSecret, userId);
		return subjectMemo;
	};
	let limited = false;
	const results: OutboxResult[] = [];
	for (const [index, item] of items.slice(0, OUTBOX_MAX_ITEMS).entries()) {
		const parsed = OutboxItem.safeParse(item, { reportInput: false, jitless: true });
		if (!parsed.success) {
			results.push({ index, eventId: eventIdOf(item), status: 'rejected', reason: 'invalid' });
			continue;
		}
		const { lineageId, ...event } = parsed.data;
		const checked = checkEvent(event, now);
		if (!checked.ok || !isSocialId(lineageId)) {
			const reason = checked.ok ? 'not-found' : checked.reason;
			results.push({ index, eventId: event.eventId, status: 'rejected', reason });
			continue;
		}
		if (!limited && !(await consumeDailyQuota(db, userId, now))) limited = true;
		if (limited) {
			results.push({ index, eventId: event.eventId, status: 'limited' });
			continue;
		}
		const outcome = await recordChecked(db, userId, subject, lineageId, event, checked.at, now);
		const result: OutboxResult = { index, eventId: event.eventId, status: outcome.status };
		if (outcome.status === 'rejected') result.reason = outcome.reason;
		results.push(result);
	}
	return results;
}

/** The caller's own history (any lineage state), most recent first. */
export function listMyActivity(
	db: D1Database,
	userId: string,
	page: PageRequest
): Promise<Page<ActivityRecord>> {
	return listOwnActivity(db, userId, page);
}

/**
 * Deletes the caller's own activity: everything, or one lineage and/or kind (also the matching
 * attributed share events). Public counts drop at once. Returns the activity rows deleted.
 * Without a filter, the caller's event-id claims go too (claims carry no lineage or kind, so a
 * filtered deletion keeps them until they expire).
 */
export async function deleteMyActivity(
	db: D1Database,
	userId: string,
	filter: { lineageId?: string | null; kind?: ActivityKind | null },
	options: { claimSecret?: string } = {}
): Promise<number> {
	const deleted = await deleteOwnActivity(db, userId, filter);
	const everything = (filter.lineageId ?? null) === null && (filter.kind ?? null) === null;
	if (everything && options.claimSecret !== undefined) {
		const subject = await eventClaimSubject(options.claimSecret, userId);
		await deleteEventClaims(db, EVENT_GROUP, subject, userId);
	}
	return deleted;
}

/**
 * The owner's audience: distinct verified, non-banned users per kind (the owner excluded), the
 * nicknames of those with `activity_visibility = 'public'` and a count of the others. Null when
 * the lineage is missing or not the caller's (the route answers 404 for both).
 */
export function audienceFor(
	db: D1Database,
	lineageId: string,
	ownerUserId: string
): Promise<Audience | null> {
	if (!isSocialId(lineageId)) return Promise.resolve(null);
	return getAudience(db, lineageId, ownerUserId);
}
