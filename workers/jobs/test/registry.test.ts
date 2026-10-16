import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { utcDay } from '../src/jobs/dates.ts';
import {
  dayPrefix,
  enforceAccessLogRetention,
  RETENTION_DAYS,
} from '../src/jobs/access-log-retention.ts';
import { pruneRateLimitCounters } from '../src/jobs/rate-limit-gc.ts';
import { CRONS, dispatchScheduled, registry } from '../src/jobs/registry.ts';

describe('job registry', () => {
  it('registers the daily jobs (salt first) and the access-log consumer', () => {
    expect(registry.scheduled[CRONS.daily]?.map((job) => job.name)).toEqual([
      'rotate-salt',
      'rate-limit-gc',
      'access-log-retention',
    ]);
    expect(registry.queues['access-log']?.name).toBe('access-log-consumer');
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
      expect.arrayContaining(['job.rotate_salt', 'job.rate_limit_gc', 'job.access_log_retention']),
    );
    expect(await env.CONFIG.get(`salt:${utcDay(now, 1)}`, 'text')).not.toBeNull();
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
