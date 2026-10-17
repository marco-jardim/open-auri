// Re-gate (T4.12, plan §3.7 and f4 brief "gate_ver"): curves whose cached gate verdict was
// computed under another gate version (`THRESHOLDS` or the gate implementation ordinal `GATE_IMPL`
// changed) are gated again, up to `REGATE_LIMIT` per run and within `REGATE_BUDGET_MS` of wall
// time, heads of linkable lineages first (then oldest), and their `gate_ok`/`gate_reasons` updated
// in `curves`. Stale heads are also re-gated lazily when someone opens them by id (curves service),
// so the job only has to drain what nobody opened.
//
// The logic is the web's (`regateStale` in web/src/lib/server/social/gate.ts), imported by relative
// path like s6-aggregate.ts and trades-expire.ts; its `#lib/*` imports resolve through
// web/package.json "imports". Idempotent: a re-gated curve carries the current gate version and is
// never picked again, and the upsert only changes rows whose stored version differs and never
// overwrites a row of a newer gate implementation. A run that stops on its budget (or on an error)
// leaves the remaining curves stale for the next run.
//
// Cost: ~150 ms of CPU per curve in workerd, so the 20 s budget re-gates ~130 curves per run. In
// steady state there is nothing stale and the run is a single query.
//
// Logs carry counts and timings only: no curve id, no S1.
import { REGATE_BUDGET_MS, regateStale } from '../../../../web/src/lib/server/social/gate.ts';
import type { ScheduledJob } from './registry.ts';

export const REGATE_JOB = 'regate';

/** Upper bound of curves re-gated per run (the time budget usually stops the run first). */
export const REGATE_LIMIT = 200;

/** Wall-clock budget of one run (ms); no new curve is started once it is spent. */
export { REGATE_BUDGET_MS };

export interface RegateRunResult {
  /** Stale curves processed by this run. */
  checked: number;
  /** Curves whose verdict (ok flag or reasons) changed. */
  changed: number;
  /** True when the run stopped because the time budget was spent (stale curves may remain). */
  timedOut?: boolean;
}

export type RegateRunner = (
  db: D1Database,
  limit: number,
  now: number,
  options: { budgetMs: number },
) => Promise<RegateRunResult>;

/** The `regate` scheduled job around `runner` (injectable for tests). */
export function createRegateJob(
  runner: RegateRunner,
  budgetMs: number = REGATE_BUDGET_MS,
): ScheduledJob {
  return {
    name: REGATE_JOB,
    async run(controller, env) {
      const started = Date.now();
      const result = await runner(env.DB, REGATE_LIMIT, controller.scheduledTime, { budgetMs });
      console.log(
        JSON.stringify({
          event: 'job.regate',
          checked: result.checked,
          changed: result.changed,
          timedOut: result.timedOut === true,
          ms: Date.now() - started,
        }),
      );
    },
  };
}

export const regateJob: ScheduledJob = createRegateJob(regateStale);
