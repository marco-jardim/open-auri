// Deletes expired rate-limit windows (table rate_limit_counters, migration 0007). Their keys hold
// keyed hashes made with a daily salt; dropping them daily keeps the table small and bounded to
// the salt's lifetime.
import type { ScheduledJob } from './registry.ts';

export async function pruneRateLimitCounters(db: D1Database, now: Date): Promise<number> {
  const result = await db
    .prepare('DELETE FROM rate_limit_counters WHERE expires_at < ?')
    .bind(Math.floor(now.getTime() / 1000))
    .run();
  return result.meta.changes;
}

export const rateLimitGcJob: ScheduledJob = {
  name: 'rate-limit-gc',
  async run(controller, env) {
    const deleted = await pruneRateLimitCounters(env.DB, new Date(controller.scheduledTime));
    console.log(JSON.stringify({ event: 'job.rate_limit_gc', deleted }));
  },
};
