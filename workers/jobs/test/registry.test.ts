/// <reference types="vite/client" />
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import templateSource from '../wrangler.template.jsonc?raw';
import { utcDay } from '../src/jobs/dates.ts';
import {
  dayPrefix,
  enforceAccessLogRetention,
  RETENTION_DAYS,
} from '../src/jobs/access-log-retention.ts';
import { RANKINGS_CRON } from '../src/jobs/rankings.ts';
import { pruneRateLimitCounters } from '../src/jobs/rate-limit-gc.ts';
import {
  type CronExpression,
  CRONS,
  dispatchScheduled,
  JobFailedError,
  type JobRegistry,
  registry,
  type ScheduledJob,
} from '../src/jobs/registry.ts';

interface TemplateEnv {
  triggers?: { crons?: string[] };
  limits?: { cpu_ms?: number };
}

/** The template only has whole-line `//` comments, so dropping them leaves plain JSON. */
function templateEnvs(): Record<string, TemplateEnv> {
  const json = templateSource
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const config = JSON.parse(json) as TemplateEnv & { env?: Record<string, TemplateEnv> };
  const envs: Record<string, TemplateEnv> = { top: config };
  for (const name of ['production', 'staging']) envs[name] = config.env?.[name] ?? {};
  return envs;
}

function templateCrons(): Record<string, string[]> {
  const crons: Record<string, string[]> = {};
  for (const [name, entry] of Object.entries(templateEnvs())) {
    crons[name] = entry.triggers?.crons ?? [];
  }
  return crons;
}

function scheduledNames(cron: CronExpression): string[] {
  return registry.scheduled[cron]?.map((job) => job.name) ?? [];
}

describe('job registry', () => {
  it('registers the jobs per UTC cron (salt first daily, re-gate first hourly) and the access-log consumer', () => {
    expect(scheduledNames(CRONS.daily)).toEqual([
      'rotate-salt',
      'rate-limit-gc',
      'access-log-retention',
      's6-aggregate',
      'og-sweep',
      'cleanup',
    ]);
    // The re-gate has its own hourly tick and runs first in it: no daily job can starve it. The
    // backup comes last; it is registered only here (its week starts Monday 03:00 UTC, the hourly
    // tick at that time starts it and the next ticks resume it).
    expect(scheduledNames(CRONS.hourly)).toEqual(['regate', 'trades-expire', 'backup']);
    expect(scheduledNames(CRONS.daily)).not.toContain('regate');
    // FX4.9: the re-gate also runs every 15 minutes, before rankings (shorter list drain window).
    expect(scheduledNames(CRONS.quarterHour)).toEqual(['regate', 'rankings']);
    expect(registry.scheduled[CRONS.quarterHour]?.[0]).toBe(registry.scheduled[CRONS.hourly]?.[0]);
    // Weekly (Monday 03:00 UTC): only the public dump; the backup is not registered twice.
    expect(scheduledNames(CRONS.weekly)).toEqual(['public-dump']);
    for (const cron of [CRONS.daily, CRONS.quarterHour, CRONS.weekly]) {
      expect(scheduledNames(cron), cron).not.toContain('backup');
    }
    expect(CRONS).toEqual({
      daily: '5 0 * * *',
      hourly: '0 * * * *',
      quarterHour: '*/15 * * * *',
      weekly: '0 3 * * 1',
    });
    expect(CRONS.quarterHour).toBe(RANKINGS_CRON);
    expect(registry.queues['access-log']?.name).toBe('access-log-consumer');
  });

  it('gives every job a unique name (one job may be registered on several crons)', () => {
    const jobs = [
      ...new Set([
        ...Object.values(registry.scheduled).flatMap((list) => list ?? []),
        ...Object.values(registry.queues),
      ]),
    ];
    const names = jobs.map((job) => job.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const list of Object.values(registry.scheduled)) {
      const perCron = (list ?? []).map((job) => job.name);
      expect(new Set(perCron).size).toBe(perCron.length);
    }
  });

  it('keeps the template crons and the registry in sync in every environment', () => {
    const registered = Object.keys(registry.scheduled).sort();
    expect(registered).toEqual(Object.values(CRONS).sort());
    const crons = templateCrons();
    expect(Object.keys(crons)).toEqual(['top', 'production', 'staging']);
    for (const list of Object.values(crons)) {
      expect(list).toHaveLength(4);
      expect(list).toContain('0 3 * * 1');
      expect(new Set(list).size).toBe(list.length);
      expect([...list].sort()).toEqual(registered);
    }
    for (const cron of Object.values(CRONS)) expect(scheduledNames(cron).length).toBeGreaterThan(0);
  });

  it('caps CPU at 60 s per invocation in every environment of the template', () => {
    const envs = templateEnvs();
    expect(Object.keys(envs)).toEqual(['top', 'production', 'staging']);
    for (const entry of Object.values(envs)) expect(entry.limits).toEqual({ cpu_ms: 60000 });
  });

  it('runs every daily job from the cron trigger', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const now = new Date();
    await dispatchScheduled(
      createScheduledController({ cron: CRONS.daily, scheduledTime: now }),
      env,
      createExecutionContext(),
    );
    const events = logs.mock.calls.map((call) => JSON.parse(String(call[0])).event);
    logs.mockRestore();
    expect(events).toEqual(
      expect.arrayContaining([
        'job.rotate_salt',
        'job.rate_limit_gc',
        'job.access_log_retention',
        'job.s6_aggregate',
        'job.og-sweep',
        'job.cleanup',
      ]),
    );
    expect(events).not.toContain('job.regate');
    expect(await env.CONFIG.get(`salt:${utcDay(now, 1)}`, 'text')).not.toBeNull();
  });

  it('runs the hourly and quarter-hour jobs from their cron triggers', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const at = new Date();
    at.setUTCMinutes(0, 0, 0);
    await dispatchScheduled(
      createScheduledController({ cron: CRONS.hourly, scheduledTime: at }),
      env,
      ctx,
    );
    const hourlyCount = logs.mock.calls.length;
    await dispatchScheduled(
      createScheduledController({ cron: CRONS.quarterHour, scheduledTime: at }),
      env,
      ctx,
    );
    const events = logs.mock.calls.map((call) => JSON.parse(String(call[0])).event);
    logs.mockRestore();
    expect(events).toEqual(
      expect.arrayContaining(['job.regate', 'job.trades_expire', 'job.rankings']),
    );
    expect(events.indexOf('job.regate')).toBeLessThan(events.indexOf('job.trades_expire'));
    // The quarter-hour tick re-gates first, then materializes the rankings.
    const quarter = events.slice(hourlyCount);
    expect(quarter).toContain('job.regate');
    expect(quarter.indexOf('job.regate')).toBeLessThan(quarter.indexOf('job.rankings'));
  });

  it('keeps running the other jobs of a tick when one fails and logs the failure without data', async () => {
    const ran: string[] = [];
    const secret = 'secret-value-that-must-not-be-logged';
    const job = (name: string, fail: boolean): ScheduledJob => ({
      name,
      async run() {
        ran.push(name);
        if (fail) throw new TypeError(secret);
      },
    });
    const jobs: JobRegistry = {
      scheduled: { [CRONS.hourly]: [job('first', true), job('second', false), job('third', true)] },
      queues: {},
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outcome = await dispatchScheduled(
      createScheduledController({ cron: CRONS.hourly, scheduledTime: new Date() }),
      env,
      createExecutionContext(),
      jobs,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    const lines = errors.mock.calls.map((call) => String(call[0]));
    errors.mockRestore();

    expect(ran).toEqual(['first', 'second', 'third']);
    expect(outcome).toBeInstanceOf(JobFailedError);
    expect(outcome instanceof JobFailedError ? outcome.jobs : null).toEqual(['first', 'third']);
    const failures = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === 'job.failed');
    expect(failures).toEqual([
      { event: 'job.failed', job: 'first', cron: CRONS.hourly, error: 'TypeError' },
      { event: 'job.failed', job: 'third', cron: CRONS.hourly, error: 'TypeError' },
    ]);
    expect(lines.join('\n')).not.toContain(secret);
  });
});

