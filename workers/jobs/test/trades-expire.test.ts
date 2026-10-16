// T4.10 trades-expire job: expires overdue S7 trades (waiting and matched) and retries pairing of
// the waiting ones; logs counts only. Runs on the jobs Worker's D1 (web migrations), with the
// web's repository used for fixtures (same relative import path the job uses).
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { createTrade, publishLineage } from '../../../web/src/lib/server/social/repo.ts';
import { TRADE_TTL_MS } from '../../../web/src/lib/server/social/types.ts';
import {
  expireAndPairTrades,
  TRADES_EXPIRE_JOB,
  tradesExpireJob,
} from '../src/jobs/trades-expire.ts';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function seedUser(): Promise<string> {
  const id = uid('user');
  const at = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", ' +
      '"username", "displayUsername", "usernameSkeleton", "role", "banned") ' +
      'VALUES (?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?, 0)',
  )
    .bind(id, 'Private Name', `${id}@example.com`, at, at, 'user')
    .run();
  return id;
}

interface Player {
  userId: string;
  lineageId: string;
  versionId: string;
}

async function player(): Promise<Player> {
  const userId = await seedUser();
  const lineageId = uid('lin');
  const versionId = uid('ver');
  const curveId = Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    (byte) => BASE32[byte % 32],
  ).join('');
  const result = await publishLineage(env.DB, {
    lineageId,
    ownerUserId: userId,
    visibility: 'public',
    curve: {
      id: curveId,
      s1: `S1-${crypto.randomUUID()}`.padEnd(68, 'x'),
      canonKey: `v1;0;PK,1000,30,100;${curveId}`,
      gateVer: 'v2:test',
      gateOk: true,
      gateReasons: [],
      levelDb: -3,
    },
    version: {
      id: versionId,
      name: 'Job fixture',
      description: 'Trade fixture.',
      license: 'CC-BY-4.0',
      recipe: null,
      lang: 'en-US',
    },
    now: Date.now(),
  });
  if (!result.ok) throw new Error(`publish failed: ${result.code}`);
  return { userId, lineageId, versionId };
}

async function trade(who: Player, now: number): Promise<string> {
  const id = uid('trade');
  const created = await createTrade(env.DB, { id, ...who, now });
  if (!created.ok) throw new Error(`create failed: ${created.code}`);
  return id;
}

async function stateOf(id: string): Promise<{ status: string; match_id: string | null } | null> {
  return env.DB.prepare('SELECT status, match_id FROM trades WHERE id = ?')
    .bind(id)
    .first<{ status: string; match_id: string | null }>();
}

describe('trades-expire job', () => {
  it('is named trades-expire', () => {
    expect(tradesExpireJob.name).toBe('trades-expire');
    expect(TRADES_EXPIRE_JOB).toBe('trades-expire');
  });

  it('expires trades at 72 h and pairs waiting trades that missed each other', async () => {
    const start = Date.now();
    const [old, a, b] = [await player(), await player(), await player()];
    const overdue = await trade(old, start - TRADE_TTL_MS);
    // Two waiting trades created without pairing (as if every candidate was taken at join time).
    const ta = await trade(a, start - 1000);
    const tb = await trade(b, start - 500);

    const result = await expireAndPairTrades(env.DB, start);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(result.paired).toBeGreaterThanOrEqual(1);
    expect((await stateOf(overdue))?.status).toBe('expired');
    expect(await stateOf(ta)).toEqual({ status: 'matched', match_id: tb });
    expect(await stateOf(tb)).toEqual({ status: 'matched', match_id: ta });

    // Idempotent: nothing left to expire or pair among these.
    await expireAndPairTrades(env.DB, start);
    expect((await stateOf(ta))?.status).toBe('matched');

    // The matched pair expires 72 h after pairing.
    await expireAndPairTrades(env.DB, start + TRADE_TTL_MS);
    expect((await stateOf(ta))?.status).toBe('expired');
    expect((await stateOf(tb))?.status).toBe('expired');
  });

  it('never pairs a trade with the same lineage', async () => {
    const start = Date.now() + 100 * TRADE_TTL_MS;
    const a = await player();
    const fan = await seedUser();
    const ta = await trade(a, start);
    const tf = await trade({ ...a, userId: fan }, start + 1);
    const result = await expireAndPairTrades(env.DB, start + 2);
    expect(result.paired).toBe(0);
    expect((await stateOf(ta))?.status).toBe('waiting');
    expect((await stateOf(tf))?.status).toBe('waiting');
  });

  it('logs counts only (no ids)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const now = Date.now() + 500 * TRADE_TTL_MS;
    const controller: ScheduledController = {
      scheduledTime: now,
      cron: '0 * * * *',
      noRetry: () => undefined,
    };
    const run = tradesExpireJob.run.bind(tradesExpireJob);
    await run(controller, env, {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext);
    const lines = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();
    const line = lines.find((text) => text.includes('job.trades_expire'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['event', 'expired', 'paired']);
  });
});
