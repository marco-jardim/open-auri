// S7 trade maintenance (T4.10), hourly: expires waiting and matched trades whose 72 h deadline
// passed, then retries pairing of the waiting ones (trades that missed each other at join time).
// The logic is the web's trades service (shared D1 database), imported by relative path; its own
// `#lib/*` imports resolve through web/package.json "imports". Registered by T4.12, not here.
// Logs carry counts only (no ids, no user data).
import { runTradeMaintenance } from '../../../../web/src/lib/server/social/trades.ts';
import type { ScheduledJob } from './registry.ts';

export const TRADES_EXPIRE_JOB = 'trades-expire';

/** One run at `now` (epoch ms): expired trades and pairs made. */
export async function expireAndPairTrades(
  db: D1Database,
  now: number,
): Promise<{ expired: number; paired: number }> {
  return runTradeMaintenance(db, now);
}

export const tradesExpireJob: ScheduledJob = {
  name: TRADES_EXPIRE_JOB,
  async run(controller, env) {
    const { expired, paired } = await expireAndPairTrades(env.DB, controller.scheduledTime);
    console.log(JSON.stringify({ event: 'job.trades_expire', expired, paired }));
  },
};