describe('rate-limit-gc', () => {
  it('deletes only expired windows', async () => {
    const nowSeconds = 1_800_000_000;
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO rate_limit_counters (key, window_start, count, expires_at) VALUES (?, ?, ?, ?)',
      ).bind('gc:old', 1, 1, nowSeconds - 1),
      env.DB.prepare(
        'INSERT INTO rate_limit_counters (key, window_start, count, expires_at) VALUES (?, ?, ?, ?)',
      ).bind('gc:live', 1, 1, nowSeconds + 60),
    ]);
    expect(await pruneRateLimitCounters(env.DB, new Date(nowSeconds * 1000))).toBe(1);
    const rows = await env.DB.prepare(
      "SELECT key FROM rate_limit_counters WHERE key LIKE 'gc:%'",
    ).all<{ key: string }>();
    expect(rows.results.map((row) => row.key)).toEqual(['gc:live']);
  });
});

describe('access-log retention', () => {
  it('deletes objects and index rows older than 180 days, keeps the rest', async () => {
    const now = new Date('2026-10-16T00:05:00Z');
    const expired = utcDay(now, -RETENTION_DAYS - 1);
    const boundary = utcDay(now, -RETENTION_DAYS);
    const oldKey = `${dayPrefix(expired)}13-a.ndjson.enc`;
    const keptKey = `${dayPrefix(boundary)}13-b.ndjson.enc`;
    await env.MEDIA.put(oldKey, new Uint8Array([1]));
    await env.MEDIA.put(keptKey, new Uint8Array([2]));
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO access_log_objects (object_key, day, hour, key_id) VALUES (?, ?, ?, ?)',
      ).bind(oldKey, expired, 13, 'k1'),
      env.DB.prepare(
        'INSERT INTO access_log_objects (object_key, day, hour, key_id) VALUES (?, ?, ?, ?)',
      ).bind(keptKey, boundary, 13, 'k1'),
    ]);

    const result = await enforceAccessLogRetention(env.MEDIA, env.DB, now);
    expect(result).toEqual({ cutoff: boundary, objects: 1, rows: 1 });
    expect(await env.MEDIA.head(oldKey)).toBeNull();
    expect(await env.MEDIA.head(keptKey)).not.toBeNull();
    const rows = await env.DB.prepare('SELECT object_key FROM access_log_objects').all<{
      object_key: string;
    }>();
    expect(rows.results.map((row) => row.object_key)).toEqual([keptKey]);
    await env.MEDIA.delete(keptKey);
    await env.DB.prepare('DELETE FROM access_log_objects').run();
  });

  it('builds day prefixes in the object key layout', () => {
    expect(dayPrefix('2026-04-19')).toBe('access-log/2026/04/19/');
  });
});
