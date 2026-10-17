// Typed browser client of every `/api/v1` endpoint (T4.12b). Response DTOs come from the server
// modules through `import type` only: nothing under `#lib/server/**` is loaded at runtime here.
// Every request is same-origin with cookies; JSON bodies carry `content-type: application/json`;
// Turnstile tokens travel in `x-turnstile-token`. Failures become a `SocialApiError`.
import type { ApiErrorCode, ApiJson } from '#lib/server/api/errors.ts';
import type {
	ActivityEventInput,
	OutboxItemInput,
	OutboxResult
} from '#lib/server/social/activity.ts';
import type {
	AppendBody,
	ForkBody,
	ForkResult,
	LineageState,
	LineageVersions,
	PublishBody,
	PublishedCurve,
	PublishedInfo
} from '#lib/server/social/curves.ts';
import type { LibraryItem, LibraryShelf, MergeReport } from '#lib/server/social/library.ts';
import type { PackDto } from '#lib/server/social/packs.ts';
import type {
	FavoriteCard,
	LineageCard,
	PackCard,
	ProfileList,
	ProfileOverview
} from '#lib/server/social/profiles.ts';
import type {
	FeedLineageCard,
	FeedPage,
	FeedSort,
	PublicRankingEntry,
	RankingsPage
} from '#lib/server/social/rankings.ts';
import type { S6Preferences } from '#lib/server/social/s6.ts';
import type { CreateShareInput, CreatedShare, ShareFunnel } from '#lib/server/social/shares.ts';
import type { TradeDto } from '#lib/server/social/trades.ts';
import type {
	ActivityKind,
	ActivityRecord,
	Audience,
	Lang,
	License,
	LineageVisibility,
	PackRecord,
	PackVisibility,
	Page,
	RankingMetric,
	RankingWindow,
	ReportReason,
	ReportTargetKind
} from '#lib/server/social/types.ts';

export type {
	ActivityRecord,
	Audience,
	CreatedShare,
	FeedLineageCard,
	FeedPage,
	ForkResult,
	LibraryItem,
	LineageState,
	LineageVersions,
	MergeReport,
	OutboxItemInput,
	OutboxResult,
	PackDto,
	ProfileOverview,
	PublishedCurve,
	PublishedInfo,
	PublicRankingEntry,
	RankingsPage,
	S6Preferences,
	ShareFunnel,
	TradeDto
};

/** Every stable code of the API kit (mirror of `API_ERROR_CODES`; the `Record` keeps it total). */
const API_CODES: Readonly<Record<ApiErrorCode, true>> = {
	INVALID_BODY: true,
	UNSUPPORTED_MEDIA_TYPE: true,
	PAYLOAD_TOO_LARGE: true,
	BAD_ORIGIN: true,
	AUTH_REQUIRED: true,
	EMAIL_NOT_VERIFIED: true,
	BANNED: true,
	FORBIDDEN: true,
	NOT_FOUND: true,
	REAUTH_REQUIRED: true,
	CONFLICT: true,
	RATE_LIMITED: true,
	RATE_LIMIT_UNAVAILABLE: true,
	TURNSTILE_FAILED: true,
	INTERNAL: true,
	INVALID_CURSOR: true,
	INVALID_CURVE: true,
	GATE_REJECTED: true,
	HEAD_MOVED: true,
	ALREADY_ACTIVE: true,
	DUPLICATE: true,
	GONE: true,
	QUOTA_EXCEEDED: true,
	CONSENT_REQUIRED: true
};

/** `NETWORK`: the request never got an answer; `OFFLINE`: same, and the browser reports offline. */
export type SocialErrorCode = ApiErrorCode | 'NETWORK' | 'OFFLINE';

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
	return typeof value === 'string' && Object.hasOwn(API_CODES, value);
}

/** Normalized failure of a social request. `status` is 0 when no response arrived. */
export class SocialApiError extends Error {
	readonly status: number;
	readonly code: SocialErrorCode;
	/** Machine-readable details of the API error body (never user input). */
	declare readonly details?: ApiJson;
	/** `retry-after` of a 429/503, in milliseconds. */
	declare readonly retryAfterMs?: number;

