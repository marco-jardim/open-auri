// Moderation service (T4.8, plan §3.7): reports filed by verified users, automatic hiding when
// AUTO_HIDE_THRESHOLD distinct eligible accounts (verified, not banned, at least
// MIN_REPORTER_AGE_MS old; YOLO_AUTO_HIDE_THRESHOLD for a lineage whose head is YOLO) report a
// lineage or pack, and the admin decisions of /admin/moderacao
// (hide, restore, remove, dismiss, ban the author, curation). Every change is audited
// (admin/audit.ts): admin decisions audit-first through `audited`, the automatic hiding with
// actor_kind 'system'. Audit details hold ids, counts and the admin-written reason only; report
// notes never leave the admin queue. No `$app/*`: tested inside workerd.
import type { D1Database } from '@cloudflare/workers-types';
import { audited, auditStatementWhen, type AuditOptions } from '#lib/server/admin/audit.ts';
import {
	banUser,
	BAN_DURATIONS,
	REASON_MAX,
	REASON_MIN,
	type BanDuration,
	type ModerationDeps
} from '#lib/server/admin/users.ts';
import { recordReport, type MetricsDataset } from '#lib/server/observability/metrics.ts';
import {
	autoHideLineage,
	countEligibleReporters,
	curateLineage,
	getHeadClass,
	insertReport,
	listReportQueue,
	resolveReports,
	setModeration
} from '#lib/server/social/repo.ts';
import {
	DAY_MS,
	isOneOf,
	REPORT_REASONS,
	REPORT_TARGET_KINDS,
	type ModerationState,
	type ReportReason,
	type ReportResolution,
	type ReportTargetKind
} from '#lib/server/social/types.ts';
import {
	findTarget,
	openReportSummary,
	targetPreview,
	type OpenReportSummary,
	type TargetPreview
} from '#lib/server/social/queries/moderation.ts';

/** Distinct eligible reporters that hide a lineage or pack automatically. */
export const AUTO_HIDE_THRESHOLD = 3;
/** Same, for a lineage whose head is a YOLO curve (migration 0013): hidden sooner. */
export const YOLO_AUTO_HIDE_THRESHOLD = 2;
/** Minimum account age of a reporter that counts towards the automatic hiding. */
export const MIN_REPORTER_AGE_MS = 3 * DAY_MS;

export const MODERATION_ACTIONS = {
	autoHide: 'moderation.auto_hide',
	hide: 'moderation.hide',
	restore: 'moderation.restore',
	remove: 'moderation.remove',
	dismiss: 'moderation.dismiss',
	banAuthor: 'moderation.ban_author',
	curate: 'moderation.curate',
	uncurate: 'moderation.uncurate'
} as const;

// ---- Reports --------------------------------------------------------------------------------

export interface FileReportInput {
	reporterUserId: string;
	targetKind: ReportTargetKind;
	/** Public nickname for user targets; lineage/pack id otherwise. Never an internal user id. */
	targetId: string;
	reason: ReportReason;
	note: string | null;
	now: number;
	/** Report id (defaults to a random UUID). */
	id?: string;
	/** Analytics Engine dataset (T5.2): one `report` point (target kind, reason) per new report. */
	metrics?: MetricsDataset | null;
	/**
	 * Kill switch of YOLO publication (ServerEnv `yoloPublication`); absent = 'off': someone
	 * else's YOLO lineage is then not readable, so reporting it is NOT_FOUND like a missing one.
	 */
	yoloPublication?: 'on' | 'off';
}

export type FileReportResult =
	| { ok: true; autoHidden: boolean }
	| { ok: false; code: 'NOT_FOUND' | 'SELF' | 'DUPLICATE' | 'INVALID' };

/**
 * Files one report. The target must be readable by the reporter (otherwise NOT_FOUND, the same
 * answer as a missing target); one's own content or profile is refused (SELF); a second report
 * of the same target by the same reporter is DUPLICATE. After the insert, the automatic hiding
 * rule runs for lineages and packs.
 */
