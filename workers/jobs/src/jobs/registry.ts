// Typed job registry of the jobs Worker. Jobs are added by T3.3 (salt rotation, access-log
// consumer and retention), T4.12 (rankings, S6 aggregation, trade expiry, re-gate) and T5.7
// (retention cleanup, D1 backup, public dump; T5.3). An event
// with no registered job fails loudly: a cron that silently does nothing, or a queue batch that is
// acknowledged without being processed, would lose work.
//
// Every cron is UTC (Cloudflare cron triggers always are). Each job is idempotent for a given
// `scheduledTime` (a retried or duplicated tick redoes the same work or finds nothing left), logs
// one JSON line with counts only on success, and the dispatcher logs one JSON line per failure.
//
// Metrics (T5.2): every job run writes one `job_run` data point (job name, ok/failed, ms) to the
// METRICS Analytics Engine dataset; a no-op when the binding is absent (tests, local).
import {
  metricsFromEnv,
  recordJobRun,
} from '../../../../web/src/lib/server/observability/metrics.ts';
import { runRankingsJob } from '../../../../web/src/lib/server/social/rankings.ts';
import { accessLogConsumerJob } from './access-log-consumer.ts';
import { accessLogRetentionJob } from './access-log-retention.ts';
import { backupJob } from './backup.ts';
import { cleanupJob } from './cleanup.ts';
import { ogSweepJob } from './og-sweep.ts';
import { publicDumpJob } from './public-dump.ts';
import { createRankingsJob } from './rankings.ts';
import { rateLimitGcJob } from './rate-limit-gc.ts';
import { regateJob } from './regate.ts';
import { rotateSaltJob } from './rotate-salt.ts';
import { s6AggregateJob } from './s6-aggregate.ts';
import { tradesExpireJob } from './trades-expire.ts';

/** Cron expressions declared in wrangler.template.jsonc (`triggers.crons`), all UTC. */
export const CRONS = {
  /** 00:05 UTC every day. */
  daily: '5 0 * * *',
  /** Minute 0 of every hour. */
  hourly: '0 * * * *',
  /** Minutes 0, 15, 30 and 45 of every hour. */
  quarterHour: '*/15 * * * *',
  /** 03:00 UTC every Monday. */
  weekly: '0 3 * * 1',
} as const;
export type CronExpression = (typeof CRONS)[keyof typeof CRONS];

/** Logical queues consumed by this Worker; physical names come from `vars`. */
export type QueueKind = 'access-log';

export interface ScheduledJob {
  /** Stable identifier used in logs (never logs payloads). */
  readonly name: string;
  run(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
}

export interface QueueJob {
  readonly name: string;
  run(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void>;
}

export interface JobRegistry {
  readonly scheduled: Readonly<Partial<Record<CronExpression, readonly ScheduledJob[]>>>;
  readonly queues: Readonly<Partial<Record<QueueKind, QueueJob>>>;
}

export class JobNotRegisteredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobNotRegisteredError';
  }
}

export class JobFailedError extends Error {
  readonly jobs: readonly string[];

  constructor(jobs: readonly string[], options?: { cause?: unknown }) {
    super(`Job(s) failed: ${jobs.join(', ')}`, options);
    this.name = 'JobFailedError';
    this.jobs = jobs;
  }
}