	constructor(
		status: number,
		code: SocialErrorCode,
		details?: ApiJson,
		options: { retryAfterMs?: number; cause?: unknown } = {}
	) {
		super(code, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'SocialApiError';
		this.status = status;
		this.code = code;
		if (details !== undefined) this.details = details;
		if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
	}

	/** True when the request never reached the server (show the offline notice, keep local data). */
	get unreachable(): boolean {
		return this.code === 'NETWORK' || this.code === 'OFFLINE';
	}
}

export function isSocialApiError(value: unknown): value is SocialApiError {
	return value instanceof SocialApiError;
}

/** Code used when an error answer has no (known) JSON code: e.g. an HTML 502 of the edge. */
function fallbackCode(status: number): ApiErrorCode {
	switch (status) {
		case 400:
			return 'INVALID_BODY';
		case 401:
			return 'AUTH_REQUIRED';
		case 403:
			return 'FORBIDDEN';
		case 404:
			return 'NOT_FOUND';
		case 409:
			return 'CONFLICT';
		case 410:
			return 'GONE';
		case 413:
			return 'PAYLOAD_TOO_LARGE';
		case 415:
			return 'UNSUPPORTED_MEDIA_TYPE';
		case 429:
			return 'RATE_LIMITED';
		default:
			return 'INTERNAL';
	}
}

function isJsonValue(value: unknown): value is ApiJson {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== 'object') return false;
	return Object.values(value).every(isJsonValue);
}

function retryAfterMs(headers: Headers): number | undefined {
	const raw = headers.get('retry-after');
	if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return undefined;
	return Number(raw.trim()) * 1000;
}

