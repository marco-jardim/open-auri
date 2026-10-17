// S7 blind trade service (T4.10, plan §3.7). A verified user puts one gate-approved curve in the
// queue (a publicly listable lineage, or an own one while active and not hidden by moderation;
// pairing re-checks that rule on both sides, and every served trade re-checks it on the partner's
// side: a partner that stopped qualifying is never served, and a matched pair with such a partner
// is cancelled); at most one active trade per user (partial
// UNIQUE index). Pairing is asynchronous and atomic: candidates are read here, the match itself
// is the repository's `tryPairTrades` (two conditional UPDATEs in one D1 batch), so two joins that
// race for the same waiting trade match it at most once. While blind, each side sees only the
// partner's curve (S1 + curve id, enough to play it); once both scored (the reveal happens in the
// same batch as the second score), it also sees the partner's nickname, the lineage when it can
// be linked, and both scores. Trades expire 72 h after joining or after pairing (hourly job).
//
// No SvelteKit or API-kit runtime imports: the jobs Worker imports this module as well.
import type { D1Database } from '@cloudflare/workers-types';
import type { ApiErrorCode } from '#lib/server/api/errors.ts';
import {
	cancelTrade as repoCancelTrade,
	createTrade,
	expireTrades,
	getTradeForUser,
	isSocialId,
	listOwnTrades,
	scoreTrade as repoScoreTrade,
	tryPairTrades
} from '#lib/server/social/repo.ts';
import {
	cancelPairWithUnavailablePartner,
	findTradeTarget,
	listPairCandidates,
	listWaitingTradeIds,
	readTradeState,
	revealedPartnerFacts,
	unavailablePartnerTradeIds,
	type RevealedPartnerFacts
} from '#lib/server/social/queries/trades.ts';
import {
	SocialRepoError,
	type PageRequest,
	type PairResult,
	type TradeStatus,
	type TradeView
} from '#lib/server/social/types.ts';

/** Candidates tried per pairing attempt (the oldest waiting trades first). */
export const TRADE_PAIR_ATTEMPTS = 5;
/** Waiting trades the hourly job retries per run. */
export const TRADE_RETRY_LIMIT = 50;

export type TradeErrorCode =
	| 'invalid-input'
	| 'invalid-cursor'
	| 'not-found'
	| 'gate-rejected'
	| 'already-active'
	| 'duplicate'
	/** The trade is not in a state that allows the action (not matched, expired, not waiting). */
	| 'not-active';

export type TradeResult<T> = { ok: true; value: T } | { ok: false; code: TradeErrorCode };

/** HTTP status and stable API code of each service error (routes throw `ApiError` with it). */
export const TRADE_API_ERRORS: Readonly<
	Record<TradeErrorCode, { status: number; code: ApiErrorCode }>
> = {
	'invalid-input': { status: 400, code: 'INVALID_BODY' },
	'invalid-cursor': { status: 400, code: 'INVALID_CURSOR' },
	'not-found': { status: 404, code: 'NOT_FOUND' },
	'gate-rejected': { status: 422, code: 'GATE_REJECTED' },
	'already-active': { status: 409, code: 'ALREADY_ACTIVE' },
	duplicate: { status: 409, code: 'DUPLICATE' },
	'not-active': { status: 409, code: 'CONFLICT' }
};

/** While blind: only what the browser needs to play the partner's curve. */
export interface BlindPartner {
	revealed: false;
	curveId: string;
	s1: string;
}

/** After both scores. `lineage` only when the partner's lineage can be opened by id. */
export interface RevealedPartner {
	revealed: true;
	curveId: string;
	s1: string;
	/** Score the partner gave to the caller's curve. */
	score: number | null;
	/** Partner's nickname as displayed; null without one or when the partner is banned. */
	nickname: string | null;
	/** Partner's canonical nickname, for the `/u/` link; null exactly when `nickname` is. */
	username: string | null;
	lineage: { id: string; versionId: string; name: string | null } | null;
}

/** A trade as the API returns it to its owner. Never the partner's user or trade id. */
export interface TradeDto {
	id: string;
	status: TradeStatus;
	/** The caller's own lineage and version in this trade. */
	lineageId: string;
	versionId: string;
	/** Score the caller gave to the partner's curve. */
	score: number | null;
	createdAt: number;
	matchedAt: number | null;
	scoredAt: number | null;
	expiresAt: number;
	/**
	 * Null while waiting, after expiry or cancellation, and when the partner's lineage stopped
	 * qualifying (retracted, hidden by moderation, made private, curve no longer approved): its
	 * curve is then never served (a matched pair is cancelled, a revealed trade keeps its status).
	 */
	partner: BlindPartner | RevealedPartner | null;
}

