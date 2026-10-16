// Rankings materialization (plan §3.7, T4.6): every 15 minutes, recompute every metric × window
// pair (favorites/installs × 7d/30d/all) at the cron's scheduled time. Registered by T4.12.
//
// The ranking rules (distinct verified, non-banned users, owner excluded, publicly listable
// lineages only, tie-break score → recent activity → id, stale runs ignored) live in the web's
// social repository and are run by `runRankingsJob` in web/src/lib/server/social/rankings.ts.
// This job stays thin and receives that function: the web modules use `#lib/*` subpath imports
// (web/package.json "imports"), which this package's vitest config has no alias for, and the
// jobs tsconfig enables `noUncheckedIndexedAccess`, which the web sources are not written for.
// Wiring (T4.12): `createRankingsJob(runRankingsJob)` once the jobs build resolves the web module.
import type { ScheduledJob } from './registry.ts';

/** Cadence of the materialization (the cron itself is declared by T4.12). */
export const RANKINGS_CRON = '*/15 * * * *';

/** Same shape as `RankingsJobSummary` of web/src/lib/server/social/rankings.ts (fields used here). */
export interface RankingsRunSummary {
  computedAt: number;
  /** Pairs written by this run. */
  applied: number;
  /** Pairs left untouched because a newer run is already stored. */
  skipped: number;
  /** Rows inserted by this run, all pairs together. */
  rows: number;
  /** `metric/window` of the pairs that failed (the others still ran). */
  failed: readonly string[];
}

export type RankingsRunner = (db: D1Database, now: number) => Promise<RankingsRunSummary>;

export class RankingsJobError extends Error {
  readonly pairs: readonly string[];

  constructor(pairs: readonly string[]) {
    super(`Rankings recompute failed for: ${pairs.join(', ')}`);
    this.name = 'RankingsJobError';
    this.pairs = pairs;
  }
}

/**
 * The `rankings` scheduled job: runs `runner` on the shared D1 at `controller.scheduledTime`
 * (a retried or duplicated tick recomputes the same rows; an older tick is ignored by the
 * repository), logs one structured line and fails when any pair failed.
 */
export function createRankingsJob(runner: RankingsRunner): ScheduledJob {
  return {
    name: 'rankings',
    async run(controller, env) {
      const summary = await runner(env.DB, controller.scheduledTime);
      console.log(
        JSON.stringify({
          event: 'job.rankings',
          computedAt: summary.computedAt,
          applied: summary.applied,
          skipped: summary.skipped,
          rows: summary.rows,
          failed: summary.failed.length,
        }),
      );
      if (summary.failed.length > 0) throw new RankingsJobError(summary.failed);
    },
  };
}