export async function fileReport(
	db: D1Database,
	input: FileReportInput,
	auditOptions: AuditOptions = {}
): Promise<FileReportResult> {
	if (!isOneOf(REPORT_TARGET_KINDS, input.targetKind) || !isOneOf(REPORT_REASONS, input.reason)) {
		return { ok: false, code: 'INVALID' };
	}
	const target = await findTarget(
		db,
		input.targetKind,
		input.targetId,
		{ userId: input.reporterUserId },
		input.now,
		input.yoloPublication ?? 'off'
	);
	if (!target) return { ok: false, code: 'NOT_FOUND' };
	if (target.ownerUserId === input.reporterUserId) return { ok: false, code: 'SELF' };
	const note = input.note === null ? null : input.note.trim();
	const inserted = await insertReport(db, {
		id: input.id ?? crypto.randomUUID(),
		targetKind: input.targetKind,
		targetId: target.id,
		reason: input.reason,
		note: note === '' ? null : note,
		reporterUserId: input.reporterUserId,
		now: input.now
	});
	if (!inserted.ok) return { ok: false, code: 'INVALID' };
	if (!inserted.value.created) return { ok: false, code: 'DUPLICATE' };
	recordReport(input.metrics, input.targetKind, input.reason);
	if (target.kind === 'user') return { ok: true, autoHidden: false };
	const autoHidden = await maybeAutoHide(db, target.kind, target.id, input.now, auditOptions);
	return { ok: true, autoHidden };
}

/**
 * Applies the automatic hiding to a lineage or pack when enough eligible accounts reported it.
 * Only a target that is still 'visible' changes, so an admin decision (hidden, removed, or a
 * restore followed by resolved reports) is never overridden. Writes the audit row (actor_kind
 * 'system') before the change. Returns whether the target was hidden.
 *
 * A lineage is judged by the class of its head AS THE WRITE RUNS (repo.ts autoHideLineage: the
 * threshold condition is part of the UPDATE, and the audit row is written in the same batch under
 * the same condition): YOLO_AUTO_HIDE_THRESHOLD for a YOLO head, AUTO_HIDE_THRESHOLD otherwise. An
 * owner who appends a standard version after the reporters were counted is judged by the standard
 * threshold, and the audit detail records the threshold actually applied (`yolo: true` with the
 * YOLO one).
 */
export async function maybeAutoHide(
	db: D1Database,
	kind: 'lineage' | 'pack',
	id: string,
	now: number,
	auditOptions: AuditOptions = {}
): Promise<boolean> {
	const reporters = await countEligibleReporters(db, kind, id, {
		minAccountAgeMs: MIN_REPORTER_AGE_MS,
		now
	});
	if (reporters < Math.min(YOLO_AUTO_HIDE_THRESHOLD, AUTO_HIDE_THRESHOLD)) return false;
	if (kind === 'lineage') {
		const thresholds = { standard: AUTO_HIDE_THRESHOLD, yolo: YOLO_AUTO_HIDE_THRESHOLD };
		const applied = await autoHideLineage(db, id, reporters, thresholds, now, (rule, condition) =>
			auditStatementWhen(
				db,
				{
					actorId: null,
					actorKind: 'system',
					action: MODERATION_ACTIONS.autoHide,
					targetKind: kind,
					targetId: id,
					detail: rule.yolo
						? { reporters, threshold: rule.threshold, yolo: true }
						: { reporters, threshold: rule.threshold }
				},
				condition,
				auditOptions
			)
		);
		return applied !== null;
	}
	const threshold = AUTO_HIDE_THRESHOLD;
	if (reporters < threshold) return false;
	const current = await findTarget(db, kind, id, { userId: null, admin: true });
	if (!current || current.moderation !== 'visible') return false;
	return audited(
		db,
		{
			actorId: null,
			actorKind: 'system',
			action: MODERATION_ACTIONS.autoHide,
			targetKind: kind,
			targetId: id,
			detail: { reporters, threshold }
		},
		() => setModeration(db, kind, id, 'auto_hidden', now, 'visible'),
		auditOptions
	);
}

// ---- Admin queue ----------------------------------------------------------------------------

export interface QueueItem extends OpenReportSummary {
	targetKind: ReportTargetKind;
	targetId: string;
	openReports: number;
	/** Open reports that count for the automatic hiding (eligible accounts). */
	eligibleReporters: number;
	firstAt: number;
	lastAt: number;
	/** Null when the target no longer exists. */
	preview: TargetPreview | null;
}

