import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRankingsJob,
  RANKINGS_CRON,
  RankingsJobError,
  type RankingsRunSummary,
} from '../src/jobs/rankings.ts';

const scheduledTime = Date.UTC(2026, 9, 16, 12, 15);

function summary(overrides: Partial<RankingsRunSummary> = {}): RankingsRunSummary {
  return { computedAt: scheduledTime, applied: 6, skipped: 0, rows: 42, failed: [], ...overrides };
}

describe('rankings job', () => {
  afterEach(() => vi.restoreAllMocks());

  it('recomputes on the shared D1 at the scheduled time and logs one structured line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const calls: { db: D1Database; now: number }[] = [];
    const job = createRankingsJob(async (db, now) => {
      calls.push({ db, now });
      return summary();
    });
    expect(job.name).toBe('rankings');

    const controller = createScheduledController({ scheduledTime, cron: RANKINGS_CRON });
    await job.run(controller, env, createExecutionContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.db).toBe(env.DB);
    expect(calls[0]?.now).toBe(scheduledTime);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'job.rankings',
        computedAt: scheduledTime,
        applied: 6,
        skipped: 0,
        rows: 42,
        failed: 0,
      }),
    );
  });

  it('passes the same time on a retried tick (idempotent input)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const seen: number[] = [];
    const job = createRankingsJob(async (_db, now) => {
      seen.push(now);
      return summary();
    });
    const controller = createScheduledController({ scheduledTime, cron: RANKINGS_CRON });
    await job.run(controller, env, createExecutionContext());
    await job.run(controller, env, createExecutionContext());
    expect(seen).toEqual([scheduledTime, scheduledTime]);
  });

  it('fails with the failed pairs after logging, so the dispatcher reports it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const job = createRankingsJob(async () =>
      summary({ applied: 5, rows: 10, failed: ['installs/30d'] }),
    );
    const controller = createScheduledController({ scheduledTime, cron: RANKINGS_CRON });
    const error = await job.run(controller, env, createExecutionContext()).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RankingsJobError);
    expect(error).toMatchObject({ pairs: ['installs/30d'] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"failed":1'));
  });

  it('propagates a runner error without logging a summary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const job = createRankingsJob(async () => {
      throw new Error('d1 down');
    });
    const controller = createScheduledController({ scheduledTime, cron: RANKINGS_CRON });
    await expect(job.run(controller, env, createExecutionContext())).rejects.toThrow('d1 down');
    expect(log).not.toHaveBeenCalled();
  });
});
