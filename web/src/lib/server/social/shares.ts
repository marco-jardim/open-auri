// Shares service (T4.5, plan §3.7 "Compartilhamentos"): share links with a channel, the share
// funnel and the data of the public page `/c/[id]`.
//
// - Creating a share needs a lineage the caller can link: public or unlisted (with the public
//   rules), or the caller's own; anything else answers 404 (never "exists but forbidden").
// - Opens are ALWAYS anonymous: one daily aggregate per share (`share_events.anon_count`). No IP,
//   user agent or user id is stored for them; the rate limit uses the kit's daily-salted IP hash.
// - Previews, installs and favorites of signed-in users with `activity_visibility = 'public'` are
//   attributed by the routes that record them (`recordShareEvent`); private actors never are.
// - Statistics (`shareStatsFor`) only for the lineage author's own shares: anyone may share a
//   public lineage, but a non-author sharer gets 404 on the stats (FX4.6).
// SQL lives in repo.ts and queries/shares.ts.
import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import type { SharedCurveData, SharedCurveMeta } from '#lib/components/pages/shared-curve/types.ts';
import { ApiError } from '#lib/server/api/errors.ts';
import { apiRateLimit, type ApiLimitEnv, type ApiRateRule } from '#lib/server/api/limits.ts';
import type { gateForWrite } from 'open-auri/safety';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import {
	isGateCurrent,
	regateCurve,
	regateRejectedHead,
	regateRejectedVersion
} from '#lib/server/social/gate.ts';
import { isLineageOwner, isRetractedLinkable } from '#lib/server/social/queries/shares.ts';
import {
	createShare,
	getLineageForViewer,
	getShare,
	getShareStats,
	getVersionForViewer,
	isSocialId,
	recordShareEvent,
	type VersionView
} from '#lib/server/social/repo.ts';
import type { LineageSummary, SocialErrorCode, Viewer } from '#lib/server/social/types.ts';

/** Injection points of the by-id public reads (tests); the defaults are the production ones. */
export interface PublicReadDeps {
	/** Gate used when a stored verdict is stale (default: the core's gateForWrite). */
	gate?: typeof gateForWrite;
	now?: number;
}

function regateOptions(deps: PublicReadDeps): { gate?: typeof gateForWrite } {
	return deps.gate ? { gate: deps.gate } : {};
}

/**
 * The lineage as `viewer` may read it by id, with a current gate verdict on its head (FX4.9): a
 * head cached under a stale gate version is re-gated and the lineage read again, so a head the
 * current gate rejects is not linkable (null for anyone but the owner or an admin). A head hidden
 * because it is cached as REJECTED under a stale gate version is re-gated too (#27,
 * regateRejectedHead: linkable lineages only), so it is served once the current gate accepts it.
 * One gate run at most. Same rule as `readLineage` in curves.ts. The id must already be valid
 * (`isSocialId`).
 */
export async function readCurrentLineage(
	db: D1Database,
	lineageId: string,
	viewer: Viewer,
	deps: PublicReadDeps = {}
): Promise<LineageSummary | null> {
	const now = deps.now ?? Date.now();
	const summary = await getLineageForViewer(db, lineageId, viewer);
	if (!summary) {
		if (!(await regateRejectedHead(db, lineageId, now, regateOptions(deps)))) return null;
		return getLineageForViewer(db, lineageId, viewer);
	}
	if (await isGateCurrent(summary.curve.gateVer)) return summary;
	await regateCurve(db, summary.curve, now, regateOptions(deps));
	return getLineageForViewer(db, lineageId, viewer);
}

/**
 * A version as `viewer` may read it by id, with current gate verdicts (FX4.9): its own curve and,
 * for an older version, the head curve of its lineage (the head decides linkability) are re-gated
 * when stale, then the version is read again. A version hidden because its own curve or its head
 * is cached as rejected under a stale gate version is re-gated first (#27). At most one gate run
 * per curve (two per read). Null when it is not readable afterwards.
 */