function toDto(
	view: TradeView,
	facts: RevealedPartnerFacts | undefined,
	unavailable: boolean
): TradeDto {
	let partner: TradeDto['partner'] = null;
	let status = view.status;
	if (unavailable) {
		if (status === 'matched') status = 'cancelled';
	} else if (view.partner && view.status === 'revealed') {
		const { lineageId, versionId } = view.partner;
		partner = {
			revealed: true,
			curveId: view.partner.curveId,
			s1: view.partner.s1,
			score: view.partner.score,
			nickname: facts?.nickname ?? null,
			username: facts?.username ?? null,
			lineage:
				facts?.linkable && lineageId !== null && versionId !== null
					? { id: lineageId, versionId, name: facts.versionName }
					: null
		};
	} else if (view.partner && view.status === 'matched') {
		partner = { revealed: false, curveId: view.partner.curveId, s1: view.partner.s1 };
	}
	return {
		id: view.id,
		status,
		lineageId: view.lineageId,
		versionId: view.versionId,
		score: view.score,
		createdAt: view.createdAt,
		matchedAt: view.matchedAt,
		scoredAt: view.scoredAt,
		expiresAt: view.expiresAt,
		partner
	};
}

/**
 * DTOs of the caller's trades. The partner's lineage is re-checked on every read: when it no
 * longer qualifies, its curve is withheld, and a matched pair is cancelled (conditional UPDATE).
 */
async function toDtos(db: D1Database, userId: string, views: TradeView[]): Promise<TradeDto[]> {
	const paired = views
		.filter((view) => view.status === 'matched' || view.status === 'revealed')
		.map((view) => view.id);
	const unavailable = await unavailablePartnerTradeIds(db, userId, paired);
	for (const view of views) {
		if (view.status === 'matched' && unavailable.has(view.id)) {
			await cancelPairWithUnavailablePartner(db, userId, view.id);
		}
	}
	const revealed = views
		.filter((view) => view.status === 'revealed' && !unavailable.has(view.id))
		.map((view) => view.id);
	const facts = await revealedPartnerFacts(db, userId, revealed);
	return views.map((view) => toDto(view, facts.get(view.id), unavailable.has(view.id)));
}

/** The caller's trade as a DTO, or null when it does not exist or is someone else's. */
export async function getMyTrade(
	db: D1Database,
	userId: string,
	tradeId: string
): Promise<TradeDto | null> {
	if (!isSocialId(tradeId)) return null;
	const view = await getTradeForUser(db, tradeId, userId);
	if (!view) return null;
	const [dto] = await toDtos(db, userId, [view]);
	return dto ?? null;
}

/**
 * Tries to pair the waiting trade `tradeId` with the oldest eligible waiting trades at `now`.
 * Each try is the repository's atomic primitive; a candidate taken by someone else meanwhile just
 * fails and the next one is tried. `matched` also when another join paired this trade first.
 */
export async function pairWaitingTrade(
	db: D1Database,
	tradeId: string,
	now: number,
	attempts: number = TRADE_PAIR_ATTEMPTS
): Promise<PairResult> {
	const limit = Math.min(Math.max(Math.trunc(attempts), 1), 20);
	const candidates = await listPairCandidates(db, tradeId, now, limit);
	for (const candidateId of candidates) {
		if (await tryPairTrades(db, tradeId, candidateId, now)) {
			return { status: 'matched', matchId: candidateId };
		}
	}
	const state = await readTradeState(db, tradeId);
	if (state?.status === 'matched' && state.matchId !== null) {
		return { status: 'matched', matchId: state.matchId };
	}
	return { status: 'waiting' };
}

export interface JoinInput {
	lineageId: string;
	versionId?: string | undefined;
}

export interface JoinOptions {
	now?: number;
	attempts?: number;
	/** Trade id (tests); a random UUID by default. */
	id?: string;
}

/**
 * Joins the queue with a version (`versionId`, or the head) of a lineage that is publicly
 * listable, or the caller's own while active and not hidden by moderation, whose curve passed the
 * gate; then tries to pair at once. Errors: `invalid-input`, `not-found` (missing; unlisted or
 * private and not own; own but retracted or hidden by moderation), `gate-rejected`,
 * `already-active`.
 */
export async function joinTrade(
	db: D1Database,
	userId: string,
	input: JoinInput,
	options: JoinOptions = {}
): Promise<TradeResult<TradeDto>> {
	const now = options.now ?? Date.now();
	const versionId = input.versionId ?? null;
	if (!isSocialId(input.lineageId) || (versionId !== null && !isSocialId(versionId))) {
		return { ok: false, code: 'invalid-input' };
	}
	const target = await findTradeTarget(db, userId, input.lineageId, versionId);
	if (!target || !target.tradeable) return { ok: false, code: 'not-found' };
	if (!target.gateOk) return { ok: false, code: 'gate-rejected' };

	const created = await createTrade(db, {
		id: options.id ?? crypto.randomUUID(),
		userId,
		lineageId: target.lineageId,
		versionId: target.versionId,
		now
	});
	if (!created.ok) {
		if (created.code === 'already-active') return { ok: false, code: 'already-active' };
		if (created.code === 'invalid-input') return { ok: false, code: 'invalid-input' };
		// The lineage or curve changed between the check and the insert.
		return { ok: false, code: 'not-found' };
	}
	await pairWaitingTrade(db, created.value.id, now, options.attempts);
	const dto = await getMyTrade(db, userId, created.value.id);
	return dto ? { ok: true, value: dto } : { ok: false, code: 'not-found' };
}

