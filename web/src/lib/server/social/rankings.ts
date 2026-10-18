// Rankings and public feed (T4.6, plan §3.7 "Rankings"). The job recomputes every metric × window
// pair through the repository (`recomputeRankings`: distinct verified, non-banned users, owner
// excluded, publicly listable lineages only, tie-break score → most recent event → id); reads go
// through `listRankings`, which re-checks visibility, so a lineage hidden after the last run drops
// out at once. Nothing here touches SQL: every rule lives in repo.ts.
import type { D1Database } from '@cloudflare/workers-types';
import { ApiError } from '#lib/server/api/errors.ts';
import {
	getRankingState,
	listPublicFeed,
	listRankings,
	recomputeRankings
} from '#lib/server/social/repo.ts';
import {
	RANKING_METRICS,
	RANKING_WINDOWS,
	SocialRepoError,
	isOneOf,
	type AuthorCredit,
	type Lang,
	type License,
	type LineageSummary,
	type PageRequest,
	type RankingEntry,
	type RankingMetric,
	type RankingWindow
} from '#lib/server/social/types.ts';

export const FEED_SORTS = ['new', 'favorites', 'installs'] as const;
export type FeedSort = (typeof FEED_SORTS)[number];

export const DEFAULT_METRIC: RankingMetric = 'favorites';
export const DEFAULT_WINDOW: RankingWindow = '7d';
export const DEFAULT_SORT: FeedSort = 'new';

// ---- Job ------------------------------------------------------------------------------------

export interface RankingPairResult {
	metric: RankingMetric;
	window: RankingWindow;
	/** False when a newer run was already stored (this run changed nothing) or the pair failed. */
	applied: boolean;
	rows: number;
	ok: boolean;
}

export interface RankingsJobSummary {
	computedAt: number;
	/** Pairs written by this run. */
	applied: number;
	/** Pairs left untouched because a newer run is already stored. */
	skipped: number;
	/** Rows inserted by this run, all pairs together. */
	rows: number;
	/** `metric/window` of the pairs that threw (the others still ran). */
	failed: string[];
	pairs: RankingPairResult[];
}

/**
 * Recomputes every metric × window pair at `now` (the job passes the cron's scheduled time).
 * Idempotent: the same `now` gives the same rows, and a run older than the stored one changes
 * nothing. A failing pair does not stop the others; it is reported in `failed`.
 */
export async function runRankingsJob(db: D1Database, now: number): Promise<RankingsJobSummary> {
	if (!Number.isSafeInteger(now) || now < 0) throw new SocialRepoError('invalid-input');
	const pairs: RankingPairResult[] = [];
	const failed: string[] = [];
	for (const metric of RANKING_METRICS) {
		for (const window of RANKING_WINDOWS) {
			try {
				const result = await recomputeRankings(db, metric, window, now);
				pairs.push({ metric, window, applied: result.applied, rows: result.rows, ok: true });
			} catch (error) {
				const name = error instanceof Error ? error.name : typeof error;
				console.error(
					JSON.stringify({ event: 'rankings.pair_failed', metric, window, error: name })
				);
				failed.push(`${metric}/${window}`);
				pairs.push({ metric, window, applied: false, rows: 0, ok: false });
			}
		}
	}
	return {
		computedAt: now,
		applied: pairs.filter((pair) => pair.ok && pair.applied).length,
		skipped: pairs.filter((pair) => pair.ok && !pair.applied).length,
		rows: pairs.reduce((total, pair) => total + pair.rows, 0),
		failed,
		pairs
	};
}

// ---- Public cards ---------------------------------------------------------------------------

/**
 * A publicly listable lineage as the feed and the rankings publish it (public cache). Built field
 * by field from the summary: never the owner's user id, the curve's canonical key, gate version or
 * gate reasons, nor the lineage's moderation, status or visibility. The author is the nickname.
 */
