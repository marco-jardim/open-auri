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
import type { D1Database } from '@cloudflare/workers-types';
import type { gateForWrite } from 'open-auri/safety';
import { decodeS1, S1Error, validateEnvelope } from 'open-auri/share';
import { z } from 'zod';
import { ApiError, CACHE_PUBLIC_60, cached, json } from '#lib/server/api/index.ts';
import { rateLimitKey, slidingWindowLimit } from '#lib/server/security/ratelimit.ts';
import {
	recordGateRejection,
	type MetricsDataset,
	type PublicationPath
} from '#lib/server/observability/metrics.ts';
import {
	checkCurve,
	isGateCurrent,
	regateCurve,
	regateRejectedHead,
	regateRejectedVersion
} from '#lib/server/social/gate.ts';
import { isLinkableTombstone } from '#lib/server/social/queries/curves.ts';
import {
	appendVersion,
	countsForLineages,
	countVersionsSince,
	forkLineage,
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
	type SocialErrorCode,
	type VersionInput,
	type VersionRecord,
	type Viewer
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

/** Request body cap of the curve writes (the normalized envelope itself is at most 8 KiB). */
export const CURVE_BODY_MAX_BYTES = 32 * 1024;

/** Shape only: the envelope's content is validated by the core (`validateEnvelope`). */
const EnvelopeShape = z.record(z.string(), z.unknown());
const Visibility = z.enum(LINEAGE_VISIBILITIES);
const IdShape = z.string().min(1).max(64);

export const PublishBodySchema = z.object({ envelope: EnvelopeShape, visibility: Visibility });
export const AppendBodySchema = z.object({ parentVersionId: IdShape, envelope: EnvelopeShape });
/** Fork: `versionId` defaults to the head, `visibility` to private, `envelope` to a copy. */
export const ForkBodySchema = z.object({
	versionId: IdShape.optional(),
	visibility: Visibility.optional(),
	envelope: EnvelopeShape.optional()
});
export const VisibilityBodySchema = z.object({ visibility: Visibility });

export type PublishBody = z.infer<typeof PublishBodySchema>;
export type AppendBody = z.infer<typeof AppendBodySchema>;
export type ForkBody = z.infer<typeof ForkBodySchema>;

// ---- Types ----------------------------------------------------------------------------------

export interface PublishedInfo {
	lineageId: string;
	versionId: string;
	curveId: string;
}

export interface CurveDeps {
	/** Called after every successful publish, version or fork (OG warm-up hook, T4.7). */
	onPublished?: (info: PublishedInfo) => void;
	/** Gate injection for tests (default: the core's gateForWrite through checkCurve). */
	gate?: typeof gateForWrite;
	now?: number;
	/** Analytics Engine dataset (T5.2): gate rejections of the publication path, by reason. */
	metrics?: MetricsDataset | null;
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
		gate: { ok: boolean; reasons: string[]; version: string };
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

interface Prepared {
	curve: CurveInput;
	version: VersionInput;
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

function gateRejected(reasons: readonly string[]): ApiError {
	return new ApiError(422, 'GATE_REJECTED', { reasons: [...reasons] });
}

/** Repository error code → API error. */
export function repoError(code: SocialErrorCode): ApiError {
	switch (code) {
		case 'head-moved':
			return new ApiError(409, 'HEAD_MOVED');
		case 'gate-rejected':
			return gateRejected([]);
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
		lang: envelope.lang
	};
}

/**
 * The publication path shared by publish, new version and fork: core validation (422
 * INVALID_CURVE with `details.codes`), text that normalizes to nothing refused, then the gate
 * attempt quota and the gate through checkCurve (422 GATE_REJECTED with `details.reasons`;
 * nothing is published).
 */
async function prepare(
	db: D1Database,
	userId: string,
	raw: Record<string, unknown>,
	now: number,
	deps: CurveDeps,
	path: PublicationPath
): Promise<Prepared> {
	const checked = validateEnvelope(raw);
	if (!checked.ok) throw invalidCurve(checked.errors.map((issue) => issue.code));
	const envelope = checked.value;
	if ([...envelope.name].length === 0) throw invalidCurve(['env:length']);
	if (hasContent(raw.description) && envelope.description === '') {
		throw invalidCurve(['env:length']);
	}
	await countGateAttempt(db, userId, now);
	const verdict = await checkCurve(db, envelope.code, now, gateOptions(deps));
	if (!verdict.ok) {
		if (verdict.code === 'invalid-curve') throw invalidCurve(verdict.codes);
		recordGateRejection(deps.metrics, verdict.reasons, path);
		throw gateRejected(verdict.reasons);
	}
	return { curve: curveInputOf(verdict.curve), version: versionInputOf(envelope) };
}

/** Re-gates the head curve (refreshes a stale cache); 422 GATE_REJECTED when it now fails. */
async function assertHeadPasses(
	db: D1Database,
	lineage: LineageSummary,
	now: number,
	deps: CurveDeps
): Promise<void> {
	const verdict = await checkCurve(db, lineage.curve.s1, now, gateOptions(deps));
	if (verdict.ok) return;
	throw gateRejected(verdict.code === 'gate-rejected' ? verdict.reasons : verdict.codes);
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
 * most either way. Invalid ids give null.
 */
async function readLineage(
	db: D1Database,
	lineageId: string,
	viewer: Viewer,
	now: number,
	deps: CurveDeps
): Promise<LineageSummary | null> {
	if (!isSocialId(lineageId)) return null;
	const summary = await getLineageForViewer(db, lineageId, viewer);
	if (!summary) {
		if (!(await regateRejectedHead(db, lineageId, now, gateOptions(deps)))) return null;
		return getLineageForViewer(db, lineageId, viewer);
	}
	if (await isGateCurrent(summary.curve.gateVer)) return summary;
	await regateCurve(db, summary.curve, now, gateOptions(deps));
	return getLineageForViewer(db, lineageId, viewer);
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
	const view = await getVersionForViewer(db, versionId, viewer);
	if (!view) {
		const options = gateOptions(deps);
		if (!(await regateRejectedVersion(db, versionId, now, options, { head: false }))) return null;
		return getVersionForViewer(db, versionId, viewer);
	}
	if (await isGateCurrent(view.curve.gateVer)) return view;
	await regateCurve(db, view.curve, now, gateOptions(deps));
	return getVersionForViewer(db, versionId, viewer);
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

/** S5 envelope of a stored version (fork without an explicit envelope). */
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
	const envelope: Record<string, unknown> = {
		format: 'open-auri/preset@1',
		name: version.name,
		description: version.description,
		source: 'custom',
		license: version.license,
		code: curve.s1,
		preampDb: decoded.preampDb,
		bands: decoded.bands,
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
		createdAt: version.createdAt,
		isHead: version.id === headVersion
	};
}

async function missing(
	db: D1Database,
	lineageId: string
): Promise<{ kind: 'gone' } | { kind: 'not-found' }> {
	return (await isLinkableTombstone(db, lineageId)) ? { kind: 'gone' } : { kind: 'not-found' };
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
	const prepared = await prepare(db, userId, body.envelope, now, deps, 'publish');
	const result = await publishLineage(db, {
		lineageId: newId(),
		ownerUserId: userId,
		visibility: body.visibility,
		curve: prepared.curve,
		version: prepared.version,
		now
	});
	if (!result.ok) throw repoError(result.code);
	return announce({ ...result.value, curveId: prepared.curve.id }, deps);
}

/**
 * `POST /api/v1/lineages/[id]/versions`: appends a version whose parent must be the current head
 * (409 HEAD_MOVED otherwise; of two concurrent appends with the same parent exactly one wins).
 */
export async function appendCurveVersion(
	db: D1Database,
	userId: string,
	lineageId: string,
	body: AppendBody,
	deps: CurveDeps = {}
): Promise<PublishedInfo> {
	const now = clockOf(deps);
	const lineage = await ownedLineage(db, lineageId, userId, now, deps);
	if (lineage.status !== 'active') throw new ApiError(409, 'CONFLICT');
	if (body.parentVersionId !== lineage.headVersion) throw new ApiError(409, 'HEAD_MOVED');
	await assertQuota(db, userId, now);
	const prepared = await prepare(db, userId, body.envelope, now, deps, 'version');
	const result = await appendVersion(db, {
		lineageId: lineage.id,
		ownerUserId: userId,
		expectedHead: body.parentVersionId,
		curve: prepared.curve,
		version: prepared.version,
		now
	});
	if (!result.ok) throw repoError(result.code);
	return announce(
		{ lineageId: lineage.id, versionId: result.value.versionId, curveId: prepared.curve.id },
		deps
	);
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
		if ((await missing(db, sourceLineageId)).kind === 'gone') throw new ApiError(410, 'GONE');
		throw new ApiError(404, 'NOT_FOUND');
	}
	if (source.status !== 'active') throw new ApiError(410, 'GONE');
	if (source.moderation !== 'visible') throw new ApiError(404, 'NOT_FOUND');
	await assertHeadPasses(db, source, now, deps);
	const versionId = body.versionId ?? source.headVersion;
	const view = versionId !== null ? await readVersion(db, versionId, viewer, now, deps) : null;
	if (!view || view.version.lineageId !== source.id) throw new ApiError(404, 'NOT_FOUND');
	await assertQuota(db, userId, now);
	const raw = body.envelope ?? envelopeOf(view.version, view.curve, now);
	const prepared = await prepare(db, userId, raw, now, deps, 'fork');
	const byLicense = view.version.license === 'CC-BY-4.0';
	if (byLicense && prepared.version.license !== 'CC-BY-4.0') throw invalidCurve(['env:enum']);
	const result = await forkLineage(db, view.version.id, {
		lineageId: newId(),
		ownerUserId: userId,
		visibility: body.visibility ?? 'private',
		curve: prepared.curve,
		version: prepared.version,
		now
	});
	if (!result.ok) throw repoError(result.code);
	const info = announce({ ...result.value, curveId: prepared.curve.id }, deps);
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
 * hidden lineage stays hidden); a non-private lineage whose head now fails the gate is refused.
 */
export async function restoreCurve(
	db: D1Database,
	userId: string,
	lineageId: string,
	deps: CurveDeps = {}
): Promise<LineageState> {
	const now = clockOf(deps);
	const lineage = await ownedLineage(db, lineageId, userId, now, deps);
	if (lineage.visibility !== 'private') await assertHeadPasses(db, lineage, now, deps);
	const result = await restoreLineage(db, lineage.id, userId, now);
	if (!result.ok) throw repoError(result.code);
	return {
		lineageId: lineage.id,
		status: 'active',
		visibility: lineage.visibility,
		moderation: lineage.moderation
	};
}

/**
 * `PUT /api/v1/lineages/[id]/visibility`: owner only. Opening a lineage (unlisted or public)
 * re-gates its head first; moderation and status are unchanged.
 */
export async function changeVisibility(
	db: D1Database,
	userId: string,
	lineageId: string,
	visibility: LineageVisibility,
	deps: CurveDeps = {}
): Promise<LineageState> {
	const now = clockOf(deps);
	const lineage = await ownedLineage(db, lineageId, userId, now, deps);
	if (visibility !== 'private') await assertHeadPasses(db, lineage, now, deps);
	const result = await setLineageVisibility(db, lineage.id, userId, visibility, now);
	if (!result.ok) throw repoError(result.code);
	return {
		lineageId: lineage.id,
		status: lineage.status,
		visibility,
		moderation: lineage.moderation
	};
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
	if (!summary) return missing(db, lineageId);
	let version = summary.head;
	let curve = summary.curve;
	if (versionId !== undefined && versionId !== null && versionId !== summary.headVersion) {
		const view = await readVersion(db, versionId, viewer, now, deps);
		if (!view || view.version.lineageId !== summary.id) return { kind: 'not-found' };
		version = view.version;
		curve = view.curve;
	}
	const counts = (await countsForLineages(db, [summary.id], viewer)).get(summary.id) ?? {
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
				gate: { ok: curve.gateOk, reasons: [...curve.gateReasons], version: curve.gateVer }
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
	if (!summary) return missing(db, lineageId);
	let versions: Awaited<ReturnType<typeof listVersions>>;
	try {
		versions = await listVersions(db, summary.id, viewer, page);
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
