// Daily retention cleanup (T5.3), aligned with docs/lgpd.md. Each step deletes rows that are past
// their retention and nothing else:
//
//   step              table(s)                          retention (lgpd.md operation)
//   sessions          session                           until "expiresAt" (op. 3)
//   verifications     verification                      until "expiresAt" (op. 2, tokens)
//   link-uses         auth_link_uses                    until expires_at (op. 2, tokens)
//   email-changes     email_change_requests             until expires_at (op. 2, pending change)
//   access-log-index  access_log_objects                180 days (op. 25; the R2 objects have the
//                                                       lifecycle rule and access-log-retention)
//   suppressions      email_suppressions                12 months after created_at (op. 19)
//   audit             audit_log                         5 years (op. 12; allowed by 0011)
//   s6                s6_batches + s6_pairs             24 months (op. 13; the published
//                                                       aggregate is recomputed from what is left)
//   username-holds    username_holds                    until released_at (op. 4, 90 days)
//   tombstones        lineages (+ trades, reports)      retracted, not updated for 365 days and
//                                                       with no fork of any of their versions
//
// Better Auth's DATE columns hold ISO-8601 strings (an epoch number is accepted too, as in
// web/src/lib/server/account/sessions.ts). Every other time column is epoch milliseconds, except
// the UTC days of access_log_objects and s6_batches.
//
// Bounded per run: each step deletes at most `rowsPerRound` rows per statement and runs at most
// `maxRounds` statements; the whole run stops starting new rounds after `budgetMs`. What is left
// is deleted by the next day's run. Idempotent: a retried run finds less (or nothing) to delete.
// Steps whose table does not exist are skipped. Logs carry counts per step only.
import { DAY_MS, utcDay } from './dates.ts';
import type { ScheduledJob } from './registry.ts';

export const CLEANUP_JOB = 'cleanup';

/** Retention constants (see the table in the file header and docs/operacao/backups.md). */
export const CLEANUP_RETENTION = Object.freeze({
  accessLogDays: 180,
  suppressionMonths: 12,
  auditYears: 5,
  s6Months: 24,
  tombstoneDays: 365,
});

export interface CleanupLimits {
  /** Rows deleted per statement (s6: batches, capped at 90; tombstones: lineages, capped at 50). */
  rowsPerRound: number;
  /** Statements per step and run. */
  maxRounds: number;
  /** Wall time per run, checked before each round. */
  budgetMs: number;
}

export const CLEANUP_LIMITS: Readonly<CleanupLimits> = Object.freeze({
  rowsPerRound: 500,
  maxRounds: 10,
  budgetMs: 20_000,
});

/** Ids per round of the steps that bind them as parameters (D1 allows 100 per statement). */
const TOMBSTONE_BATCH_MAX = 50;
const S6_BATCH_MAX = 90;