export interface FeedLineageCard {
	id: string;
	curated: boolean;
	forked: boolean;
	author: AuthorCredit | null;
	createdAt: number;
	updatedAt: number;
	/** Head version (its id is the `versionId` of the curve-origin events). */
	head: {
		id: string;
		name: string;
		description: string;
		license: License;
		lang: Lang;
		createdAt: number;
	};
	/**
	 * Head curve (only standard curves are listed, except in the `yolo=only` feed, where every
	 * head is an acknowledged YOLO curve). `yolo` is always sent; optional in the type only for
	 * client fixtures written before 0013.
	 */
	curve: { id: string; s1: string; levelDb: number | null; yolo?: boolean };
}

/** One ranked lineage of GET /api/v1/rankings. */
export interface PublicRankingEntry {
	rank: number;
	score: number;
	computedAt: number;
	lineage: FeedLineageCard;
}

export function feedLineageCard(summary: LineageSummary): FeedLineageCard {
	const { author, head, curve } = summary;
	return {
		id: summary.id,
		curated: summary.curated,
		forked: summary.forkedFromVersion !== null,
		author:
			author === null
				? null
				: { username: author.username, displayUsername: author.displayUsername },
		createdAt: summary.createdAt,
		updatedAt: summary.updatedAt,
		head: {
			id: head.id,
			name: head.name,
			description: head.description,
			license: head.license,
			lang: head.lang,
			createdAt: head.createdAt
		},
		curve: { id: curve.id, s1: curve.s1, levelDb: curve.levelDb, yolo: curve.gateYolo }
	};
}

function publicRankingEntry(entry: RankingEntry): PublicRankingEntry {
	return {
		rank: entry.rank,
		score: entry.score,
		computedAt: entry.computedAt,
		lineage: feedLineageCard(entry.lineage)
	};
}

// ---- Reads ----------------------------------------------------------------------------------

export interface RankingsPage {
	metric: RankingMetric;
	window: RankingWindow;
	/** Time of the materialized run being served, or null before the first run. */
	computedAt: number | null;
	items: PublicRankingEntry[];
	nextCursor: string | null;
}

/** One page of a materialized ranking, best first (cursor = last rank served). */
export async function readRankings(
	db: D1Database,
	metric: RankingMetric,
	window: RankingWindow,
	page: PageRequest = {}
): Promise<RankingsPage> {
	if (!isOneOf(RANKING_METRICS, metric) || !isOneOf(RANKING_WINDOWS, window)) {
		throw new SocialRepoError('invalid-input');
	}
	const [state, list] = await Promise.all([
		getRankingState(db, metric, window),
		listRankings(db, metric, window, page)
	]);
	const computedAt = list.items[0]?.computedAt ?? state?.computedAt ?? null;
	return {
		metric,
		window,
		computedAt,
		items: list.items.map(publicRankingEntry),
		nextCursor: list.nextCursor
	};
}

export interface FeedItem {
	lineage: FeedLineageCard;
	/** Rank and score of the ranked sorts; null for `new`. */
	rank: number | null;
	score: number | null;
}

export interface FeedPage {
	sort: FeedSort;
	/** Window of the ranked sorts; null for `new` (it lists every public lineage). */
	window: RankingWindow | null;
	/** Run being served for the ranked sorts; null for `new` (a live query). */
	computedAt: number | null;
	items: FeedItem[];
	nextCursor: string | null;
}

export interface FeedRequest {
	sort: FeedSort;
	window?: RankingWindow;
	cursor?: string | null;
	limit?: number;
	/** `only`: the public YOLO lineages instead (sort `new` only; never mixed with the others). */
	yolo?: 'only';
}

/**
 * Public feed: `new` = newest publicly listable lineages (keyset on creation time and id);
 * `favorites` / `installs` = the materialized ranking of `window`. Private and unlisted lineages
 * never appear (both paths use the repository's public-listing predicate), nor YOLO heads. With
 * `yolo: 'only'`, the newest public lineages with an acknowledged YOLO head instead (`new` only:
 * YOLO is never ranked).
 */