/** Builds the `SocialApiError` of a non-2xx response (body read defensively). */
export async function errorFromResponse(response: Response): Promise<SocialApiError> {
	let code: ApiErrorCode = fallbackCode(response.status);
	let details: ApiJson | undefined;
	try {
		const body: unknown = await response.json();
		const error: unknown =
			typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined;
		if (typeof error === 'object' && error !== null) {
			const raw: unknown = Reflect.get(error, 'code');
			if (isApiErrorCode(raw)) code = raw;
			const rawDetails: unknown = Reflect.get(error, 'details');
			if (rawDetails !== undefined && isJsonValue(rawDetails)) details = rawDetails;
		}
	} catch (cause) {
		// Not JSON (edge error page): the status-based code stands.
		if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
	}
	const retry = retryAfterMs(response.headers);
	return new SocialApiError(
		response.status,
		code,
		details,
		retry === undefined ? {} : { retryAfterMs: retry }
	);
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

// ---- Request and response shapes not exported by the server -----------------------------------

export interface RequestOptions {
	signal?: AbortSignal;
}

export interface PageQuery {
	cursor?: string | null;
	limit?: number;
}

export interface FeedQuery extends PageQuery {
	sort?: FeedSort;
	window?: RankingWindow;
}

export interface RankingsQuery extends PageQuery {
	metric?: RankingMetric;
	window?: RankingWindow;
}

/** `POST /curves` body. The envelope is any S5 object; its content is validated by the server. */
export type PublishCurveInput = Omit<PublishBody, 'envelope'> & { envelope: object };
export type AppendVersionInput = Omit<AppendBody, 'envelope'> & { envelope: object };
export type ForkInput = Omit<ForkBody, 'envelope'> & { envelope?: object };

export interface FavoriteOn {
	favorited: true;
	/** False when the lineage was already a favorite (idempotent). */
	created: boolean;
}

export interface FavoriteOff {
	favorited: false;
	removed: boolean;
}

export type ActivityPostResult =
	{ status: 'recorded'; activity: ActivityRecord } | { status: 'duplicate' };

export interface LibraryQuery extends PageQuery {
	shelf: LibraryShelf;
	/** Filters the `created` shelf only. */
	visibility?: LineageVisibility;
}

export interface LibraryPage {
	shelf: LibraryShelf;
	items: LibraryItem[];
	nextCursor: string | null;
}

/** One anonymous browser-library item sent to `POST /me/library/merge` (max 100 per batch). */
export interface LibraryMergeItem {
	localId: string;
	s1: string;
	name: string;
	description?: string;
	lang?: Lang;
	license?: License;
}

export interface ProfileListItems {
	lineages: LineageCard;
	packs: PackCard;
	favorites: FavoriteCard;
}

export interface ProfileListPage<L extends ProfileList> {
	list: L;
	items: ProfileListItems[L][];
	nextCursor: string | null;
}

export type PackItemInput = string | { lineageId: string; license?: License };

export interface PackUpdateInput {
	name?: string;
	description?: string;
	visibility?: PackVisibility;
	/** Replaces the list, in this order. */
	items?: PackItemInput[];
}

export interface PackCreateInput extends PackUpdateInput {
	name: string;
}

export interface ReportInput {
	targetKind: ReportTargetKind;
	targetId: string;
	reason: ReportReason;
	/** Private note (only admins read it). */
	note?: string | null;
}

export interface S6PairInput {
	a: string;
	b: string;
	choice: 'a' | 'b' | 'tie';
	levelMatched: boolean;
}

export interface S6BatchInput {
	consentVersion: string;
	/** 32 random bytes kept only by this browser: the bearer secret to withdraw the batch. */
	receipt: string;
	pairs: S6PairInput[];
}

export interface TradeJoinInput {
	lineageId: string;
	versionId?: string;
}

export interface TradePage {
	items: TradeDto[];
	nextCursor: string | null;
}

export interface MyActivityDeleteFilter {
	lineageId?: string;
	kind?: ActivityKind;
}

/** One pack of `GET /me/packs` (any visibility; the owner is the caller). */
export type MyPackItem = Omit<PackRecord, 'ownerUserId'>;

/** One share link of `GET /me/shares`; `lineage.name` is null when the caller cannot read it. */
export interface MyShareItem {
	id: string;
	lineage: { id: string; name: string | null };
	versionId: string | null;
	channel: string | null;
	createdAt: number;
}

// ---- Client -------------------------------------------------------------------------------------

export type SocialFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface SocialApiOptions {
	fetch?: SocialFetch;
	/** Prefix of every URL (default: relative, same origin). No trailing slash. */
	origin?: string;
	/** Whether the browser reports a connection (tells `OFFLINE` from `NETWORK`). */
	online?: () => boolean;
}

type Query = Record<string, string | number | null | undefined>;

function queryString(query: Query): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === '') continue;
		params.set(key, String(value));
	}
	const text = params.toString();
	return text === '' ? '' : `?${text}`;
}

const seg = encodeURIComponent;

function browserOnline(): boolean {
	const nav: unknown = globalThis.navigator;
	if (typeof nav !== 'object' || nav === null) return true;
	return Reflect.get(nav, 'onLine') !== false;
}