/** `now` shifted by whole UTC calendar months (negative = back). */
function shiftMonths(now: Date, months: number): number {
  const date = new Date(now.getTime());
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

export interface CleanupCutoffs {
  /** Epoch ms now. */
  nowMs: number;
  /** ISO-8601 now, for Better Auth DATE columns. */
  nowIso: string;
  accessLogDay: string;
  suppressionMs: number;
  auditMs: number;
  s6Day: string;
  tombstoneMs: number;
}

/** Cutoffs for `now`: everything strictly older is past retention. */
export function cleanupCutoffs(now: Date): CleanupCutoffs {
  const nowMs = now.getTime();
  return {
    nowMs,
    nowIso: now.toISOString(),
    accessLogDay: utcDay(now, -CLEANUP_RETENTION.accessLogDays),
    suppressionMs: shiftMonths(now, -CLEANUP_RETENTION.suppressionMonths),
    // One day older than the 0011 trigger's own cutoff, so a delete never trips it.
    auditMs: shiftMonths(now, -12 * CLEANUP_RETENTION.auditYears) - DAY_MS,
    s6Day: new Date(shiftMonths(now, -CLEANUP_RETENTION.s6Months)).toISOString().slice(0, 10),
    tombstoneMs: nowMs - CLEANUP_RETENTION.tombstoneDays * DAY_MS,
  };
}

interface CleanupStep {
  readonly name: string;
  /** Tables that must all exist for the step to run. */
  readonly tables: readonly string[];
  /** Cap on the per-round limit (steps that bind the ids they delete). */
  readonly maxPerRound?: number;
  /** One bounded round of at most `limit` rows; returns the number of rows (or lineages) deleted. */
  round(db: D1Database, cutoffs: CleanupCutoffs, limit: number): Promise<number>;
}

/** "expiresAt" past `now`, for an ISO string or an epoch-ms number. */
const BETTER_AUTH_EXPIRED =
  `((typeof("expiresAt") = 'text' AND "expiresAt" < ?) ` +
  `OR (typeof("expiresAt") IN ('integer', 'real') AND "expiresAt" < ?))`;

/** `DELETE ... WHERE key IN (SELECT key ... WHERE where LIMIT ?)`, binding `params` then the limit. */
function boundedDelete(table: string, key: string, where: string, params: readonly unknown[]) {
  return async (db: D1Database, limit: number): Promise<number> => {
    const result = await db
      .prepare(
        `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${where} LIMIT ?)`,
      )
      .bind(...params, limit)
      .run();
    return result.meta.changes;
  };
}

async function deleteS6(db: D1Database, cutoffs: CleanupCutoffs, limit: number): Promise<number> {
  const doomed = await db
    .prepare('SELECT id FROM s6_batches WHERE day < ? ORDER BY day, id LIMIT ?')
    .bind(cutoffs.s6Day, limit)
    .all<{ id: string }>();
  const ids = doomed.results.map((row) => row.id);
  if (ids.length === 0) return 0;
  const marks = ids.map(() => '?').join(', ');
  // Pairs first (explicit, not only through ON DELETE CASCADE), then their batches, atomically.
  const [, batches] = await db.batch([
    db.prepare(`DELETE FROM s6_pairs WHERE batch_id IN (${marks})`).bind(...ids),
    db.prepare(`DELETE FROM s6_batches WHERE id IN (${marks})`).bind(...ids),
  ]);
  return batches?.meta.changes ?? 0;
}

/** Retracted, untouched for the retention period, and no lineage forked from any of its versions. */
const TOMBSTONE_WHERE =
  "l.status = 'retracted' AND l.updated_at < ? AND NOT EXISTS (" +
  'SELECT 1 FROM lineages f JOIN versions fv ON fv.id = f.forked_from_version ' +
  'WHERE fv.lineage_id = l.id AND f.id <> l.id)';

async function deleteTombstones(
  db: D1Database,
  cutoffs: CleanupCutoffs,
  limit: number,
): Promise<number> {
  const doomed = await db
    .prepare(`SELECT l.id AS id FROM lineages l WHERE ${TOMBSTONE_WHERE} ORDER BY l.id LIMIT ?`)
    .bind(cutoffs.tombstoneMs, limit)
    .all<{ id: string }>();
  const ids = doomed.results.map((row) => row.id);
  if (ids.length === 0) return 0;
  const marks = ids.map(() => '?').join(', ');
  // Same order as the account deletion (web/src/lib/server/social/deletion.ts): free the trade
  // partners, drop the trades and the reports about these lineages, then the lineages (versions,
  // favorites, activity, shares, pack items and rankings go by ON DELETE CASCADE).
  const results = await db.batch([
    db
      .prepare(
        "UPDATE trades SET status = 'cancelled' WHERE status IN ('waiting', 'matched') " +
          `AND match_id IN (SELECT id FROM trades WHERE lineage_id IN (${marks}))`,
      )
      .bind(...ids),
    db.prepare(`DELETE FROM trades WHERE lineage_id IN (${marks})`).bind(...ids),
    db
      .prepare(`DELETE FROM reports WHERE target_kind = 'lineage' AND target_id IN (${marks})`)
      .bind(...ids),
    db.prepare(`DELETE FROM lineages WHERE id IN (${marks})`).bind(...ids),
  ]);
  return results[results.length - 1]?.meta.changes ?? 0;
}

export const CLEANUP_STEPS: readonly CleanupStep[] = [
  {
    name: 'sessions',
    tables: ['session'],
    round: (db, c, limit) =>
      boundedDelete('"session"', '"id"', BETTER_AUTH_EXPIRED, [c.nowIso, c.nowMs])(db, limit),
  },
  {
    name: 'verifications',
    tables: ['verification'],
    round: (db, c, limit) =>
      boundedDelete('"verification"', '"id"', BETTER_AUTH_EXPIRED, [c.nowIso, c.nowMs])(db, limit),
  },
  {
    name: 'link-uses',
    tables: ['auth_link_uses'],
    round: (db, c, limit) =>
      boundedDelete('auth_link_uses', 'token_hash', 'expires_at < ?', [c.nowMs])(db, limit),
  },
  {
    name: 'email-changes',
    tables: ['email_change_requests'],
    round: (db, c, limit) =>
      boundedDelete('email_change_requests', 'user_id', 'expires_at < ?', [c.nowMs])(db, limit),
  },
  {
    name: 'access-log-index',
    tables: ['access_log_objects'],
    round: (db, c, limit) =>
      boundedDelete('access_log_objects', 'object_key', 'day < ?', [c.accessLogDay])(db, limit),
  },
  {
    name: 'suppressions',
    tables: ['email_suppressions'],
    round: (db, c, limit) =>
      boundedDelete('email_suppressions', 'address_hash', 'created_at < ?', [c.suppressionMs])(
        db,
        limit,
      ),
  },
  {
    name: 'audit',
    tables: ['audit_log'],
    round: (db, c, limit) =>
      boundedDelete('audit_log', 'id', 'created_at < ?', [c.auditMs])(db, limit),
  },
  { name: 's6', tables: ['s6_batches', 's6_pairs'], maxPerRound: S6_BATCH_MAX, round: deleteS6 },
  {
    name: 'username-holds',
    tables: ['username_holds'],
    round: (db, c, limit) =>
      boundedDelete('username_holds', 'skeleton', 'released_at < ?', [c.nowMs])(db, limit),
  },
  {
    name: 'tombstones',
    tables: ['lineages', 'versions', 'trades', 'reports'],
    maxPerRound: TOMBSTONE_BATCH_MAX,
    round: deleteTombstones,
  },
];

export interface CleanupOptions {
  limits?: Readonly<CleanupLimits>;
  /** Milliseconds clock for the time budget (default `Date.now`). */
  clock?: () => number;
}

export interface CleanupResult {
  /** Rows deleted per step (lineages for `tombstones`); skipped steps are absent. */
  deleted: Record<string, number>;
  /** True when every step ran out of rows to delete (nothing left for the next run). */
  done: boolean;
}

/** One bounded pass of every step (see the file header). */
export async function runCleanup(
  db: D1Database,
  now: Date,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const limits = options.limits ?? CLEANUP_LIMITS;
  const clock = options.clock ?? Date.now;
  const started = clock();
  const cutoffs = cleanupCutoffs(now);
  const present = new Set(
    (
      await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all<{ name: string }>()
    ).results.map((row) => row.name),
  );
  const result: CleanupResult = { deleted: {}, done: true };
  for (const step of CLEANUP_STEPS) {
    if (!step.tables.every((table) => present.has(table))) continue;
    let total = 0;
    let exhausted = false;
    for (let round = 0; round < limits.maxRounds; round += 1) {
      if (clock() - started >= limits.budgetMs) break;
      const limit = Math.min(limits.rowsPerRound, step.maxPerRound ?? limits.rowsPerRound);
      const changes = await step.round(db, cutoffs, limit);
      total += changes;
      if (changes < limit) {
        exhausted = true;
        break;
      }
    }
    result.deleted[step.name] = total;
    if (!exhausted) result.done = false;
  }
  return result;
}

/** The `cleanup` scheduled job (options injectable for tests). Not registered here. */
export function createCleanupJob(options: CleanupOptions = {}): ScheduledJob {
  return {
    name: CLEANUP_JOB,
    async run(controller, env) {
      const started = Date.now();
      const result = await runCleanup(env.DB, new Date(controller.scheduledTime), options);
      console.log(
        JSON.stringify({
          event: 'job.cleanup',
          ...result.deleted,
          done: result.done,
          ms: Date.now() - started,
        }),
      );
    },
  };
}

export const cleanupJob: ScheduledJob = createCleanupJob();
