// Typed job registry of the jobs Worker. Jobs are added by T3.3 (salt rotation, access-log
// consumer and retention). An event with no registered job fails loudly: a cron that silently does
// nothing, or a queue batch that is acknowledged without being processed, would lose work.
import { accessLogConsumerJob } from './access-log-consumer.ts';
import { accessLogRetentionJob } from './access-log-retention.ts';
import { rateLimitGcJob } from './rate-limit-gc.ts';
import { rotateSaltJob } from './rotate-salt.ts';

/** Cron expressions declared in wrangler.template.jsonc (`triggers.crons`). */
export const CRONS = { daily: '5 0 * * *' } as const;
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
 * Daily (00:05 UTC): salt rotation first (tomorrow's salt must exist before midnight), then the
 * rate-limit and access-log retention sweeps. Queue: the access-log consumer.
 */
export const registry: JobRegistry = {
  scheduled: {
    [CRONS.daily]: [rotateSaltJob, rateLimitGcJob, accessLogRetentionJob],
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

/**
 * Runs every job registered for the controller's cron, one after another. A failing job does not
 * stop the others; the failures are reported together afterwards (job names only).
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
  for (const job of list) {
    try {
      await job.run(controller, env, ctx);
    } catch (error) {
      failed.push(job.name);
      firstError ??= error;
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
  await job.run(batch, env, ctx);
}
