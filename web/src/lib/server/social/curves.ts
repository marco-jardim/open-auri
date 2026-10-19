// Curves service (T4.2): publication of S5 envelopes (S1 inside), new versions (Total Recall,
// append-only), forks, retraction (tombstone), owner restore and visibility, plus the read DTO of
// `GET /api/v1/curves/[id]` (reused by `/c/[id]` and the OG image).
//
// Publication path (one function for publish, version and fork): zod shape (route) → daily quota
// → `validateEnvelope` (core: normalized text, S1 equal to the bands) → `checkCurve` (the only gate
// entry point, cached per curve id and gate version) → repository write. Invariant §0.12.4: no path
// makes a gate-rejected curve visible. Publish, version and fork gate the new curve; fork, restore
// and visibility changes that open a lineage re-gate its head first; the database trigger refuses
// any version on a rejected curve; the visibility predicates hide lineages whose head fails.
// Lazy re-gate: every by-id read or action (curve read, history, fork, append, retract, restore,
// visibility) re-gates a head (or requested version) whose cached verdict is not current before
// answering, then reads it again, so a head that now fails is no longer linkable. A head (or
// version) the readable rows hide because it is cached as rejected under a stale gate version is
// re-gated the same way (#27), so it is served once the current gate accepts it; a still-rejected
// one answers exactly like a missing id.
// Two daily quotas per user: successful publications (versions created) and attempts that reach
// the gate (accepted or rejected), which bounds the gate CPU a user can spend.
//
// YOLO (docs/social.md "Classes de curva"): the class is derived on the server (`checkPublishable`),
// never declared by the client. A YOLO curve may always be saved privately. A write that leaves a
// YOLO head visible to others (unlisted or public: publish, append, fork, visibility change,
// restore) needs, in this order: the kill switch on (`YOLO_PUBLICATION`, default off: 403
// YOLO_PUBLICATION_OFF), an account at least 72 h old (403 FORBIDDEN, `details.reason:
// 'account-age'`), `acknowledge: 'yolo'` in the body (409 YOLO_ACK_REQUIRED with
// `details.waived`) and a slot of YOLO_ACKS_DAILY_MAX per sliding day (429 QUOTA_EXCEEDED). The
// slot is taken atomically right before the write (writeWithAckSlot: the cap holds under
// concurrency) and given back when the write fails (a failed write consumes nothing); the
// acknowledgement row is written in the same batch as the write. Reads follow the same switch:
// while it is off, no YOLO head is served to anyone but its owner (curve, history, fork source),
// and a restore leaves a non-private YOLO lineage private (see restoreCurve).
//
// The YOLO decision depends on two pieces of lineage state, its head's class and its visibility,
// and both can change between the read and the write (an append vs a visibility change). Every
// write applies only while the lineage still has the state its decision used: an append of a YOLO
// curve only while the lineage keeps the visibility read (appendVersion `expectedVisibility`), an
// opening visibility change or a restore only while the head classified is still the head (and,
// for a restore, the visibility read). When the state moved, the batch writes nothing (no
// acknowledgement either, and the slot is given back) and the service reads the lineage again and
// re-applies the rules, up to STATE_ATTEMPTS times (then 409 HEAD_MOVED). So a lineage never
// ends visible to others with a YOLO head its owner did not acknowledge for that visibility.
import type { D1Database } from '@cloudflare/workers-types';
import type { gateForWrite } from 'open-auri/safety';
import { curveId, decodeS1, envelopeFormat, S1Error, validateEnvelope } from 'open-auri/share';
import { z } from 'zod';
import { ApiError, CACHE_PUBLIC_60, cached, json } from '#lib/server/api/index.ts';
import {
	rateLimitKey,
	releaseWindowSlot,
	slidingWindowLimit,
	takeWindowSlot,
	type WindowRule,
	type WindowSlot
} from '#lib/server/security/ratelimit.ts';
import {
	recordGateRejection,
	type MetricsDataset,
	type PublicationPath
} from '#lib/server/observability/metrics.ts';
import {
	checkPublishable,
	hardCodes,
	isGateCurrent,
	regateCurve,
	regateRejectedHead,
	regateRejectedVersion
} from '#lib/server/social/gate.ts';
import { MIN_REPORTER_AGE_MS } from '#lib/server/social/moderation.ts';
import { isLinkableTombstone } from '#lib/server/social/queries/curves.ts';
import {
	accountCreatedBy,
	appendVersion,
	countsForLineages,
	countVersionsSince,
	forkLineage,
	getCurve,
	getLineageForViewer,
	getVersionForViewer,
	isSocialId,
	listVersions,
	publishLineage,
	restoreLineage,
	retractLineage,
	setLineageVisibility,
	type VersionView
} from '#lib/server/social/repo.ts';
import {
	DAY_MS,
	LINEAGE_VISIBILITIES,
	SocialRepoError,
	type AuthorCredit,
	type CurveInput,
	type CurveRecord,
	type Lang,
	type License,
	type LineageStatus,
	type LineageSummary,
	type LineageVisibility,
	type ModerationState,
	type PageRequest,
	type PublicCounts,
	type RepoResult,
	type SocialErrorCode,
	type VersionInput,
	type VersionLabels,
	type VersionRecord,
	type Viewer,
	type YoloPublication
} from '#lib/server/social/types.ts';

// ---- Limits and body schemas ----------------------------------------------------------------

/** Publications + new versions + forks per user and UTC day (counted with countVersionsSince). */
export const DAILY_PUBLICATION_QUOTA = 30;

/**
 * Attempts that reach the gate (publish, version, fork; accepted or rejected) per user over a
 * sliding day (D1 sliding window of the security kit). Rejected attempts are not publications, so
 * without this a user could spend unbounded gate CPU.
 */
export const DAILY_GATE_ATTEMPT_QUOTA = 60;

const GATE_ATTEMPT_GROUP = 'curves.gate';

/**
 * YOLO acknowledgements (writes that open a YOLO head to others) per user over a sliding day (D1
 * sliding window of the security kit, group `curves.yolo.ack`).
 */
export const YOLO_ACKS_DAILY_MAX = 5;

const YOLO_ACK_GROUP = 'curves.yolo.ack';

