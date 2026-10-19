// Types, enums and limits of the social schema (migrations 0004-0006). Enums are `as const` arrays
// matching the CHECK constraints of the migrations; DTOs are what repo.ts returns (camelCase,
// epoch-ms numbers, booleans). No runtime dependency besides the guards below.

export const LINEAGE_VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type LineageVisibility = (typeof LINEAGE_VISIBILITIES)[number];

export const LINEAGE_STATUSES = ['active', 'retracted'] as const;
export type LineageStatus = (typeof LINEAGE_STATUSES)[number];

export const MODERATION_STATES = ['visible', 'auto_hidden', 'hidden', 'removed'] as const;
export type ModerationState = (typeof MODERATION_STATES)[number];

export const LICENSES = ['CC0-1.0', 'CC-BY-4.0'] as const;
export type License = (typeof LICENSES)[number];

export const LANGS = ['pt-BR', 'en-US'] as const;
export type Lang = (typeof LANGS)[number];

export const ACTIVITY_KINDS = ['previewed', 'installed'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const SHARE_EVENT_KINDS = ['open', 'previewed', 'installed', 'favorited'] as const;
export type ShareEventKind = (typeof SHARE_EVENT_KINDS)[number];

/** Kinds a signed-in user can be attributed with (opens are always anonymous). */
export const SHARE_USER_EVENT_KINDS = ['previewed', 'installed', 'favorited'] as const;
export type ShareUserEventKind = (typeof SHARE_USER_EVENT_KINDS)[number];

export const PACK_VISIBILITIES = LINEAGE_VISIBILITIES;
export type PackVisibility = LineageVisibility;

export const REPORT_TARGET_KINDS = ['lineage', 'pack', 'user'] as const;
export type ReportTargetKind = (typeof REPORT_TARGET_KINDS)[number];

export const REPORT_REASONS = [
	'dangerous',
	'spam',
	'offensive',
	'copyright',
	'impersonation',
	'other'
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_RESOLUTIONS = ['dismissed', 'hidden', 'removed', 'restored', 'banned'] as const;
export type ReportResolution = (typeof REPORT_RESOLUTIONS)[number];

export const S6_CHOICES = ['a', 'b', 'tie'] as const;
export type S6Choice = (typeof S6_CHOICES)[number];

export const TRADE_STATUSES = ['waiting', 'matched', 'revealed', 'expired', 'cancelled'] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];

export const RANKING_METRICS = ['favorites', 'installs'] as const;
export type RankingMetric = (typeof RANKING_METRICS)[number];

export const RANKING_WINDOWS = ['7d', '30d', 'all'] as const;
export type RankingWindow = (typeof RANKING_WINDOWS)[number];

/** Stable error codes of the repository; services map them to HTTP statuses. */
export const SOCIAL_ERROR_CODES = [
	'not-found',
	'invalid-input',
	'invalid-cursor',
	'head-moved',
	'gate-rejected',
	'retracted',
	'duplicate',
	'already-active',
	'limit'
] as const;
export type SocialErrorCode = (typeof SOCIAL_ERROR_CODES)[number];

export class SocialRepoError extends Error {
	readonly code: SocialErrorCode;
	constructor(code: SocialErrorCode, message: string = code) {
		super(message);
		this.name = 'SocialRepoError';
		this.code = code;
	}
}

export type RepoResult<T> = { ok: true; value: T } | { ok: false; code: SocialErrorCode };

export const DAY_MS = 24 * 60 * 60 * 1000;
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 1000;
export const NOTE_MAX = 500;
export const RECIPE_MAX = 16384;
/** Serialized `versions.labels` JSON (migration 0012 CHECK: `length(labels) <= 1024`). */
export const LABELS_JSON_MAX = 1024;
/** Filter labels by wire index (exactly ten entries, null = automatic name). */
export type VersionLabels = (string | null)[];
export const PACK_ITEMS_MAX = 100;
export const S6_PAIRS_MAX = 100;
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;
/** Ids accepted by the batch lookups (counts, trade averages, library merge). */
export const LOOKUP_IDS_MAX = 100;
export const AUDIENCE_NAMES_MAX = 50;
export const RANKING_MAX_ROWS = 1000;
export const TRADE_TTL_MS = 72 * 60 * 60 * 1000;
export const RANKING_WINDOW_MS: Readonly<Record<RankingWindow, number | null>> = {
	'7d': 7 * DAY_MS,
	'30d': 30 * DAY_MS,
	all: null
};

export function isOneOf<const T extends readonly string[]>(
	values: T,
	value: unknown
): value is T[number] {
	return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Who is reading. `admin` must be set explicitly (it is never inferred from the user id). */
export interface Viewer {
	readonly userId: string | null;
	readonly admin?: boolean;
}

export const ANONYMOUS_VIEWER: Viewer = { userId: null };

/**
 * The YOLO publication kill switch (`YOLO_PUBLICATION`, ServerEnv `yoloPublication`) as the
 * visibility predicates take it. 'off' (the default of every predicate and read): no YOLO head is
 * served to anyone but its owner (or an admin), acknowledged or not: not by id, not in
 * `feed?yolo=only`, not as an OG card nor as a fork source. 'on': a YOLO head its owner
 * acknowledged opens by id and lists in `feed?yolo=only` (never in the other lists).
 */
export type YoloPublication = 'on' | 'off';

export interface Page<T> {
	items: T[];
	/** Opaque cursor of the next page, or null on the last page. */
	nextCursor: string | null;
}

export interface PageRequest {
	cursor?: string | null;
	limit?: number;
}

// ---- Curves, lineages, versions -------------------------------------------------------------

/**
 * Cached class of a curve (migration 0013): `gateOk` = standard, `gateYolo` = YOLO (never both),
 * neither = rejected. `gateReasons`: [] for standard, the waived codes for YOLO, the standard codes
 * plus the YOLO-only blocking codes for rejected.
 */
export interface CurveRecord {
	id: string;
	s1: string;
	canonKey: string;
	gateVer: string;
	gateOk: boolean;
	gateYolo: boolean;
	gateReasons: string[];
	levelDb: number | null;
	createdAt: number;
}

/** Curve plus the gate result, as written by the publication path. */
export interface CurveInput {
	id: string;
	s1: string;
	canonKey: string;
	gateVer: string;
	gateOk: boolean;
	/** YOLO class (absent = false); never true together with `gateOk`. */
	gateYolo?: boolean;
	gateReasons: readonly string[];
	levelDb: number | null;
}

export interface VersionInput {
	id: string;
	name: string;
	description: string;
	license: License;
	/** S5 recipe, already serialized JSON, or null. */
	recipe: string | null;
	lang: Lang;
	/**
	 * Filter labels of an `open-auri/preset@2` envelope (normalized by core `normalizeLabels`),
	 * or null/absent. Presentation only: never part of the curve row, its id or the gate.
	 */
	labels?: VersionLabels | null;
}

export interface VersionRecord {
	id: string;
	lineageId: string;
	parentId: string | null;
	curveId: string;
	name: string;
	description: string;
	license: License;
	recipe: string | null;
	lang: Lang;
	/** `versions.labels` (migration 0012); null for versions without labels. */
	labels: VersionLabels | null;
	createdAt: number;
}

export interface LineageRecord {
	id: string;
	ownerUserId: string | null;
	forkedFromVersion: string | null;
	headVersion: string | null;
	visibility: LineageVisibility;
	status: LineageStatus;
	moderation: ModerationState;
	curated: boolean;
	createdAt: number;
	updatedAt: number;
}

/** Public credit of an author: the nickname only, null for "autor removido". */
export interface AuthorCredit {
	username: string;
	displayUsername: string;
}

/** A lineage with its head version and head curve, as listed and shown. */
export interface LineageSummary extends LineageRecord {
	author: AuthorCredit | null;
	head: VersionRecord;
	curve: CurveRecord;
}

export interface PublishInput {
	lineageId: string;
	ownerUserId: string;
	visibility: LineageVisibility;
	curve: CurveInput;
	version: VersionInput;
	forkedFromVersion?: string | null;
	/**
	 * Writes the owner's YOLO acknowledgement of (lineage, curve) in the same batch (only for a
	 * YOLO curve; the service decides when it is required).
	 */
	yoloAck?: boolean;
	now: number;
}

export interface AppendVersionInput {
	lineageId: string;
	ownerUserId: string;
	/** The head the client saw; the append fails with 'head-moved' when it is not the head. */
	expectedHead: string;
	curve: CurveInput;
	version: VersionInput;
	/** Same as PublishInput.yoloAck; written only when the version is inserted. */
	yoloAck?: boolean;
	now: number;
}

export type LineageListFilter = { visibility?: LineageVisibility };

// ---- Favorites, activity, audience ----------------------------------------------------------

export interface ActivityRecord {
	lineageId: string;
	kind: ActivityKind;
	firstAt: number;
	lastAt: number;
	count: number;
}

export interface LibraryEntry {
	lineage: LineageSummary;
	/** When it was favorited, or last installed. */
	at: number;
}

export interface PublicCounts {
	favorites: number;
	previewed: number;
	installed: number;
}

export interface AudienceGroup {
	/** Distinct verified, non-banned users (the owner excluded). */
	total: number;
	/** Users with activity_visibility = 'public', most recent first (at most AUDIENCE_NAMES_MAX). */
	named: { username: string; displayUsername: string; at: number }[];
	/** Users counted in `total` whose activity is private ("N pessoas com perfil privado"). */
	privateCount: number;
}

export interface Audience {
	previewed: AudienceGroup;
	installed: AudienceGroup;
	favorited: AudienceGroup;
}

// ---- Shares ---------------------------------------------------------------------------------

export interface ShareRecord {
	id: string;
	lineageId: string;
	versionId: string | null;
	ownerUserId: string;
	channel: string | null;
	createdAt: number;
}

export interface ShareStats {
	shareId: string;
	/** Anonymous daily counters, oldest day first. */
	days: { day: string; kind: ShareEventKind; count: number }[];
	totals: Record<ShareEventKind, { anonymous: number; users: number }>;
}

// ---- Packs ----------------------------------------------------------------------------------

export interface PackRecord {
	id: string;
	ownerUserId: string | null;
	name: string;
	description: string;
	visibility: PackVisibility;
	moderation: ModerationState;
	createdAt: number;
	updatedAt: number;
}

export interface PackItem {
	position: number;
	license: License;
	lineage: LineageSummary;
}

export interface PackView extends PackRecord {
	author: AuthorCredit | null;
	items: PackItem[];
}

export interface PackInput {
	id: string;
	ownerUserId: string;
	name: string;
	description: string;
	visibility: PackVisibility;
	now: number;
}

// ---- Reports --------------------------------------------------------------------------------

export interface ReportInput {
	id: string;
	targetKind: ReportTargetKind;
	targetId: string;
	reason: ReportReason;
	note: string | null;
	reporterUserId: string;
	now: number;
}

export interface ReportRecord {
	id: string;
	targetKind: ReportTargetKind;
	targetId: string;
	reason: ReportReason;
	note: string | null;
	reporterUserId: string | null;
	createdAt: number;
	resolution: ReportResolution | null;
	resolvedAt: number | null;
}

export interface ReportQueueEntry {
	targetKind: ReportTargetKind;
	targetId: string;
	openReports: number;
	firstAt: number;
	lastAt: number;
}

// ---- Rankings -------------------------------------------------------------------------------

export interface RankingEntry {
	rank: number;
	score: number;
	computedAt: number;
	lineage: LineageSummary;
}

// ---- S6 and S7 ------------------------------------------------------------------------------

export interface S6PairInput {
	a: string;
	b: string;
	choice: S6Choice;
	levelMatched: boolean;
}

export interface S6BatchInput {
	id: string;
	receiptHash: string;
	consentVer: string;
	day: string;
	pairs: readonly S6PairInput[];
}

export interface S6PairRecord extends S6PairInput {
	id: number;
	day: string;
}

export interface TradeRecord {
	id: string;
	userId: string;
	lineageId: string;
	versionId: string;
	status: TradeStatus;
	matchId: string | null;
	score: number | null;
	createdAt: number;
	matchedAt: number | null;
	scoredAt: number | null;
	expiresAt: number;
}

/**
 * A trade as its owner sees it. The partner's curve is given once matched (blind preview); the
 * partner's lineage, version and score only once revealed. Never the partner's identity.
 */
export interface TradeView extends TradeRecord {
	partner: {
		curveId: string;
		s1: string;
		lineageId: string | null;
		versionId: string | null;
		score: number | null;
	} | null;
}

export type PairResult = { status: 'matched'; matchId: string } | { status: 'waiting' };

// ---- Profiles -------------------------------------------------------------------------------

export interface PublicProfile {
	/** Internal id, for the follow-up library queries; never part of an API response. */
	userId: string;
	username: string;
	displayUsername: string;
	bio: string | null;
	libraryVisibility: 'private' | 'public';
	activityVisibility: 'private' | 'public';
	counts: { lineages: number; packs: number };
}
