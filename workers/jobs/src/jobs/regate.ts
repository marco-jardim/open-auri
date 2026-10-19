// Re-gate (T4.12, plan §3.7 and f4 brief "gate_ver"): curves whose cached gate verdict was
// computed under another gate version (`THRESHOLDS`, `YOLO_THRESHOLDS` or the gate implementation
// ordinal `GATE_IMPL` changed) are classified again, up to `REGATE_LIMIT` per run and within
// `REGATE_BUDGET_MS` of wall time, standard or YOLO heads of linkable lineages first (then the
// other heads of publicly listable lineages, then oldest), and their class updated in `curves`:
// `gate_ok` (standard), `gate_yolo` (YOLO, migration 0013) and `gate_reasons` (the waived codes of a
// YOLO curve, the blocking ones of a rejected curve), with `gate_ver` and `level_db`. Stale heads
// are also re-gated lazily when someone opens them by id (curves service), so the job only has to
// drain what nobody opened.
//
// The logic is the web's (`regateStale` in web/src/lib/server/social/gate.ts), imported by relative
// path like s6-aggregate.ts and trades-expire.ts; its `#lib/*` imports resolve through
// web/package.json "imports". Idempotent: a re-gated curve carries the current gate version and is
// never picked again, and the upsert only changes rows whose stored version differs and never
// overwrites a row of a newer gate implementation. A run that stops on its budget (or on an error)
// leaves the remaining curves stale for the next run.
//
// Cost: one write-gate run (~150 ms of CPU in workerd) per standard curve and per curve rejected on
// a reason no YOLO waiver lifts, two runs (~300 ms: the standard profile, then the YOLO profile on
// the same snapshot) per YOLO curve and per curve the YOLO profile rejects; so the 20 s budget
// re-gates between ~65 (all YOLO) and ~130 (all standard) curves per run. In steady state there is
// nothing stale and the run is a single query.
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
  /** Curves whose verdict (class: gate_ok / gate_yolo, or reasons) changed. */
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