/** Minimum account age to open a YOLO lineage to others: the reporter age of moderation (72 h). */
export const YOLO_MIN_ACCOUNT_AGE_MS = MIN_REPORTER_AGE_MS;

/**
 * Writes of an append, a visibility change or a restore whose lineage state (head, visibility)
 * moved under them before 409 HEAD_MOVED (see the file header): each new attempt reads the lineage
 * again and re-applies the YOLO rules.
 */
export const STATE_ATTEMPTS = 3;

/** Kill switch of YOLO publication (`YOLO_PUBLICATION`): `off` (default) = private only. */
export type { YoloPublication };

/** Request body cap of the curve writes (the normalized envelope itself is at most 8 KiB). */
export const CURVE_BODY_MAX_BYTES = 32 * 1024;

/** Shape only: the envelope's content is validated by the core (`validateEnvelope`). */
const EnvelopeShape = z.record(z.string(), z.unknown());
const Visibility = z.enum(LINEAGE_VISIBILITIES);
const IdShape = z.string().min(1).max(64);
/** The owner's acknowledgement that a YOLO curve is shown to others (see the file header). */
const Acknowledge = z.literal('yolo').optional();

export const PublishBodySchema = z.object({
	envelope: EnvelopeShape,
	visibility: Visibility,
	acknowledge: Acknowledge
});
export const AppendBodySchema = z.object({
	parentVersionId: IdShape,
	envelope: EnvelopeShape,
	acknowledge: Acknowledge
});
/** Fork: `versionId` defaults to the head, `visibility` to private, `envelope` to a copy. */
export const ForkBodySchema = z.object({
	versionId: IdShape.optional(),
	visibility: Visibility.optional(),
	envelope: EnvelopeShape.optional(),
	acknowledge: Acknowledge
});
export const VisibilityBodySchema = z.object({ visibility: Visibility, acknowledge: Acknowledge });
/** Restore: an optional body, only for the YOLO acknowledgement. */
export const RestoreBodySchema = z.object({ acknowledge: Acknowledge });

export type PublishBody = z.infer<typeof PublishBodySchema>;
export type AppendBody = z.infer<typeof AppendBodySchema>;
export type ForkBody = z.infer<typeof ForkBodySchema>;
export type Acknowledgement = 'yolo' | undefined;

// ---- Types ----------------------------------------------------------------------------------

export interface PublishedInfo {
	lineageId: string;
	versionId: string;
	curveId: string;
	/**
	 * The new head is a YOLO curve (class derived on the server). Always sent; optional in the type
	 * only so client fixtures written before 0013 keep compiling.
	 */
	yolo?: boolean;
}

export interface CurveDeps {
	/** Called after every successful publish, version or fork (OG warm-up hook, T4.7). */
	onPublished?: (info: PublishedInfo) => void;
	/**
	 * Gate injection for tests (default: the core's gateForWrite through checkPublishable); every
	 * run of a classification, standard and YOLO profile, goes through it.
	 */
	gate?: typeof gateForWrite;
	/**
	 * Kill switch of YOLO publication (ServerEnv `yoloPublication`); absent = 'off'. Writes: a YOLO
	 * head is opened to others only while 'on'. Reads (curve, history, fork source): while 'off' no
	 * YOLO head is served to anyone but its owner (or an admin), acknowledged or not.
	 */
	yoloPublication?: YoloPublication;
	now?: number;
	/** Analytics Engine dataset (T5.2): gate rejections of the publication path, by reason. */
	metrics?: MetricsDataset | null;
	/**
	 * Tests only: awaited between the reads an append, a visibility change or a restore relied on
	 * and its write (attempt 1, then once per retry), to run a concurrent request in that window.
	 */
	beforeWrite?: (attempt: number) => Promise<void>;
}

/** Credit a CC-BY 4.0 fork must keep (null for CC0 sources). */
export interface Attribution {
	license: 'CC-BY-4.0';
	lineageId: string;
	versionId: string;
	name: string;
	/** Nickname of the source's author; null = "autor removido". */
	author: AuthorCredit | null;
}

export interface ForkResult extends PublishedInfo {
	forkedFrom: { lineageId: string; versionId: string };
	attribution: Attribution | null;
}

export interface LineageState {
	lineageId: string;
	status: LineageStatus;
	visibility: LineageVisibility;
	moderation: ModerationState;
}

export interface LineageDto {
	id: string;
	visibility: LineageVisibility;
	status: LineageStatus;
	moderation: ModerationState;
	curated: boolean;
	forkedFromVersion: string | null;
	headVersion: string | null;
	createdAt: number;
	updatedAt: number;
	isOwner: boolean;
}

export interface VersionDto {
	id: string;
	parentId: string | null;
	curveId: string;
	name: string;
	description: string;
	license: License;
	lang: Lang;
	/**
	 * Filter labels by wire index of the version's S1 (ten entries, null = automatic name), or
	 * null. Detail and history only: never in list or feed cards, OG images or blind trades.
	 */
	labels: VersionLabels | null;
	createdAt: number;
	isHead: boolean;
}

/** DTO of `GET /api/v1/curves/[id]`. */
export interface PublishedCurve {
	lineage: LineageDto;
	/** Nickname credit; null = "autor removido". */
	author: AuthorCredit | null;
	version: VersionDto & { recipe: unknown };
	curve: {
		id: string;
		s1: string;
		levelDb: number | null;
		/** `ok` = standard (unchanged meaning); a YOLO curve has `ok: false` and `yolo: true`. */
		gate: { ok: boolean; reasons: string[]; version: string };
		/** YOLO class, derived on the server (always sent; optional for older client fixtures). */
		yolo?: boolean;
		/** Codes the YOLO profile waived ([] unless `yolo`; always sent). */
		waived?: string[];
	};
	counts: PublicCounts;
}

/** DTO of `GET /api/v1/lineages/[id]`. */
export interface LineageVersions {
	lineage: LineageDto;
	author: AuthorCredit | null;
	versions: VersionDto[];
	nextCursor: string | null;
}

export type ReadResult<T> = { kind: 'ok'; value: T } | { kind: 'gone' } | { kind: 'not-found' };