/**
 * - Daily (00:05 UTC): salt rotation first (tomorrow's salt must exist before midnight), then the
 *   rate-limit and access-log retention sweeps, the S6 aggregation (bounded window, pair cap and
 *   estimator budget), the OG image sweep and the retention cleanup (T5.3, bounded per run; what
 *   is left goes the next day).
 * - Hourly: the re-gate of curves cached under an older gate version FIRST (the most CPU-heavy
 *   step, ~150 ms per curve, time-budgeted in regate.ts and only non-zero after a threshold
 *   change; on its own cron so no daily job can starve it, and the next hour continues where it
 *   stopped), then S7 trade expiry and re-pairing, then the D1 backup again so an unfinished
 *   weekly backup resumes (idempotent per ISO week: once the manifest exists, a run is one KV
 *   read).
 * - Weekly (Monday 03:00 UTC): the D1 backup to R2, then the public dump.
 * - Every 15 minutes: the re-gate again (FX4.9: shortens the window in which lists still show a
 *   head the current gate rejects; idempotent, so its overlap with the hourly run at minute 0
 *   only re-reads an empty stale set or redoes the same verdicts), THEN rankings
 *   materialization, so a fresh ranking already sees the refreshed verdicts.
 * Queue: the access-log consumer.
 * Each invocation runs under `limits.cpu_ms` of wrangler.template.jsonc.
 */
export const registry: JobRegistry = {
  scheduled: {
    [CRONS.daily]: [
      rotateSaltJob,
      rateLimitGcJob,
      accessLogRetentionJob,
      s6AggregateJob,
      ogSweepJob,
      cleanupJob,
    ],
    [CRONS.hourly]: [regateJob, tradesExpireJob, backupJob],
    [CRONS.quarterHour]: [regateJob, createRankingsJob(runRankingsJob)],
    [CRONS.weekly]: [backupJob, publicDumpJob],
  },
  queues: {
    'access-log': accessLogConsumerJob,
  },
};

function isCron(value: string): value is CronExpression {
  return (Object.values(CRONS) as readonly string[]).includes(value);
}

/** Maps a physical queue name to its logical kind using the Worker's own `vars`. */
export function queueKind(
  queueName: string,
  env: Pick<Env, 'ACCESS_LOG_QUEUE_NAME'>,
): QueueKind | null {
  return queueName === env.ACCESS_LOG_QUEUE_NAME ? 'access-log' : null;
}

/** Error class name only: messages may carry data (SQL values, ids) and are never logged. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Runs every job registered for the controller's cron, one after another, in registration order.
 * A failing job does not stop the others: it is logged as one JSON line (job name, cron and error
 * class, no message, no payload) and the failures are rethrown together afterwards, so the
 * invocation is still reported as failed.
 */
export async function dispatchScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  jobs: JobRegistry = registry,
): Promise<void> {
  const list = isCron(controller.cron) ? jobs.scheduled[controller.cron] : undefined;
  if (!list || list.length === 0) {
    throw new JobNotRegisteredError(`No scheduled job registered for cron "${controller.cron}"`);
  }
  const failed: string[] = [];
  let firstError: unknown;
  const metrics = metricsFromEnv(env);
  for (const job of list) {
    const started = Date.now();
    try {
      await job.run(controller, env, ctx);
      recordJobRun(metrics, job.name, true, Date.now() - started);
    } catch (error) {
      recordJobRun(metrics, job.name, false, Date.now() - started);
      failed.push(job.name);
      firstError ??= error;
      console.error(
        JSON.stringify({
          event: 'job.failed',
          job: job.name,
          cron: controller.cron,
          error: errorName(error),
        }),
      );
    }
  }
  if (failed.length) throw new JobFailedError(failed, { cause: firstError });
}

/**
 * Hands the batch to the job registered for its queue. Throwing makes the runtime retry the
 * batch and, after the retries, move it to the dead-letter queue.
 */
export async function dispatchQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext,
  jobs: JobRegistry = registry,
): Promise<void> {
  const kind = queueKind(batch.queue, env);
  const job = kind ? jobs.queues[kind] : undefined;
  if (!job) {
    throw new JobNotRegisteredError(
      `No queue job registered for ${kind ? `queue kind "${kind}"` : 'this queue'}`,
    );
  }
  const metrics = metricsFromEnv(env);
  const started = Date.now();
  try {
    await job.run(batch, env, ctx);
  } catch (error) {
    recordJobRun(metrics, job.name, false, Date.now() - started);
    throw error;
  }
  recordJobRun(metrics, job.name, true, Date.now() - started);
}