export interface QueuePage {
	items: QueueItem[];
	nextCursor: string | null;
}

export const QUEUE_PAGE_SIZE = 20;

/** One page of the admin queue: targets with open reports, most recently reported first. */
export async function loadQueue(
	db: D1Database,
	options: { cursor?: string | null; limit?: number; now: number }
): Promise<QueuePage> {
	const page = await listReportQueue(db, {
		cursor: options.cursor ?? null,
		limit: options.limit ?? QUEUE_PAGE_SIZE
	});
	const items = await Promise.all(
		page.items.map(async (entry): Promise<QueueItem> => {
			const [summary, preview, eligibleReporters] = await Promise.all([
				openReportSummary(db, entry.targetKind, entry.targetId),
				targetPreview(db, entry.targetKind, entry.targetId),
				countEligibleReporters(db, entry.targetKind, entry.targetId, {
					minAccountAgeMs: MIN_REPORTER_AGE_MS,
					now: options.now
				})
			]);
			return { ...entry, ...summary, eligibleReporters, preview };
		})
	);
	return { items, nextCursor: page.nextCursor };
}

// ---- Admin decisions ------------------------------------------------------------------------

export type ModerationDecision =
	'hide' | 'restore' | 'remove' | 'dismiss' | 'ban' | 'curate' | 'uncurate';

export type DecisionError =
	| 'INVALID_INPUT'
	| 'NOT_FOUND'
	| 'UNSUPPORTED'
	| 'NO_AUTHOR'
	| 'SELF'
	| 'TARGET_IS_ADMIN'
	| 'FAILED';

export type DecisionResult = { ok: true; resolved: number } | { ok: false; code: DecisionError };

export interface DecisionInput {
	decision: ModerationDecision;
	targetKind: ReportTargetKind;
	targetId: string;
	/** Admin-written reason (required except for curation). */
	reason: string;
	/** Ban length (decision 'ban' only). */
	duration?: BanDuration;
}

export interface DecisionDeps extends ModerationDeps {
	now?: () => number;
}

const TARGET_ID = /^[A-Za-z0-9_-]{1,64}$/;

const STATE_CHANGES: Record<
	'hide' | 'restore' | 'remove',
	{ state: ModerationState; resolution: ReportResolution; action: string }
> = {
	hide: { state: 'hidden', resolution: 'hidden', action: MODERATION_ACTIONS.hide },
	restore: { state: 'visible', resolution: 'restored', action: MODERATION_ACTIONS.restore },
	remove: { state: 'removed', resolution: 'removed', action: MODERATION_ACTIONS.remove }
};

/** Decisions that need a fresh admin session (re-authentication). */
export const DESTRUCTIVE_DECISIONS: readonly ModerationDecision[] = ['remove', 'ban'];

export function isDestructive(decision: ModerationDecision): boolean {
	return DESTRUCTIVE_DECISIONS.includes(decision);
}

function validReason(reason: string, required: boolean): boolean {
	if (reason === '') return !required;
	if (reason.length < REASON_MIN || reason.length > REASON_MAX) return false;
	for (const char of reason) {
		const code = char.codePointAt(0) ?? 0;
		const control = code < 0x20 && char !== '\n' && char !== '\r' && char !== '\t';
		if (control || code === 0x7f) return false;
	}
	return true;
}

function field(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value.trim() : '';
}

/** Parses a decision form (targetKind, targetId, reason, duration); null when invalid. */
export function parseDecisionForm(
	form: FormData,
	decision: ModerationDecision
): DecisionInput | null {
	const targetKind = field(form, 'targetKind');
	const targetId = field(form, 'targetId');
	const reason = field(form, 'reason');
	if (!isOneOf(REPORT_TARGET_KINDS, targetKind) || !TARGET_ID.test(targetId)) return null;
	const curation = decision === 'curate' || decision === 'uncurate';
	if (!validReason(reason, !curation)) return null;
	if (decision !== 'ban') return { decision, targetKind, targetId, reason };
	const duration = field(form, 'duration');
	if (!isOneOf(BAN_DURATIONS, duration)) return null;
	return { decision, targetKind, targetId, reason, duration };
}