export async function readCurrentVersion(
	db: D1Database,
	versionId: string,
	viewer: Viewer,
	deps: PublicReadDeps = {}
): Promise<VersionView | null> {
	const now = deps.now ?? Date.now();
	let view = await getVersionForViewer(db, versionId, viewer);
	if (!view) {
		if (!(await regateRejectedVersion(db, versionId, now, regateOptions(deps)))) return null;
		// Re-gated curves are current now; a head still stale (accepted) is handled below.
		view = await getVersionForViewer(db, versionId, viewer);
		if (!view) return null;
	}
	let regated = false;
	if (!(await isGateCurrent(view.curve.gateVer))) {
		await regateCurve(db, view.curve, now, regateOptions(deps));
		regated = true;
	}
	if (view.lineage.headVersion !== view.version.id) {
		const lineage = await getLineageForViewer(db, view.lineage.id, viewer);
		if (lineage && !(await isGateCurrent(lineage.curve.gateVer))) {
			await regateCurve(db, lineage.curve, now, regateOptions(deps));
			regated = true;
		}
	}
	return regated ? getVersionForViewer(db, versionId, viewer) : view;
}

export const SHARE_CHANNELS = ['link', 'qr', 'whatsapp', 'x', 'email', 'other'] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

const ID_MAX = 64;

export const CreateShareBody = z
	.object({
		lineageId: z.string().min(1).max(ID_MAX),
		versionId: z.string().min(1).max(ID_MAX).optional(),
		channel: z.enum(SHARE_CHANNELS).optional()
	})
	.strict();
export type CreateShareInput = z.infer<typeof CreateShareBody>;

/** Rate rule of the anonymous open counter (API route and page load share the same bucket). */
export const OPEN_RATE_GROUP = 'api.shares.open';
export const OPEN_DAILY_QUOTA = 300;
export const OPEN_RATE_RULE: ApiRateRule = {
	group: OPEN_RATE_GROUP,
	kind: 'write',
	quotas: [{ limit: OPEN_DAILY_QUOTA }]
};

/** 16 base64url characters from 12 random bytes (accepted by `isSocialId`). */
export function newShareId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Relative link of a share: `/c/<lineageId>?s=<shareId>`. */
export function shareUrl(lineageId: string, shareId: string): string {
	return `/c/${encodeURIComponent(lineageId)}?s=${encodeURIComponent(shareId)}`;
}