/**
 * The caller scores the partner's curve (integer 1-5), once. The second score of a pair reveals
 * both trades in the same batch. Errors: `invalid-input` (score), `not-found` (no such trade of
 * the caller), `duplicate` (already scored), `not-active` (not matched, or expired).
 */
export async function scoreMyTrade(
	db: D1Database,
	userId: string,
	tradeId: string,
	score: number,
	now: number = Date.now()
): Promise<TradeResult<{ revealed: boolean; trade: TradeDto }>> {
	if (!Number.isInteger(score) || score < 1 || score > 5) {
		return { ok: false, code: 'invalid-input' };
	}
	if (!isSocialId(tradeId)) return { ok: false, code: 'not-found' };
	// A partner whose lineage stopped qualifying ends the pair instead of being scored.
	if (
		(await unavailablePartnerTradeIds(db, userId, [tradeId])).has(tradeId) &&
		(await cancelPairWithUnavailablePartner(db, userId, tradeId)) > 0
	) {
		return { ok: false, code: 'not-active' };
	}
	const scored = await repoScoreTrade(db, tradeId, userId, score, now);
	if (!scored.ok) {
		if (scored.code === 'not-found') return { ok: false, code: 'not-found' };
		if (scored.code === 'duplicate') return { ok: false, code: 'duplicate' };
		// The score is valid, so 'invalid-input' means the trade is not matched or expired.
		return { ok: false, code: 'not-active' };
	}
	const trade = await getMyTrade(db, userId, tradeId);
	if (!trade) return { ok: false, code: 'not-found' };
	return { ok: true, value: { revealed: scored.value.revealed, trade } };
}

/** Cancels the caller's trade while it is still waiting. */
export async function cancelMyTrade(
	db: D1Database,
	userId: string,
	tradeId: string
): Promise<TradeResult<{ cancelled: true }>> {
	if (!isSocialId(tradeId)) return { ok: false, code: 'not-found' };
	if (await repoCancelTrade(db, tradeId, userId)) return { ok: true, value: { cancelled: true } };
	const existing = await getTradeForUser(db, tradeId, userId);
	return { ok: false, code: existing ? 'not-active' : 'not-found' };
}

/** The caller's trades, newest first (keyset pages). */
export async function listMyTrades(
	db: D1Database,
	userId: string,
	page: PageRequest = {}
): Promise<TradeResult<{ items: TradeDto[]; nextCursor: string | null }>> {
	let views: { items: TradeView[]; nextCursor: string | null };
	try {
		const result = await listOwnTrades(db, userId, page);
		views = { items: result.items, nextCursor: result.nextCursor ?? null };
	} catch (error) {
		if (error instanceof SocialRepoError && error.code === 'invalid-cursor') {
			return { ok: false, code: 'invalid-cursor' };
		}
		throw error;
	}
	return {
		ok: true,
		value: { items: await toDtos(db, userId, views.items), nextCursor: views.nextCursor }
	};
}

/** Expires waiting and matched trades whose deadline passed; returns how many. */
export function expireOverdueTrades(db: D1Database, now: number): Promise<number> {
	return expireTrades(db, now);
}

/**
 * Retries pairing of up to `limit` waiting trades, oldest first (trades that missed each other,
 * e.g. when every candidate tried at join time was taken meanwhile). Returns the pairs made.
 */
export async function retryWaitingPairs(
	db: D1Database,
	now: number,
	limit: number = TRADE_RETRY_LIMIT
): Promise<number> {
	const waiting = await listWaitingTradeIds(db, now, Math.min(Math.max(Math.trunc(limit), 1), 500));
	let paired = 0;
	for (const tradeId of waiting) {
		const candidates = await listPairCandidates(db, tradeId, now, TRADE_PAIR_ATTEMPTS);
		for (const candidateId of candidates) {
			if (await tryPairTrades(db, tradeId, candidateId, now)) {
				paired++;
				break;
			}
		}
	}
	return paired;
}

/** Hourly maintenance (jobs Worker): expire first, then retry pairing the waiting ones. */
export async function runTradeMaintenance(
	db: D1Database,
	now: number,
	options: { retryLimit?: number } = {}
): Promise<{ expired: number; paired: number }> {
	const expired = await expireOverdueTrades(db, now);
	const paired = await retryWaitingPairs(db, now, options.retryLimit ?? TRADE_RETRY_LIMIT);
	return { expired, paired };
}
