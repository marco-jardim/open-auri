import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { utcDay } from '../src/jobs/dates.ts';
import { rotateSalts, saltExpiration, SALT_PREFIX } from '../src/jobs/rotate-salt.ts';

// KV rejects expirations in the past, so every date is relative to the real clock.
const now = new Date();
const day = (offset: number) => utcDay(now, offset);
const at = (offset: number) => new Date(`${day(offset)}T00:05:00Z`);

async function saltKeys(): Promise<Map<string, number | undefined>> {
  const page = await env.CONFIG.list({ prefix: SALT_PREFIX });
  return new Map(page.keys.map((key) => [key.name, key.expiration]));
}

describe('rotate-salt job', () => {
  beforeEach(async () => {
    for (const name of (await saltKeys()).keys()) await env.CONFIG.delete(name);
  });

  it('pre-creates today and tomorrow with a 32-byte salt and an absolute expiration', async () => {
    const result = await rotateSalts(env.CONFIG, at(0));
    expect(result.created).toEqual([day(0), day(1)]);

    const keys = await saltKeys();
    expect([...keys.keys()].sort()).toEqual([`salt:${day(0)}`, `salt:${day(1)}`]);
    expect(keys.get(`salt:${day(1)}`)).toBe(saltExpiration(day(1)));
    expect(await env.CONFIG.get(`salt:${day(0)}`, 'text')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps existing salts (idempotent) and deletes everything older than yesterday', async () => {
    await env.CONFIG.put(`salt:${day(-3)}`, 'old-1');
    await env.CONFIG.put(`salt:${day(-2)}`, 'old-2');
    await env.CONFIG.put(`salt:${day(-1)}`, 'yesterday');
    await env.CONFIG.put(`salt:${day(0)}`, 'today');
    await env.CONFIG.put('salt:not-a-day', 'junk');
    await env.CONFIG.put('unrelated', 'kept');

    const result = await rotateSalts(env.CONFIG, at(0));
    expect(result.created).toEqual([day(1)]);
    expect(result.deleted.sort()).toEqual([day(-3), day(-2), 'not-a-day'].sort());

    expect(await env.CONFIG.get(`salt:${day(-1)}`, 'text')).toBe('yesterday');
    expect(await env.CONFIG.get(`salt:${day(0)}`, 'text')).toBe('today');
    expect(await env.CONFIG.get(`salt:${day(-2)}`, 'text')).toBeNull();
    expect(await env.CONFIG.get('unrelated', 'text')).toBe('kept');

    expect(await rotateSalts(env.CONFIG, at(0))).toEqual({ created: [], deleted: [] });
    await env.CONFIG.delete('unrelated');
  });

  it('rolls forward: each run drops the salt that was "yesterday" on the previous run', async () => {
    await rotateSalts(env.CONFIG, at(0));
    await rotateSalts(env.CONFIG, at(1));
    await rotateSalts(env.CONFIG, at(2));
    expect([...(await saltKeys()).keys()].sort()).toEqual([
      `salt:${day(1)}`,
      `salt:${day(2)}`,
      `salt:${day(3)}`,
    ]);
  });
});