export async function readFeed(db: D1Database, request: FeedRequest): Promise<FeedPage> {
	const { sort } = request;
	const page: PageRequest = {
		cursor: request.cursor ?? null,
		...(request.limit === undefined ? {} : { limit: request.limit })
	};
	if (request.yolo === 'only' && sort !== 'new') throw new SocialRepoError('invalid-input');
	if (sort === 'new') {
		const list = await listPublicFeed(
			db,
			request.yolo === 'only' ? { ...page, yolo: 'only' } : page
		);
		return {
			sort,
			window: null,
			computedAt: null,
			items: list.items.map((lineage) => ({
				lineage: feedLineageCard(lineage),
				rank: null,
				score: null
			})),
			nextCursor: list.nextCursor
		};
	}
	if (!isOneOf(FEED_SORTS, sort)) throw new SocialRepoError('invalid-input');
	const window = request.window ?? DEFAULT_WINDOW;
	const ranked = await readRankings(db, sort, window, page);
	return {
		sort,
		window,
		computedAt: ranked.computedAt,
		items: ranked.items.map((entry) => ({
			lineage: entry.lineage,
			rank: entry.rank,
			score: entry.score
		})),
		nextCursor: ranked.nextCursor
	};
}

// ---- Query parsing (routes) -----------------------------------------------------------------

const LIMIT = /^[1-9][0-9]{0,2}$/;

function invalidQuery(param: string): ApiError {
	return new ApiError(400, 'INVALID_BODY', { issues: [{ path: param, code: 'invalid_value' }] });
}

function enumParam<const T extends readonly string[]>(
	params: URLSearchParams,
	name: string,
	values: T,
	fallback: T[number]
): T[number] {
	const raw = params.get(name);
	if (raw === null || raw === '') return fallback;
	if (!isOneOf(values, raw)) throw invalidQuery(name);
	return raw;
}

function pageParams(params: URLSearchParams): PageRequest {
	const cursor = params.get('cursor');
	const rawLimit = params.get('limit');
	if (rawLimit !== null && rawLimit !== '' && !LIMIT.test(rawLimit)) throw invalidQuery('limit');
	return {
		cursor: cursor === null || cursor === '' ? null : cursor,
		...(rawLimit === null || rawLimit === '' ? {} : { limit: Number(rawLimit) })
	};
}

/** `?metric=&window=&cursor=&limit=` of GET /api/v1/rankings (400 INVALID_BODY when malformed). */
export function parseRankingsQuery(url: URL): {
	metric: RankingMetric;
	window: RankingWindow;
	page: PageRequest;
} {
	const params = url.searchParams;
	return {
		metric: enumParam(params, 'metric', RANKING_METRICS, DEFAULT_METRIC),
		window: enumParam(params, 'window', RANKING_WINDOWS, DEFAULT_WINDOW),
		page: pageParams(params)
	};
}

const YOLO_FILTERS = ['only'] as const;

/**
 * `?sort=&window=&cursor=&limit=&yolo=` of GET /api/v1/feed (400 INVALID_BODY when malformed).
 * `yolo=only` lists the public YOLO lineages and only with `sort=new` (a ranked sort is 400).
 */
export function parseFeedQuery(url: URL): FeedRequest {
	const params = url.searchParams;
	const page = pageParams(params);
	const sort = enumParam(params, 'sort', FEED_SORTS, DEFAULT_SORT);
	const raw = params.get('yolo');
	const yolo = raw === null || raw === '' ? null : enumParam(params, 'yolo', YOLO_FILTERS, 'only');
	if (yolo === 'only' && sort !== 'new') throw invalidQuery('sort');
	return {
		sort,
		window: enumParam(params, 'window', RANKING_WINDOWS, DEFAULT_WINDOW),
		cursor: page.cursor ?? null,
		...(page.limit === undefined ? {} : { limit: page.limit }),
		...(yolo === 'only' ? { yolo } : {})
	};
}

/** Repository errors of the read paths as API errors; anything else is rethrown unchanged. */
export function rankingsApiError(error: unknown): unknown {
	if (error instanceof SocialRepoError) {
		if (error.code === 'invalid-cursor') return new ApiError(400, 'INVALID_CURSOR');
		if (error.code === 'invalid-input') return new ApiError(400, 'INVALID_BODY');
	}
	return error;
}
