import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishS6Preferences,
  S6_CACHE_CONTROL,
  s6AggregateJob,
} from '../src/jobs/s6-aggregate.ts';

const KEY = 's6/preferences.json';

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** One batch with the hand-computed 3-item example: MLE ∝ (4, 2, 1) → normalized (2, 1, 0.5). */
async function seed(): Promise<{ ids: [string, string, string]; batchId: string }> {
  const prefix = `job-${randomHex(4)}`;
  const ids: [string, string, string] = [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`];
  const [a, b, c] = ids;
  const batchId = `jobbatch-${randomHex(8)}`;
  const games: [string, string, 'a' | 'b' | 'tie', number][] = [
    [a, b, 'a', 2],
    [a, b, 'b', 1],
    [b, c, 'a', 2],
    [b, c, 'b', 1],
    [a, c, 'a', 4],
    [a, c, 'b', 1],
  ];
  const statements = [
    env.DB.prepare(
      'INSERT INTO s6_batches (id, receipt_hash, consent_ver, day) VALUES (?, ?, ?, ?)',
    ).bind(batchId, randomHex(32), 's6-consent-v1', '2026-10-15'),
  ];
  for (const [x, y, choice, times] of games) {
    for (let i = 0; i < times; i++) {
      statements.push(
        env.DB.prepare(
          'INSERT INTO s6_pairs (batch_id, a, b, choice, level_matched) VALUES (?, ?, ?, ?, 1)',
        ).bind(batchId, x, y, choice),
      );
    }
  }
  await env.DB.batch(statements);
  return { ids, batchId };
}

interface Published {
  generatedAt: string;
  consentVersion: string;
  items: { curveId: string; score: number; comparisons: number }[];
  pairs: number;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('s6-aggregate job', () => {
  it('publishes the Bradley–Terry JSON to R2 with JSON content type and a 5 min cache', async () => {
    const { ids, batchId } = await seed();
    const now = new Date('2026-10-16T00:05:00.000Z');
    const result = await publishS6Preferences(env.DB, env.MEDIA, now);
    expect(result.pairs).toBeGreaterThanOrEqual(11);

    const object = await env.MEDIA.get(KEY);
    expect(object).not.toBeNull();
    expect(object?.httpMetadata?.contentType).toBe('application/json');
    expect(object?.httpMetadata?.cacheControl).toBe(S6_CACHE_CONTROL);
    const body = JSON.parse((await object?.text()) ?? 'null') as Published;
    expect(Object.keys(body).sort()).toEqual(['consentVersion', 'generatedAt', 'items', 'pairs']);
    expect(body.generatedAt).toBe(now.toISOString());
    expect(body.consentVersion).toBe('s6-consent-v1');

    const mine = body.items.filter((item) => ids.includes(item.curveId));
    expect(mine).toEqual([
      { curveId: ids[0], score: 2, comparisons: 8 },
      { curveId: ids[1], score: 1, comparisons: 6 },
      { curveId: ids[2], score: 0.5, comparisons: 8 },
    ]);
    // No day, batch or pair id leaks into the public object.
    const text = JSON.stringify(body);
    expect(text).not.toContain(batchId);
    expect(text).not.toContain('2026-10-15');

    await env.DB.prepare('DELETE FROM s6_batches WHERE id = ?').bind(batchId).run();
  });

  it('runs as a ScheduledJob named s6-aggregate with a PII-free log line', async () => {
    const { ids, batchId } = await seed();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const controller: ScheduledController = {
      scheduledTime: Date.parse('2026-10-16T00:05:00.000Z'),
      cron: '5 0 * * *',
      noRetry() {},
    };
    expect(s6AggregateJob.name).toBe('s6-aggregate');
    await s6AggregateJob.run(controller, env, createExecutionContext());

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.event).toBe('job.s6_aggregate');
    expect(Object.keys(parsed).sort()).toEqual(['bytes', 'event', 'items', 'ms', 'pairs']);
    for (const id of [...ids, batchId]) expect(line).not.toContain(id);
    expect(await env.MEDIA.head(KEY)).not.toBeNull();

    await env.DB.prepare('DELETE FROM s6_batches WHERE id = ?').bind(batchId).run();
  });
});
