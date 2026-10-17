// T5.2: the dispatcher writes one `job_run` Analytics Engine point per job (name, ok/failed, ms)
// and is a no-op without the METRICS binding.
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import {
  CRONS,
  dispatchScheduled,
  type JobRegistry,
  type ScheduledJob,
} from '../src/jobs/registry.ts';

interface Point {
  indexes?: unknown[];
  blobs?: unknown[];
  doubles?: number[];
}

function job(name: string, fail: boolean): ScheduledJob {
  return {
    name,
    async run() {
      if (fail) throw new TypeError('payload-that-must-not-leak');
    },
  };
}

const jobs: JobRegistry = {
  scheduled: { [CRONS.hourly]: [job('first', false), job('second', true)] },
  queues: {},
};

describe('job metrics', () => {
  it('writes job name, ok/failed and duration for every job of the tick', async () => {
    const points: Point[] = [];
    const metrics = {
      writeDataPoint(point?: Point) {
        if (point) points.push(point);
      },
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await dispatchScheduled(
      createScheduledController({ cron: CRONS.hourly, scheduledTime: new Date() }),
      { ...env, METRICS: metrics },
      createExecutionContext(),
      jobs,
    ).catch(() => undefined);
    errors.mockRestore();
    expect(points.map((point) => point.blobs)).toEqual([
      ['job_run', 'first', 'ok'],
      ['job_run', 'second', 'failed'],
    ]);
    for (const point of points) {
      expect(point.indexes).toEqual(['job_run']);
      expect(point.doubles?.[0]).toBe(1);
      expect(point.doubles?.[1]).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(points)).not.toContain('payload-that-must-not-leak');
  });

  it('runs the jobs normally when the binding is absent', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outcome = await dispatchScheduled(
      createScheduledController({ cron: CRONS.hourly, scheduledTime: new Date() }),
      { ...env, METRICS: undefined as unknown as AnalyticsEngineDataset },
      createExecutionContext(),
      { scheduled: { [CRONS.hourly]: [job('only', false)] }, queues: {} },
    ).then(
      () => 'ok',
      () => 'failed',
    );
    errors.mockRestore();
    expect(outcome).toBe('ok');
  });
});