export function createSocialApi(options: SocialApiOptions = {}) {
	const fetcher: SocialFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const origin = (options.origin ?? '').replace(/\/+$/, '');
	const online = options.online ?? browserOnline;

	async function send(
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		path: string,
		init: { body?: unknown; turnstile?: string; signal?: AbortSignal | undefined } = {}
	): Promise<Response> {
		const headers: Record<string, string> = { accept: 'application/json' };
		if (init.body !== undefined) headers['content-type'] = 'application/json';
		if (init.turnstile !== undefined) headers['x-turnstile-token'] = init.turnstile;
		const request: RequestInit = { method, credentials: 'same-origin', headers };
		if (init.body !== undefined) request.body = JSON.stringify(init.body);
		if (init.signal) request.signal = init.signal;
		let response: Response;
		try {
			response = await fetcher(`${origin}/api/v1${path}`, request);
		} catch (cause) {
			if (isAbort(cause)) throw cause;
			throw new SocialApiError(0, online() ? 'NETWORK' : 'OFFLINE', undefined, { cause });
		}
		if (!response.ok) throw await errorFromResponse(response);
		return response;
	}

	async function call<T>(
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		path: string,
		init: { body?: unknown; turnstile?: string; signal?: AbortSignal | undefined } = {}
	): Promise<T> {
		const response = await send(method, path, init);
		try {
			const parsed: T = await response.json();
			return parsed;
		} catch (cause) {
			if (isAbort(cause)) throw cause;
			throw new SocialApiError(response.status, 'INTERNAL', undefined, { cause });
		}
	}

	async function empty(
		method: 'POST' | 'DELETE',
		path: string,
		init: { signal?: AbortSignal | undefined } = {}
	): Promise<void> {
		await send(method, path, init);
	}

	return {
		// Feed and rankings (public).
		feed: (query: FeedQuery = {}, opts: RequestOptions = {}) =>
			call<FeedPage>('GET', `/feed${queryString({ ...query })}`, opts),
		rankings: (query: RankingsQuery = {}, opts: RequestOptions = {}) =>
			call<RankingsPage>('GET', `/rankings${queryString({ ...query })}`, opts),

		// Curves and lineages.
		getCurve: (lineageId: string, query: { versionId?: string } = {}, opts: RequestOptions = {}) =>
			call<PublishedCurve>(
				'GET',
				`/curves/${seg(lineageId)}${queryString({ v: query.versionId })}`,
				opts
			),
		publishCurve: (body: PublishCurveInput, opts: RequestOptions = {}) =>
			call<PublishedInfo>('POST', '/curves', { ...opts, body }),
		getLineage: (lineageId: string, query: PageQuery = {}, opts: RequestOptions = {}) =>
			call<LineageVersions>('GET', `/lineages/${seg(lineageId)}${queryString({ ...query })}`, opts),
		appendVersion: (lineageId: string, body: AppendVersionInput, opts: RequestOptions = {}) =>
			call<PublishedInfo>('POST', `/lineages/${seg(lineageId)}/versions`, { ...opts, body }),
		forkLineage: (lineageId: string, body: ForkInput = {}, opts: RequestOptions = {}) =>
			call<ForkResult>('POST', `/lineages/${seg(lineageId)}/fork`, { ...opts, body }),
		retractLineage: (lineageId: string, opts: RequestOptions = {}) =>
			call<LineageState>('POST', `/lineages/${seg(lineageId)}/retract`, opts),
		restoreLineage: (lineageId: string, opts: RequestOptions = {}) =>
			call<LineageState>('POST', `/lineages/${seg(lineageId)}/restore`, opts),
		setVisibility: (lineageId: string, visibility: LineageVisibility, opts: RequestOptions = {}) =>
			call<LineageState>('PUT', `/lineages/${seg(lineageId)}/visibility`, {
				...opts,
				body: { visibility }
			}),

		// Favorites, activity and audience.
		favorite: (lineageId: string, query: { shareId?: string } = {}, opts: RequestOptions = {}) =>
			call<FavoriteOn>(
				'PUT',
				`/curves/${seg(lineageId)}/favorite${queryString({ s: query.shareId })}`,
				opts
			),
		unfavorite: (lineageId: string, opts: RequestOptions = {}) =>
			call<FavoriteOff>('DELETE', `/curves/${seg(lineageId)}/favorite`, opts),
		postActivity: (lineageId: string, body: ActivityEventInput, opts: RequestOptions = {}) =>
			call<ActivityPostResult>('POST', `/curves/${seg(lineageId)}/activity`, { ...opts, body }),
		audience: (lineageId: string, opts: RequestOptions = {}) =>
			call<{ audience: Audience }>('GET', `/curves/${seg(lineageId)}/audience`, opts),

		// The caller's own data.
		myActivity: (query: PageQuery = {}, opts: RequestOptions = {}) =>
			call<Page<ActivityRecord>>('GET', `/me/activity${queryString({ ...query })}`, opts),
		deleteMyActivity: (filter: MyActivityDeleteFilter = {}, opts: RequestOptions = {}) =>
			call<{ deleted: number }>('DELETE', `/me/activity${queryString({ ...filter })}`, opts),
		postActivityOutbox: (events: OutboxItemInput[], opts: RequestOptions = {}) =>
			call<{ results: OutboxResult[] }>('POST', '/me/activity/outbox', {
				...opts,
				body: { events }
			}),
		myLibrary: (query: LibraryQuery, opts: RequestOptions = {}) =>
			call<LibraryPage>('GET', `/me/library${queryString({ ...query })}`, opts),
		mergeLibrary: (items: LibraryMergeItem[], opts: RequestOptions = {}) =>
			call<MergeReport>('POST', '/me/library/merge', { ...opts, body: { items } }),
		myPacks: (query: PageQuery = {}, opts: RequestOptions = {}) =>
			call<Page<MyPackItem>>('GET', `/me/packs${queryString({ ...query })}`, opts),
		myShares: (query: PageQuery = {}, opts: RequestOptions = {}) =>
			call<Page<MyShareItem>>('GET', `/me/shares${queryString({ ...query })}`, opts),

		// Shares.
		createShare: (body: CreateShareInput, opts: RequestOptions = {}) =>
			call<CreatedShare>('POST', '/shares', { ...opts, body }),
		shareStats: (shareId: string, opts: RequestOptions = {}) =>
			call<ShareFunnel>('GET', `/shares/${seg(shareId)}/stats`, opts),
		openShare: (shareId: string, opts: RequestOptions = {}) =>
			empty('POST', `/shares/${seg(shareId)}/open`, opts),

		// Profiles and packs.
		getUser: (nickname: string, opts: RequestOptions = {}) =>
			call<ProfileOverview>('GET', `/users/${seg(nickname)}`, opts),
		getUserList: <L extends ProfileList>(
			nickname: string,
			list: L,
			query: PageQuery = {},
			opts: RequestOptions = {}
		) =>
			call<ProfileListPage<L>>(
				'GET',
				`/users/${seg(nickname)}${queryString({ list, ...query })}`,
				opts
			),
		getPack: (packId: string, opts: RequestOptions = {}) =>
			call<PackDto>('GET', `/packs/${seg(packId)}`, opts),
		createPack: (body: PackCreateInput, opts: RequestOptions = {}) =>
			call<PackDto>('POST', '/packs', { ...opts, body }),
		updatePack: (packId: string, body: PackUpdateInput, opts: RequestOptions = {}) =>
			call<PackDto>('PUT', `/packs/${seg(packId)}`, { ...opts, body }),
		deletePack: (packId: string, opts: RequestOptions = {}) =>
			empty('DELETE', `/packs/${seg(packId)}`, opts),

		// Moderation.
		report: (body: ReportInput, turnstileToken: string, opts: RequestOptions = {}) =>
			call<{ reported: true }>('POST', '/reports', { ...opts, body, turnstile: turnstileToken }),

		// S6 (anonymous blind-test preferences).
		postS6Batch: (body: S6BatchInput, turnstileToken: string, opts: RequestOptions = {}) =>
			call<{ ok: true }>('POST', '/s6/batches', { ...opts, body, turnstile: turnstileToken }),
		deleteS6Batch: (receipt: string, opts: RequestOptions = {}) =>
			empty('DELETE', `/s6/batches/${seg(receipt)}`, opts),
		s6Preferences: (opts: RequestOptions = {}) =>
			call<S6Preferences>('GET', '/s6/preferences', opts),

		// S7 blind trades.
		joinTrade: (body: TradeJoinInput, opts: RequestOptions = {}) =>
			call<{ trade: TradeDto }>('POST', '/trades', { ...opts, body }),
		myTrades: (query: PageQuery = {}, opts: RequestOptions = {}) =>
			call<TradePage>('GET', `/trades/me${queryString({ ...query })}`, opts),
		scoreTrade: (tradeId: string, score: 1 | 2 | 3 | 4 | 5, opts: RequestOptions = {}) =>
			call<{ revealed: boolean; trade: TradeDto }>('POST', `/trades/${seg(tradeId)}/score`, {
				...opts,
				body: { score }
			}),
		cancelTrade: (tradeId: string, opts: RequestOptions = {}) =>
			call<{ cancelled: true }>('DELETE', `/trades/${seg(tradeId)}`, opts),

		/** Public OG image of a version (`/og/<versionId>.png`); not an API call. */
		ogImageUrl: (versionId: string) => `${origin}/og/${seg(versionId)}.png`
	};
}

export type SocialApi = ReturnType<typeof createSocialApi>;