type EnvelopeResult = ReturnType<typeof validateEnvelope>;
type Envelope = Extract<EnvelopeResult, { ok: true }>['value'];

/** Class of a curve that may be stored, as the YOLO rules need it. */
interface StoredClass {
	yolo: boolean;
	/** Codes the YOLO profile waived ([] for a standard curve). */
	waived: string[];
}

interface Prepared extends StoredClass {
	curve: CurveInput;
	version: VersionInput;
	/**
	 * The write opens a YOLO head to others (yoloRules passed): it takes an acknowledgement slot
	 * and its batch writes the acknowledgement (writeWithAckSlot).
	 */
	ack: boolean;
}

/** What the publication path checks besides the curve itself (see prepare). */
interface PrepareRules {
	/** Visibility the lineage will have after the write (YOLO rules). */
	visibility: LineageVisibility;
	acknowledge: Acknowledgement;
	/** License the envelope must keep (a CC-BY 4.0 fork source), checked before the gate. */
	license?: License;
}

// ---- Helpers --------------------------------------------------------------------------------

/** 128-bit random id, base64url (22 characters, accepted by isSocialId). */
function newId(): string {
	let binary = '';
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Start (epoch ms) of the UTC day that contains `now`. */
export function utcDayStart(now: number): number {
	return Math.floor(now / DAY_MS) * DAY_MS;
}

function invalidCurve(codes: readonly string[]): ApiError {
	return new ApiError(422, 'INVALID_CURVE', { codes: [...new Set(codes)] });
}

/**
 * 422 GATE_REJECTED: `details.reasons` (cached codes, unchanged) and `details.hard`, the codes that
 * block in every profile (no YOLO waiver lifts them).
 */
function gateRejected(reasons: readonly string[], hard: readonly string[] = hardCodes(reasons)) {
	return new ApiError(422, 'GATE_REJECTED', { reasons: [...reasons], hard: [...hard] });
}

/** Repository error code → API error. */
export function repoError(code: SocialErrorCode): ApiError {
	switch (code) {
		case 'head-moved':
			return new ApiError(409, 'HEAD_MOVED');
		case 'gate-rejected':
			return gateRejected([], []);
		case 'not-found':
			return new ApiError(404, 'NOT_FOUND');
		case 'retracted':
			return new ApiError(409, 'CONFLICT');
		case 'duplicate':
			return new ApiError(409, 'DUPLICATE');
		case 'already-active':
			return new ApiError(409, 'ALREADY_ACTIVE');
		case 'invalid-cursor':
			return new ApiError(400, 'INVALID_CURSOR');
		case 'invalid-input':
		case 'limit':
			return new ApiError(400, 'INVALID_BODY');
	}
}

function clockOf(deps: CurveDeps): number {
	return deps.now ?? Date.now();
}

function gateOptions(deps: CurveDeps): { gate?: typeof gateForWrite } {
	return deps.gate ? { gate: deps.gate } : {};
}

/** The kill switch as the reads take it (absent = 'off'). */
function yoloOf(deps: CurveDeps): YoloPublication {
	return deps.yoloPublication ?? 'off';
}

/** The sliding-day rule of the YOLO acknowledgements (group `curves.yolo.ack`). */
function yoloAckRule(userId: string): Omit<WindowRule, 'peek'> {
	return {
		key: rateLimitKey.user(YOLO_ACK_GROUP, userId),
		limit: YOLO_ACKS_DAILY_MAX,
		windowSeconds: DAY_MS / 1000
	};
}

function yoloAckQuotaExceeded(retryAfter: number): ApiError {
	return new ApiError(
		429,
		'QUOTA_EXCEEDED',
		{ limit: YOLO_ACKS_DAILY_MAX, group: YOLO_ACK_GROUP },
		{ headers: { 'retry-after': String(retryAfter) } }
	);
}

/**
 * Checks, WITHOUT counting, that one more YOLO acknowledgement fits (429 QUOTA_EXCEEDED once the
 * user holds YOLO_ACKS_DAILY_MAX of them over the sliding day; 503 when D1 is unavailable). Only
 * an early answer, before a gate attempt is counted (prepare): the cap itself is enforced by the
 * atomic take of writeWithAckSlot.
 */
async function peekYoloAckSlot(db: D1Database, userId: string, now: number): Promise<void> {
	const rule: WindowRule = { ...yoloAckRule(userId), peek: true };
	const outcome = await slidingWindowLimit(db, [rule], new Date(now));
	if (outcome.ok) return;
	if (outcome.reason === 'unavailable') throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE');
	throw yoloAckQuotaExceeded(outcome.retryAfter);
}

/** Gives an acknowledgement slot back. Never throws: a D1 outage is logged (no ids). */
async function giveBackYoloAckSlot(db: D1Database, slot: WindowSlot): Promise<void> {
	if (!(await releaseWindowSlot(db, slot))) {
		console.error(JSON.stringify({ event: 'curves.yolo_ack_release', error: 'unavailable' }));
	}
}

/**
 * Runs `write`, holding one YOLO acknowledgement slot when `ack` is set (the write opens a YOLO
 * head to others and its batch writes the acknowledgement). The slot is taken BEFORE the write and
 * atomically (takeWindowSlot: the increment and the check in one D1 batch), so N concurrent
 * openings never hold more than YOLO_ACKS_DAILY_MAX per sliding day: past it, 429 QUOTA_EXCEEDED
 * and nothing is written (503 when D1 is unavailable). A write that fails, with a repository error
 * (HEAD_MOVED included) or a throw, gives its slot back: a failed write consumes nothing.
 */
async function writeWithAckSlot<T>(
	db: D1Database,
	userId: string,
	now: number,
	ack: boolean,
	write: () => Promise<RepoResult<T>>
): Promise<RepoResult<T>> {
	if (!ack) return write();
	const taken = await takeWindowSlot(db, yoloAckRule(userId), new Date(now));
	if (!taken.ok) {
		if (taken.reason === 'unavailable') throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE');
		throw yoloAckQuotaExceeded(taken.retryAfter);
	}
	let result: RepoResult<T>;
	try {
		result = await write();
	} catch (error) {
		await giveBackYoloAckSlot(db, taken.slot);
		throw error;
	}
	if (!result.ok) await giveBackYoloAckSlot(db, taken.slot);
	return result;
}

/**
 * The YOLO rules of a write whose resulting head (`head`) will have `visibility`, the daily quota
 * aside: false for a standard head or a private lineage (nothing to acknowledge). A YOLO head shown
 * to others needs the kill switch on (403 YOLO_PUBLICATION_OFF), an account at least
 * YOLO_MIN_ACCOUNT_AGE_MS old (403 FORBIDDEN, `reason: 'account-age'`) and `acknowledge: 'yolo'`
 * (409 YOLO_ACK_REQUIRED with `details.waived`); then true: the write takes a YOLO_ACKS_DAILY_MAX
 * slot and writes the acknowledgement in its batch (writeWithAckSlot).
 */
async function yoloRules(
	db: D1Database,
	userId: string,
	head: StoredClass,
	visibility: LineageVisibility,
	acknowledge: Acknowledgement,
	now: number,
	deps: CurveDeps
): Promise<boolean> {
	if (!head.yolo || visibility === 'private') return false;
	if (yoloOf(deps) !== 'on') throw new ApiError(403, 'YOLO_PUBLICATION_OFF');
	if (!(await accountCreatedBy(db, userId, now - YOLO_MIN_ACCOUNT_AGE_MS))) {
		throw new ApiError(403, 'FORBIDDEN', {
			reason: 'account-age',
			minAgeHours: YOLO_MIN_ACCOUNT_AGE_MS / 3_600_000
		});
	}
	if (acknowledge !== 'yolo') {
		throw new ApiError(409, 'YOLO_ACK_REQUIRED', { waived: [...head.waived] });
	}
	return true;
}

/** 429 QUOTA_EXCEEDED once the user created DAILY_PUBLICATION_QUOTA versions this UTC day. */
async function assertQuota(db: D1Database, userId: string, now: number): Promise<void> {
	const dayStart = utcDayStart(now);
	const used = await countVersionsSince(db, userId, dayStart);
	if (used >= DAILY_PUBLICATION_QUOTA) {
		const retryAfter = Math.max(1, Math.ceil((dayStart + DAY_MS - now) / 1000));
		throw new ApiError(
			429,
			'QUOTA_EXCEEDED',
			{ limit: DAILY_PUBLICATION_QUOTA },
			{ headers: { 'retry-after': String(retryAfter) } }
		);
	}
}

/**
 * Counts one attempt that reaches the gate; 429 QUOTA_EXCEEDED once the user made
 * DAILY_GATE_ATTEMPT_QUOTA of them over the sliding day. Fails closed (503) when D1 is unavailable.
 */
async function countGateAttempt(db: D1Database, userId: string, now: number): Promise<void> {
	const outcome = await slidingWindowLimit(
		db,
		[
			{
				key: rateLimitKey.user(GATE_ATTEMPT_GROUP, userId),
				limit: DAILY_GATE_ATTEMPT_QUOTA,
				windowSeconds: DAY_MS / 1000
			}
		],
		new Date(now)
	);
	if (outcome.ok) return;
	if (outcome.reason === 'unavailable') throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE');
	throw new ApiError(
		429,
		'QUOTA_EXCEEDED',
		{ limit: DAILY_GATE_ATTEMPT_QUOTA },
		{ headers: { 'retry-after': String(outcome.retryAfter) } }
	);
}

/** Text with visible content before normalization (whitespace-only input is not content). */
function hasContent(value: unknown): boolean {
	return typeof value === 'string' && value.trim() !== '';
}

function curveInputOf(curve: CurveRecord): CurveInput {
	return {
		id: curve.id,
		s1: curve.s1,
		canonKey: curve.canonKey,
		gateVer: curve.gateVer,
		gateOk: curve.gateOk,
		gateYolo: curve.gateYolo,
		gateReasons: curve.gateReasons,
		levelDb: curve.levelDb
	};
}

function versionInputOf(envelope: Envelope): VersionInput {
	return {
		id: newId(),
		name: envelope.name,
		description: envelope.description,
		license: envelope.license,
		recipe: envelope.recipe ? JSON.stringify(envelope.recipe) : null,
		lang: envelope.lang,
		// preset@2 labels, already normalized by validateEnvelope (absent: an all-null list or @1).
		// Version data only: the curve row, its id and the gate never see them, so a labels-only
		// append reuses the cached curve and its gate result.
		labels: envelope.labels ?? null
	};
}

/**
 * The class of `s1` when it is cached under a current gate version (no gate run): standard or
 * YOLO; null when it is not cached, stale or rejected (the gate decides then).
 */
async function cachedClass(db: D1Database, s1: string): Promise<StoredClass | null> {
	const cached = await getCurve(db, await curveId(s1));
	if (!cached || cached.s1 !== s1 || !(await isGateCurrent(cached.gateVer))) return null;
	if (cached.gateOk) return { yolo: false, waived: [] };
	if (cached.gateYolo) return { yolo: true, waived: [...cached.gateReasons] };
	return null;
}

/**
 * The publication path shared by publish, new version and fork: core validation (422
 * INVALID_CURVE with `details.codes`), text that normalizes to nothing refused, the license a
 * CC-BY 4.0 fork must keep (422 INVALID_CURVE `env:enum`), then the gate attempt quota and the
 * server classification through checkPublishable (422 GATE_REJECTED with `details.reasons` and
 * `details.hard` for a curve that passes neither profile; nothing is published), then the YOLO
 * rules for `rules.visibility` (yoloRules). When the class is already cached under the current
 * gate version, the YOLO rules (403, 409 YOLO_ACK_REQUIRED, and the daily quota read without
 * counting: 429) answer first, so a refused opening spends no gate attempt (the usual retry after
 * a 409 is then cached). No acknowledgement slot is taken here: the caller's write takes it
 * atomically (writeWithAckSlot) and gives it back if it fails.
 */
async function prepare(
	db: D1Database,
	userId: string,
	raw: Record<string, unknown>,
	now: number,
	deps: CurveDeps,
	path: PublicationPath,
	rules: PrepareRules
): Promise<Prepared> {
	const checked = validateEnvelope(raw);
	if (!checked.ok) throw invalidCurve(checked.errors.map((issue) => issue.code));
	const envelope = checked.value;
	if ([...envelope.name].length === 0) throw invalidCurve(['env:length']);
	if (hasContent(raw.description) && envelope.description === '') {
		throw invalidCurve(['env:length']);
	}
	if (rules.license !== undefined && envelope.license !== rules.license) {
		throw invalidCurve(['env:enum']);
	}
	const open = (head: StoredClass) =>
		yoloRules(db, userId, head, rules.visibility, rules.acknowledge, now, deps);
	const known = await cachedClass(db, envelope.code);
	const early = known === null ? null : await open(known);
	// Early answer only: the write takes the slot atomically.
	if (early === true) await peekYoloAckSlot(db, userId, now);
	await countGateAttempt(db, userId, now);
	const verdict = await checkPublishable(db, envelope.code, now, gateOptions(deps));
	if (!verdict.ok) {
		if (verdict.code === 'invalid-curve') throw invalidCurve(verdict.codes);
		recordGateRejection(deps.metrics, verdict.reasons, path);
		throw gateRejected(verdict.reasons, verdict.hard);
	}
	const stored: StoredClass = { yolo: verdict.class === 'yolo', waived: verdict.waived };
	// The cached class normally is the verdict's; a re-gate in between re-applies the rules.
	const ack = early !== null && known?.yolo === stored.yolo ? early : await open(stored);
	return {
		curve: curveInputOf(verdict.curve),
		version: versionInputOf(envelope),
		...stored,
		ack
	};
}

/**
 * Re-classifies the head curve (refreshes a stale cache) and returns its class; 422 GATE_REJECTED
 * when it now passes neither profile.
 */
async function headClassOf(
	db: D1Database,
	lineage: LineageSummary,
	now: number,
	deps: CurveDeps
): Promise<StoredClass & { curveId: string }> {
	const verdict = await checkPublishable(db, lineage.curve.s1, now, gateOptions(deps));
	if (verdict.ok) {
		return { yolo: verdict.class === 'yolo', waived: verdict.waived, curveId: verdict.curve.id };
	}
	if (verdict.code === 'gate-rejected') throw gateRejected(verdict.reasons, verdict.hard);
	throw gateRejected(verdict.codes);
}

function announce(info: PublishedInfo, deps: CurveDeps): PublishedInfo {
	if (deps.onPublished) {
		try {
			deps.onPublished(info);
		} catch (error) {
			// The publication is already committed; a failing hook must not turn it into an error.
			const name = error instanceof Error ? error.name : typeof error;
			console.error(JSON.stringify({ event: 'curves.on_published', error: name }));
		}
	}
	return info;
}

/**
 * The lineage as `viewer` may read it, with a current gate verdict on its head: a head cached
 * under a stale gate version is re-gated and the lineage read again, so a head that now fails is
 * not linkable (null for anyone but the owner or an admin). A head the readable rows hide because
 * it is cached as REJECTED under a stale gate version is re-gated too (#27, regateRejectedHead:
 * linkable lineages only), so it is served once the current gate accepts it; one gate run at
 * most either way. Under the kill switch (`deps.yoloPublication`, absent = 'off'): while off,
 * someone else's YOLO head is null, acknowledged or not. Invalid ids give null.
 */
async function readLineage(
	db: D1Database,
	lineageId: string,
	viewer: Viewer,
	now: number,
	deps: CurveDeps
): Promise<LineageSummary | null> {
	if (!isSocialId(lineageId)) return null;
	const yolo = yoloOf(deps);
	const summary = await getLineageForViewer(db, lineageId, viewer, yolo);
	if (!summary) {
		if (!(await regateRejectedHead(db, lineageId, now, gateOptions(deps)))) return null;
		return getLineageForViewer(db, lineageId, viewer, yolo);
	}
	if (await isGateCurrent(summary.curve.gateVer)) return summary;
	await regateCurve(db, summary.curve, now, gateOptions(deps));
	return getLineageForViewer(db, lineageId, viewer, yolo);
}

/**
 * Same lazy re-gate as readLineage, for one version (its own curve) of a readable lineage: a
 * version hidden because its own curve is cached as rejected under a stale gate version is
 * re-gated first (#27; the head was already handled by readLineage). One gate run at most.
 */
async function readVersion(
	db: D1Database,
	versionId: string,
	viewer: Viewer,
	now: number,
	deps: CurveDeps
): Promise<VersionView | null> {
	if (!isSocialId(versionId)) return null;
	const yolo = yoloOf(deps);
	const view = await getVersionForViewer(db, versionId, viewer, yolo);
	if (!view) {
		const options = gateOptions(deps);
		if (!(await regateRejectedVersion(db, versionId, now, options, { head: false }))) return null;
		return getVersionForViewer(db, versionId, viewer, yolo);
	}
	if (await isGateCurrent(view.curve.gateVer)) return view;
	await regateCurve(db, view.curve, now, gateOptions(deps));
	return getVersionForViewer(db, versionId, viewer, yolo);
}

/** The caller's own lineage (any state), or 404 (also for other people's lineages). */
async function ownedLineage(
	db: D1Database,
	lineageId: string,
	userId: string,
	now: number,
	deps: CurveDeps
): Promise<LineageSummary> {
	const summary = await readLineage(db, lineageId, { userId }, now, deps);
	if (!summary || summary.ownerUserId !== userId) throw new ApiError(404, 'NOT_FOUND');
	return summary;
}

function parseRecipe(text: string | null): unknown {
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * S5 envelope of a stored version (fork without an explicit envelope), in the lowest format that
 * carries it (core `envelopeFormat`): `open-auri/preset@2` with the version's labels when it has
 * any (a fork copies them) or when the curve is S1 v2 (a band above 20 kHz), `@1` otherwise.
 */
function envelopeOf(
	version: VersionRecord,
	curve: CurveRecord,
	now: number
): Record<string, unknown> {
	let decoded: ReturnType<typeof decodeS1>;
	try {
		decoded = decodeS1(curve.s1);
	} catch (error) {
		if (error instanceof S1Error) throw invalidCurve([String(error.code)]);
		throw error;
	}
	const labels = version.labels?.some((label) => label !== null) ? version.labels : null;
	const envelope: Record<string, unknown> = {
		format: envelopeFormat({ bands: decoded.bands, labels }),
		name: version.name,
		description: version.description,
		source: 'custom',
		license: version.license,
		code: curve.s1,
		preampDb: decoded.preampDb,
		bands: decoded.bands,
		...(labels ? { labels: [...labels] } : {}),
		lang: version.lang,
		createdAt: new Date(now).toISOString()
	};
	const recipe = parseRecipe(version.recipe);
	if (recipe !== null) envelope.recipe = recipe;
	return envelope;
}

function lineageDto(summary: LineageSummary, viewer: Viewer): LineageDto {
	return {
		id: summary.id,
		visibility: summary.visibility,
		status: summary.status,
		moderation: summary.moderation,
		curated: summary.curated,
		forkedFromVersion: summary.forkedFromVersion,
		headVersion: summary.headVersion,
		createdAt: summary.createdAt,
		updatedAt: summary.updatedAt,
		isOwner:
			typeof viewer.userId === 'string' &&
			viewer.userId !== '' &&
			summary.ownerUserId === viewer.userId
	};
}

function versionDto(version: VersionRecord, headVersion: string | null): VersionDto {
	return {
		id: version.id,
		parentId: version.parentId,
		curveId: version.curveId,
		name: version.name,
		description: version.description,
		license: version.license,
		lang: version.lang,
		labels: version.labels,
		createdAt: version.createdAt,
		isHead: version.id === headVersion
	};
}

async function missing(
	db: D1Database,
	lineageId: string,
	deps: CurveDeps
): Promise<{ kind: 'gone' } | { kind: 'not-found' }> {
	return (await isLinkableTombstone(db, lineageId, yoloOf(deps)))
		? { kind: 'gone' }
		: { kind: 'not-found' };
}

// ---- Writes ---------------------------------------------------------------------------------

/** `POST /api/v1/curves`: a new lineage with its root version. */
export async function publishCurve(
	db: D1Database,
	userId: string,
	body: PublishBody,
	deps: CurveDeps = {}
): Promise<PublishedInfo> {
	const now = clockOf(deps);
	await assertQuota(db, userId, now);
	const prepared = await prepare(db, userId, body.envelope, now, deps, 'publish', {
		visibility: body.visibility,
		acknowledge: body.acknowledge
	});
	const result = await writeWithAckSlot(db, userId, now, prepared.ack, () =>
		publishLineage(db, {
			lineageId: newId(),
			ownerUserId: userId,
			visibility: body.visibility,
			curve: prepared.curve,
			version: prepared.version,
			yoloAck: prepared.ack,
			now
		})
	);
	if (!result.ok) throw repoError(result.code);
	return announce({ ...result.value, curveId: prepared.curve.id, yolo: prepared.yolo }, deps);
}

/** The test hook between the reads a write relied on and the write (CurveDeps.beforeWrite). */
async function beforeWrite(deps: CurveDeps, attempt: number): Promise<void> {
	if (deps.beforeWrite) await deps.beforeWrite(attempt);
}

/**
 * The lineage read again after a write whose state moved: still the caller's, still active and
 * with the same head `parentVersionId` (else 409 CONFLICT / HEAD_MOVED, as on the first read).
 */
async function appendTarget(
	db: D1Database,
	userId: string,
	lineageId: string,
	parentVersionId: string,
	now: number,
	deps: CurveDeps
): Promise<LineageSummary> {
	const lineage = await ownedLineage(db, lineageId, userId, now, deps);
	if (lineage.status !== 'active') throw new ApiError(409, 'CONFLICT');
	if (parentVersionId !== lineage.headVersion) throw new ApiError(409, 'HEAD_MOVED');
	return lineage;
}

/**
 * `POST /api/v1/lineages/[id]/versions`: appends a version whose parent must be the current head
 * (409 HEAD_MOVED otherwise; of two concurrent appends with the same parent exactly one wins). A
 * YOLO curve's acknowledgement depends on the lineage's visibility: its batch applies only while
 * the lineage keeps the visibility read, and when a concurrent visibility change moved it, the
 * lineage is read again and the YOLO rules re-applied to the visibility it has now (STATE_ATTEMPTS;
 * the curve is already classified, so no gate run nor gate attempt is spent again).
 */
export async function appendCurveVersion(
	db: D1Database,
	userId: string,
	lineageId: string,
	body: AppendBody,
	deps: CurveDeps = {}
): Promise<PublishedInfo> {
	const now = clockOf(deps);
	const first = await appendTarget(db, userId, lineageId, body.parentVersionId, now, deps);
	await assertQuota(db, userId, now);
	const prepared = await prepare(db, userId, body.envelope, now, deps, 'version', {
		visibility: first.visibility,
		acknowledge: body.acknowledge
	});
	let lineage = first;
	let ack = prepared.ack;
	for (let attempt = 1; ; attempt++) {
		const target = lineage;
		const opening = ack;
		await beforeWrite(deps, attempt);
		const result = await writeWithAckSlot(db, userId, now, opening, () =>
			appendVersion(db, {
				lineageId: target.id,
				ownerUserId: userId,
				expectedHead: body.parentVersionId,
				// The YOLO rules above relied on this visibility: the batch writes nothing if it moved.
				...(prepared.yolo ? { expectedVisibility: target.visibility } : {}),
				curve: prepared.curve,
				version: prepared.version,
				yoloAck: opening,
				now
			})
		);
		if (result.ok) {
			return announce(
				{
					lineageId: target.id,
					versionId: result.value.versionId,
					curveId: prepared.curve.id,
					yolo: prepared.yolo
				},
				deps
			);
		}
		// HEAD_MOVED (or any other failure) gave its acknowledgement slot back.
		if (result.code !== 'head-moved' || !prepared.yolo || attempt >= STATE_ATTEMPTS) {
			throw repoError(result.code);
		}
		// Same parent but the batch refused: the head moved (409 here) or the visibility did.
		lineage = await appendTarget(db, userId, lineageId, body.parentVersionId, now, deps);
		ack = await yoloRules(db, userId, prepared, lineage.visibility, body.acknowledge, now, deps);
	}
}

/**
 * `POST /api/v1/lineages/[id]/fork`: a new lineage (private unless the body says otherwise) from a
 * version the caller can read. The source must be active, not moderated and its head must still
 * pass the gate; a CC-BY 4.0 source keeps CC-BY 4.0 and its attribution.
 */
export async function forkCurve(
	db: D1Database,
	userId: string,
	sourceLineageId: string,
	body: ForkBody,
	deps: CurveDeps = {}
): Promise<ForkResult> {
	const now = clockOf(deps);
	const viewer: Viewer = { userId };
	const source = await readLineage(db, sourceLineageId, viewer, now, deps);
	if (!source) {
		if ((await missing(db, sourceLineageId, deps)).kind === 'gone') {
			throw new ApiError(410, 'GONE');
		}
		throw new ApiError(404, 'NOT_FOUND');
	}
	if (source.status !== 'active') throw new ApiError(410, 'GONE');
	if (source.moderation !== 'visible') throw new ApiError(404, 'NOT_FOUND');
	await headClassOf(db, source, now, deps);
	const versionId = body.versionId ?? source.headVersion;
	const view = versionId !== null ? await readVersion(db, versionId, viewer, now, deps) : null;
	if (!view || view.version.lineageId !== source.id) throw new ApiError(404, 'NOT_FOUND');
	await assertQuota(db, userId, now);
	const raw = body.envelope ?? envelopeOf(view.version, view.curve, now);
	const byLicense = view.version.license === 'CC-BY-4.0';
	const visibility = body.visibility ?? 'private';
	const prepared = await prepare(db, userId, raw, now, deps, 'fork', {
		visibility,
		acknowledge: body.acknowledge,
		...(byLicense ? { license: 'CC-BY-4.0' as const } : {})
	});
	const result = await writeWithAckSlot(db, userId, now, prepared.ack, () =>
		forkLineage(
			db,
			view.version.id,
			{
				lineageId: newId(),
				ownerUserId: userId,
				visibility,
				curve: prepared.curve,
				version: prepared.version,
				yoloAck: prepared.ack,
				now
			},
			yoloOf(deps)
		)
	);
	if (!result.ok) throw repoError(result.code);
	const info = announce({ ...result.value, curveId: prepared.curve.id, yolo: prepared.yolo }, deps);
	return {
		...info,
		forkedFrom: { lineageId: source.id, versionId: view.version.id },
		attribution: byLicense
			? {
					license: 'CC-BY-4.0',
					lineageId: source.id,
					versionId: view.version.id,
					name: view.version.name,
					author: source.author
				}
			: null
	};
}

/** `POST /api/v1/lineages/[id]/retract`: owner tombstone (idempotent). */
export async function retractCurve(
	db: D1Database,
	userId: string,
	lineageId: string,
	deps: CurveDeps = {}
): Promise<LineageState> {
	const now = clockOf(deps);
	const lineage = await ownedLineage(db, lineageId, userId, now, deps);
	const result = await retractLineage(db, lineage.id, userId, now);
	if (!result.ok) throw repoError(result.code);
	return {
		lineageId: lineage.id,
		status: 'retracted',
		visibility: lineage.visibility,
		moderation: lineage.moderation
	};
}

/**
 * `POST /api/v1/lineages/[id]/restore`: undoes the owner's tombstone. Never touches moderation (a
 * hidden lineage stays hidden); a non-private lineage whose head now passes neither profile is
 * refused. One whose head is YOLO follows the YOLO rules (`acknowledge`) while the kill switch is
 * on; while it is off (YOLO_PUBLICATION, `deps.yoloPublication` absent = 'off') it is restored as
 * PRIVATE in the same statement (nothing to acknowledge), instead of a 403 the owner could not get
 * past (a retracted lineage's visibility cannot be changed first). The answer carries the
 * effective `visibility`. A lineage is restored only while it keeps the head and the visibility
 * the decision read; otherwise it is read again (STATE_ATTEMPTS, then 409 HEAD_MOVED).
 */
export async function restoreCurve(
	db: D1Database,
	userId: string,
	lineageId: string,
	deps: CurveDeps = {},
	acknowledge?: Acknowledgement
): Promise<LineageState> {
	const now = clockOf(deps);
	for (let attempt = 1; ; attempt++) {
		const lineage = await ownedLineage(db, lineageId, userId, now, deps);
		const plan = await restorePlan(db, userId, lineage, acknowledge, now, deps);
		await beforeWrite(deps, attempt);
		const result = await writeWithAckSlot(db, userId, now, plan.ackCurveId !== null, () =>
			restoreLineage(db, lineage.id, userId, now, {
				...(plan.ackCurveId === null ? {} : { yoloAckCurveId: plan.ackCurveId }),
				...(plan.visibility === lineage.visibility ? {} : { visibility: plan.visibility }),
				// The plan relied on both (a private lineage opened meanwhile is planned again).
				expectedHead: lineage.headVersion,
				expectedVisibility: lineage.visibility
			})
		);
		if (result.ok) {
			return {
				lineageId: lineage.id,
				status: 'active',
				visibility: plan.visibility,
				moderation: lineage.moderation
			};
		}
		if (result.code !== 'head-moved' || attempt >= STATE_ATTEMPTS) throw repoError(result.code);
	}
}

/**
 * What a restore writes for `lineage` as read: the visibility it keeps (private for a non-private
 * YOLO head while the kill switch is off) and the head curve to acknowledge (null: none).
 */
async function restorePlan(
	db: D1Database,
	userId: string,
	lineage: LineageSummary,
	acknowledge: Acknowledgement,
	now: number,
	deps: CurveDeps
): Promise<{ visibility: LineageVisibility; ackCurveId: string | null }> {
	if (lineage.visibility === 'private') return { visibility: 'private', ackCurveId: null };
	const head = await headClassOf(db, lineage, now, deps);
	if (head.yolo && yoloOf(deps) !== 'on') return { visibility: 'private', ackCurveId: null };
	const opening = await yoloRules(db, userId, head, lineage.visibility, acknowledge, now, deps);
	return { visibility: lineage.visibility, ackCurveId: opening ? head.curveId : null };
}

/**
 * The head curve an opening visibility change acknowledges (null: nothing to acknowledge, a
 * standard head or `private`): the head re-classified, then the YOLO rules.
 */
async function openingAck(
	db: D1Database,
	userId: string,
	lineage: LineageSummary,
	visibility: LineageVisibility,
	acknowledge: Acknowledgement,
	now: number,
	deps: CurveDeps
): Promise<string | null> {
	if (visibility === 'private') return null;
	const head = await headClassOf(db, lineage, now, deps);
	return (await yoloRules(db, userId, head, visibility, acknowledge, now, deps))
		? head.curveId
		: null;
}

/**
 * `PUT /api/v1/lineages/[id]/visibility`: owner only. Opening a lineage (unlisted or public)
 * re-classifies its head first (a YOLO head follows the YOLO rules: `acknowledge`); moderation and
 * status are unchanged. An opening applies only while the head it classified is still the head: an
 * append in between (a YOLO version, say) makes it read the lineage again and re-apply the rules
 * to the new head (STATE_ATTEMPTS, then 409 HEAD_MOVED).
 */
export async function changeVisibility(
	db: D1Database,
	userId: string,
	lineageId: string,
	visibility: LineageVisibility,
	deps: CurveDeps = {},
	acknowledge?: Acknowledgement
): Promise<LineageState> {
	const now = clockOf(deps);
	for (let attempt = 1; ; attempt++) {
		const lineage = await ownedLineage(db, lineageId, userId, now, deps);
		const ackCurveId = await openingAck(db, userId, lineage, visibility, acknowledge, now, deps);
		await beforeWrite(deps, attempt);
		const result = await writeWithAckSlot(db, userId, now, ackCurveId !== null, () =>
			setLineageVisibility(db, lineage.id, userId, visibility, now, {
				...(ackCurveId === null ? {} : { yoloAckCurveId: ackCurveId }),
				...(visibility === 'private' ? {} : { expectedHead: lineage.headVersion })
			})
		);
		if (result.ok) {
			return {
				lineageId: lineage.id,
				status: lineage.status,
				visibility,
				moderation: lineage.moderation
			};
		}
		if (result.code !== 'head-moved' || attempt >= STATE_ATTEMPTS) throw repoError(result.code);
	}
}

// ---- Reads ----------------------------------------------------------------------------------

/**
 * The lineage `lineageId` with its head version (or `versionId` of the same lineage) as `viewer`
 * may read it. 'gone' = a tombstone that was openable by id (410 for non-owners); 'not-found'
 * covers missing, private, moderated and unreadable alike. A head (or requested version) cached
 * under a stale gate version is re-gated first (a head that now fails is not linkable).
 */
export async function loadPublishedCurve(
	db: D1Database,
	lineageId: string,
	viewer: Viewer,
	versionId?: string | null,
	deps: CurveDeps = {}
): Promise<ReadResult<PublishedCurve>> {
	if (!isSocialId(lineageId)) return { kind: 'not-found' };
	const now = clockOf(deps);
	const summary = await readLineage(db, lineageId, viewer, now, deps);
	if (!summary) return missing(db, lineageId, deps);
	let version = summary.head;
	let curve = summary.curve;
	if (versionId !== undefined && versionId !== null && versionId !== summary.headVersion) {
		const view = await readVersion(db, versionId, viewer, now, deps);
		if (!view || view.version.lineageId !== summary.id) return { kind: 'not-found' };
		version = view.version;
		curve = view.curve;
	}
	const counts = (await countsForLineages(db, [summary.id], viewer, yoloOf(deps))).get(
		summary.id
	) ?? {
		favorites: 0,
		previewed: 0,
		installed: 0
	};
	return {
		kind: 'ok',
		value: {
			lineage: lineageDto(summary, viewer),
			author: summary.author,
			version: {
				...versionDto(version, summary.headVersion),
				recipe: parseRecipe(version.recipe)
			},
			curve: {
				id: curve.id,
				s1: curve.s1,
				levelDb: curve.levelDb,
				gate: { ok: curve.gateOk, reasons: [...curve.gateReasons], version: curve.gateVer },
				yolo: curve.gateYolo,
				waived: curve.gateYolo ? [...curve.gateReasons] : []
			},
			counts
		}
	};
}

/** Version history (newest first, keyset-paginated) of a lineage `viewer` may read. */
export async function loadLineageVersions(
	db: D1Database,
	lineageId: string,
	viewer: Viewer,
	page: PageRequest = {},
	deps: CurveDeps = {}
): Promise<ReadResult<LineageVersions>> {
	if (!isSocialId(lineageId)) return { kind: 'not-found' };
	const summary = await readLineage(db, lineageId, viewer, clockOf(deps), deps);
	if (!summary) return missing(db, lineageId, deps);
	let versions: Awaited<ReturnType<typeof listVersions>>;
	try {
		versions = await listVersions(db, summary.id, viewer, page, yoloOf(deps));
	} catch (error) {
		if (error instanceof SocialRepoError) throw repoError(error.code);
		throw error;
	}
	if (!versions) return { kind: 'not-found' };
	return {
		kind: 'ok',
		value: {
			lineage: lineageDto(summary, viewer),
			author: summary.author,
			versions: versions.items.map((item) => versionDto(item, summary.headVersion)),
			nextCursor: versions.nextCursor
		}
	};
}

/**
 * Response of the curve and lineage reads: 410 GONE / 404 NOT_FOUND, else 200. Anonymous reads
 * (only public or unlisted lineages are readable anonymously) get an ETag and CACHE_PUBLIC_60;
 * signed-in reads stay `private, no-store` (owner-only fields and states).
 */
export async function readResponse<T extends { lineage: { visibility: LineageVisibility } }>(
	request: Request,
	result: ReadResult<T>,
	anonymous: boolean
): Promise<Response> {
	if (result.kind === 'gone') throw new ApiError(410, 'GONE');
	if (result.kind === 'not-found') throw new ApiError(404, 'NOT_FOUND');
	if (anonymous && result.value.lineage.visibility !== 'private') {
		return cached(request, JSON.stringify(result.value), { cacheControl: CACHE_PUBLIC_60 });
	}
	return json(result.value);
}
