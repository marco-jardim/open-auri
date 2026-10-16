// Daily re-gate (T4.12, plan §3.7 and f4 brief "gate_ver"): curves whose cached gate verdict was
// computed under another gate version (`THRESHOLDS` changed) are gated again, up to
// `REGATE_LIMIT` per run, oldest first, and their `gate_ok`/`gate_reasons` updated in `curves`.
//
// The logic is the web's (`regateStale` in web/src/lib/server/social/gate.ts), imported by relative
// path like s6-aggregate.ts and trades-expire.ts; its `#lib/*` imports resolve through
// web/package.json "imports". Idempotent: a re-gated curve carries the current gate version and is
// never picked again, and the upsert only changes rows whose stored version differs. A run that
// stops halfway (CPU limit, error) leaves the remaining curves stale for the next day.
//
// Cost: ~150 ms of CPU per curve in workerd, so a full run of 200 curves is ~30 s. In steady state
// there is nothing stale and the run is a single query.
//
// Logs carry counts and timings only: no curve id, no S1.
import { regateStale } from '../../../../web/src/lib/server/social/gate.ts';
import type { ScheduledJob } from './registry.ts';

export const REGATE_JOB = 'regate';

/** Curves re-gated per daily run. */
export const REGATE_LIMIT = 200;

export interface RegateRunResult {
  /** Stale curves processed by this run. */
  checked: number;
  /** Curves whose verdict (ok flag or reasons) changed. */
  changed: number;
}

export type RegateRunner = (db: D1Database, limit: number, now: number) => Promise<RegateRunResult>;

/** The `regate` scheduled job around `runner` (injectable for tests). */
export function createRegateJob(runner: RegateRunner): ScheduledJob {
  return {
    name: REGATE_JOB,
    async run(controller, env) {
      const started = Date.now();
      const result = await runner(env.DB, REGATE_LIMIT, controller.scheduledTime);
      console.log(
        JSON.stringify({
          event: 'job.regate',
          checked: result.checked,
          changed: result.changed,
          ms: Date.now() - started,
        }),
      );
    },
  };
}

export const regateJob: ScheduledJob = createRegateJob(regateStale);