/** UTC day (YYYY-MM-DD) of the aggregate; nothing finer than the day is kept. */
export function utcDay(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

function repoError(code: SocialErrorCode): ApiError {
	switch (code) {
		case 'not-found':
			return new ApiError(404, 'NOT_FOUND');
		case 'invalid-input':
			return new ApiError(400, 'INVALID_BODY');
		default:
			return new ApiError(500, 'INTERNAL');
	}
}

export interface CreatedShare {
	shareId: string;
	url: string;
}

/** Creates a share of a lineage the caller can link (see the header). */
export async function createShareFor(
	db: D1Database,
	userId: string,
	input: CreateShareInput,
	now: number = Date.now()
): Promise<CreatedShare> {
	if (!isSocialId(input.lineageId)) throw new ApiError(404, 'NOT_FOUND');
	if (input.versionId !== undefined && !isSocialId(input.versionId)) {
		throw new ApiError(404, 'NOT_FOUND');
	}
	const id = newShareId();
	const result = await createShare(db, {
		id,
		lineageId: input.lineageId,
		versionId: input.versionId ?? null,
		ownerUserId: userId,
		channel: input.channel ?? null,
		now
	});
	if (!result.ok) throw repoError(result.code);
	return { shareId: result.value.id, url: shareUrl(result.value.lineageId, result.value.id) };
}

export interface ShareFunnel {
	shareId: string;
	/** Anonymous opens per UTC day, oldest first. */
	opens: { total: number; days: { day: string; count: number }[] };
	/** Distinct signed-in users attributed to the share, per kind. */
	attributed: { previewed: number; installed: number; favorited: number };
}

/**
 * Funnel of a share, only for the AUTHOR of the lineage who also made the share (FX4.6). A
 * non-author sharer, anyone else and an unknown id all get 404: a share of someone else's
 * lineage gives no statistics at all, not even anonymous opens, so sharing a curve with one
 * person can never be used to learn what that person did. Attributed counts only include users
 * with public activity (activity.ts, library.ts); the author's audience view keeps its exact
 * `privateCount` (plan §3.7, "N pessoas com perfil privado").
 */
export async function shareStatsFor(
	db: D1Database,
	userId: string,
	shareId: string
): Promise<ShareFunnel> {
	if (!isSocialId(shareId)) throw new ApiError(404, 'NOT_FOUND');
	const share = await getShare(db, shareId);
	if (!share || share.ownerUserId !== userId) throw new ApiError(404, 'NOT_FOUND');
	if (!(await isLineageOwner(db, share.lineageId, userId))) throw new ApiError(404, 'NOT_FOUND');
	const stats = await getShareStats(db, shareId, userId);
	if (!stats) throw new ApiError(404, 'NOT_FOUND');
	const days = stats.days
		.filter((entry) => entry.kind === 'open')
		.map((entry) => ({ day: entry.day, count: entry.count }));
	return {
		shareId: stats.shareId,
		opens: { total: stats.totals.open.anonymous, days },
		attributed: {
			previewed: stats.totals.previewed.users,
			installed: stats.totals.installed.users,
			favorited: stats.totals.favorited.users
		}
	};
}

/**
 * Increments the anonymous daily open counter of a share. Returns false for an unknown share.
 * Opens are never attributed, even for a signed-in visitor.
 */
export async function recordShareOpen(
	db: D1Database,
	shareId: string,
	now: number = Date.now()
): Promise<boolean> {
	if (!isSocialId(shareId)) return false;
	return recordShareEvent(db, { shareId, kind: 'open', userId: null, day: utcDay(now), at: now });
}

/**
 * The page-load path of the open counter: the same rate rule as `POST /api/v1/shares/[id]/open`
 * (kit limiter, daily-salted IP hash when signed out). A refused or unavailable limiter skips the
 * count (the page still renders); returns whether the open was counted.
 */
export async function recordShareOpenLimited(
	env: ApiLimitEnv,
	event: { request: Request; locals: AuthLocals },
	shareId: string,
	now: number = Date.now()
): Promise<boolean> {
	try {
		await apiRateLimit(env, event, OPEN_RATE_RULE, new Date(now));
	} catch (error) {
		if (error instanceof ApiError) return false;
		throw error;
	}
	return recordShareOpen(env.db, shareId, now);
}

export type SharedCurveResult =
	{ kind: 'ok'; curve: SharedCurveData } | { kind: 'not-found' } | { kind: 'gone' };

/**
 * Data of `/c/[id]` for `viewer`, read through the repository visibility (linkable, or the
 * viewer's own). Retracted lineages are `gone` (410); unknown, private or moderated ones are
 * `not-found`. With a share of this lineage that names a version the viewer can read, that
 * version is shown; otherwise the head. Stale gate verdicts are refreshed first (FX4.9), so a
 * head the current gate rejects is `not-found` for anyone but the owner or an admin.
 */
export async function loadSharedCurve(
	db: D1Database,
	viewer: Viewer,
	lineageId: string,
	shareId: string | null,
	deps: PublicReadDeps = {}
): Promise<SharedCurveResult> {
	if (!isSocialId(lineageId)) return { kind: 'not-found' };
	const lineage = await readCurrentLineage(db, lineageId, viewer, deps);
	if (!lineage) {
		return (await isRetractedLinkable(db, lineageId)) ? { kind: 'gone' } : { kind: 'not-found' };
	}
	if (lineage.status === 'retracted') return { kind: 'gone' };

	const share = shareId !== null && isSocialId(shareId) ? await getShare(db, shareId) : null;
	const ownShare = share !== null && share.lineageId === lineage.id ? share : null;

	let version = lineage.head;
	let curve = lineage.curve;
	if (ownShare?.versionId && ownShare.versionId !== lineage.head.id) {
		const view = await readCurrentVersion(db, ownShare.versionId, viewer, deps);
		if (view && view.version.lineageId === lineage.id) {
			version = view.version;
			curve = view.curve;
		}
	}
	return {
		kind: 'ok',
		curve: {
			lineageId: lineage.id,
			versionId: version.id,
			isHead: version.id === lineage.head.id,
			name: version.name,
			description: version.description,
			license: version.license,
			lang: version.lang,
			author: lineage.author
				? { username: lineage.author.username, displayUsername: lineage.author.displayUsername }
				: null,
			s1: curve.s1,
			// Filter labels of the shown version (page only; never the OG image or meta tags).
			labels: version.labels,
			visibility: lineage.visibility,
			shareId: ownShare ? ownShare.id : null
		}
	};
}

/** Absolute URLs of the meta tags; `origin` is PUBLIC_ORIGIN (never the request host). */
export function sharedCurveMeta(origin: string, curve: SharedCurveData): SharedCurveMeta {
	const base = origin.replace(/\/+$/, '');
	return {
		canonical: `${base}/c/${encodeURIComponent(curve.lineageId)}`,
		image: `${base}/og/${encodeURIComponent(curve.versionId)}.png`,
		indexable: curve.visibility === 'public'
	};
}
