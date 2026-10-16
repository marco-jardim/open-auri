// Retention backstop of the access log (plan T3.3 item 7: 6 months). The R2 lifecycle rule on
// `access-log/` (180 days) is the primary purge; this job deletes, every day, the objects of the
// days that fell out of the window (with a catch-up margin for missed runs) and their index rows,
// and reports how many it found: a non-zero count means the lifecycle rule is not doing its job.
import { isDay, utcDay } from './dates.ts';
import { OBJECT_PREFIX } from './access-log-consumer.ts';
import type { ScheduledJob } from './registry.ts';

export const RETENTION_DAYS = 180;
/** Days before the cutoff that are re-checked on every run. */
export const CATCH_UP_DAYS = 14;

export function dayPrefix(day: string): string {
  return `${OBJECT_PREFIX}${day.replaceAll('-', '/')}/`;
}

export interface RetentionResult {
  cutoff: string;
  objects: number;
  rows: number;
}

/** Deletes objects and index rows of days strictly before `now − RETENTION_DAYS`. */
export async function enforceAccessLogRetention(
  media: Pick<R2Bucket, 'list' | 'delete'>,
  db: D1Database,
  now: Date,
): Promise<RetentionResult> {
  const cutoff = utcDay(now, -RETENTION_DAYS);
  let objects = 0;
  for (let offset = 1; offset <= CATCH_UP_DAYS; offset += 1) {
    const day = utcDay(now, -RETENTION_DAYS - offset);
    if (!isDay(day)) continue;
    let cursor: string | undefined;
    do {
      const page = await media.list({ prefix: dayPrefix(day), ...(cursor ? { cursor } : {}) });
      const keys = page.objects.map((object) => object.key);
      if (keys.length) {
        await media.delete(keys);
        objects += keys.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  const deleted = await db
    .prepare('DELETE FROM access_log_objects WHERE day < ?')
    .bind(cutoff)
    .run();
  return { cutoff, objects, rows: deleted.meta.changes };
}

export const accessLogRetentionJob: ScheduledJob = {
  name: 'access-log-retention',
  async run(controller, env) {
    const result = await enforceAccessLogRetention(
      env.MEDIA,
      env.DB,
      new Date(controller.scheduledTime),
    );
    const level = result.objects > 0 ? 'warn' : 'log';
    console[level](
      JSON.stringify({
        event: 'job.access_log_retention',
        objects: result.objects,
        rows: result.rows,
      }),
    );
  },
};