/**
 * Runs one admin decision on a report target, audited (audit-first), and resolves its open
 * reports: hide → 'hidden', restore → 'restored', remove → 'removed', dismiss → 'dismissed',
 * ban → 'banned' (the author's ban itself goes through admin/users.ts `banUser`, audited as
 * `user.ban`). Curation only applies to lineages and leaves the reports open.
 */
export async function decide(deps: DecisionDeps, input: DecisionInput): Promise<DecisionResult> {
	const now = (deps.now ?? Date.now)();
	const target = await findTarget(deps.db, input.targetKind, input.targetId, {
		userId: deps.actorId,
		admin: true
	});
	if (!target) return { ok: false, code: 'NOT_FOUND' };
	const base = {
		actorId: deps.actorId,
		actorKind: 'admin' as const,
		targetKind: target.kind,
		targetId: target.id
	};
	const reason: Record<string, string> = input.reason === '' ? {} : { reason: input.reason };
	try {
		switch (input.decision) {
			case 'hide':
			case 'restore':
			case 'remove': {
				if (target.kind === 'user') return { ok: false, code: 'UNSUPPORTED' };
				const kind = target.kind;
				const change = STATE_CHANGES[input.decision];
				const resolved = await audited(
					deps.db,
					{ ...base, action: change.action, detail: { ...reason, previous: target.moderation } },
					async () => {
						await setModeration(deps.db, kind, target.id, change.state, now);
						return resolveReports(deps.db, target.kind, target.id, change.resolution, now);
					},
					deps.audit
				);
				return { ok: true, resolved };
			}
			case 'dismiss': {
				const resolved = await audited(
					deps.db,
					{ ...base, action: MODERATION_ACTIONS.dismiss, detail: reason },
					() => resolveReports(deps.db, target.kind, target.id, 'dismissed', now),
					deps.audit
				);
				return { ok: true, resolved };
			}
			case 'curate':
			case 'uncurate': {
				if (target.kind !== 'lineage') return { ok: false, code: 'UNSUPPORTED' };
				const curated = input.decision === 'curate';
				// A YOLO head is never an editorial pick.
				if (curated && (await getHeadClass(deps.db, target.id))?.yolo === true) {
					return { ok: false, code: 'UNSUPPORTED' };
				}
				const entry = {
					...base,
					action: curated ? MODERATION_ACTIONS.curate : MODERATION_ACTIONS.uncurate,
					detail: reason
				};
				// The pick and its audit row in one batch, under the same condition (repo.ts
				// curateLineage), so the head is checked again as the write runs: refused (an append
				// made the head YOLO after the check above, or the lineage is gone), nothing is written,
				// no audit row either.
				const written = await curateLineage(deps.db, target.id, curated, now, (condition) =>
					auditStatementWhen(deps.db, entry, condition, deps.audit)
				);
				if (!written) return { ok: false, code: curated ? 'UNSUPPORTED' : 'NOT_FOUND' };
				return { ok: true, resolved: 0 };
			}
			case 'ban': {
				const authorId = target.ownerUserId;
				if (authorId === null) return { ok: false, code: 'NO_AUTHOR' };
				const banned = await banUser(deps, {
					userId: authorId,
					reason: input.reason,
					duration: input.duration ?? 'permanent'
				});
				if (!banned.ok) {
					const code =
						banned.code === 'INVALID_INPUT' || banned.code === 'NOT_BANNED'
							? 'FAILED'
							: banned.code;
					return { ok: false, code };
				}
				const resolved = await audited(
					deps.db,
					{ ...base, action: MODERATION_ACTIONS.banAuthor, detail: { authorId, ...reason } },
					() => resolveReports(deps.db, target.kind, target.id, 'banned', now),
					deps.audit
				);
				return { ok: true, resolved };
			}
		}
	} catch {
		// `audited` already appended `<action>.failed` with the error name; the page shows a
		// generic failure.
		return { ok: false, code: 'FAILED' };
	}
	return { ok: false, code: 'INVALID_INPUT' };
}
