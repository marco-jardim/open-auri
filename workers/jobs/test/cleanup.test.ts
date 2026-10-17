// T5.3 cleanup job: deletes only what is past the retentions of docs/lgpd.md (expired sessions,
// verification tokens, link uses and e-mail change requests; access-log index rows over 180 days;
// e-mail suppressions over 12 months; audit rows over 5 years, which migration 0011 allows while
// younger rows stay undeletable; S6 batches and pairs over 24 months; expired nickname holds; old
// retracted lineages without forks), bounded per run, counts-only logs. Every test seeds its own
// unique ids and asserts on them only.
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { publishLineage } from '../../../web/src/lib/server/social/repo.ts';
import { DAY_MS } from '../src/jobs/dates.ts';
import { CLEANUP_JOB, cleanupCutoffs, cleanupJob, runCleanup } from '../src/jobs/cleanup.ts';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const YEAR_MS = 365 * DAY_MS;

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function hex64(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
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

async function exists(sql: string, ...params: unknown[]): Promise<boolean> {
  return (
    (await env.DB.prepare(sql)
      .bind(...params)
      .first()) !== null
  );
}

async function seedSession(userId: string, expiresAt: string): Promise<string> {
  const id = uid('sess');
  const at = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, expiresAt, uid('tok'), at, at, userId)
    .run();
  return id;
}

async function seedVerification(expiresAt: string): Promise<string> {
  const id = uid('ver');
  const at = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, uid('ident'), 'value', expiresAt, at, at)
    .run();
  return id;
}

async function seedAudit(createdAt: number): Promise<string> {
  const id = uid('audit');
  await env.DB.prepare(
    "INSERT INTO audit_log (id, actor_id, actor_kind, action, created_at) VALUES (?, NULL, 'system', 'test.cleanup', ?)",
  )
    .bind(id, createdAt)
    .run();
  return id;
}

async function seedS6(day: string): Promise<string> {
  const id = uid('s6b');
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO s6_batches (id, receipt_hash, consent_ver, day) VALUES (?, ?, ?, ?)',
    ).bind(id, hex64(), 'v1', day),
    env.DB.prepare(
      "INSERT INTO s6_pairs (batch_id, a, b, choice, level_matched) VALUES (?, 'curve-a', 'curve-b', 'a', 1)",
    ).bind(id),
  ]);
  return id;
}

async function publish(): Promise<{ lineageId: string; versionId: string }> {
  const curveId = Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    (b) => BASE32[b % 32],
  ).join('');
  const lineageId = uid('lin');
  const versionId = uid('ver');
  const result = await publishLineage(env.DB, {
    lineageId,
    ownerUserId: await seedUser(),
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
      name: 'Cleanup fixture',
      description: 'Cleanup fixture.',
      license: 'CC0-1.0',
      recipe: null,
      lang: 'en-US',
    },
    now: Date.now(),
  });
  if (!result.ok) throw new Error(`publish failed: ${result.code}`);
  return { lineageId, versionId };
}

async function setStatus(lineageId: string, status: string, updatedAt: number): Promise<void> {
  await env.DB.prepare('UPDATE lineages SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, updatedAt, lineageId)
    .run();
}

const GENEROUS = { rowsPerRound: 500, maxRounds: 50, budgetMs: 60_000 };

describe('cleanup cutoffs', () => {
  it('derives the retention cutoffs from now', () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    const cutoffs = cleanupCutoffs(now);
    expect(cutoffs.accessLogDay).toBe('2026-04-19');
    expect(new Date(cutoffs.suppressionMs).toISOString()).toBe('2025-10-16T12:00:00.000Z');
    expect(new Date(cutoffs.auditMs).toISOString()).toBe('2021-10-15T12:00:00.000Z');
    expect(cutoffs.s6Day).toBe('2024-10-16');
    expect(cutoffs.tombstoneMs).toBe(now.getTime() - 365 * DAY_MS);
  });
});

describe('cleanup job', () => {
  it('deletes only what is past retention', async () => {
    const now = new Date();
    const nowMs = now.getTime();
    const userId = await seedUser();
    const past = new Date(nowMs - DAY_MS).toISOString();
    const future = new Date(nowMs + DAY_MS).toISOString();

    const oldSession = await seedSession(userId, past);
    const liveSession = await seedSession(userId, future);
    const oldVerification = await seedVerification(past);
    const liveVerification = await seedVerification(future);

    const oldLink = hex64();
    const liveLink = hex64();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO auth_link_uses (token_hash, used_at, expires_at) VALUES (?, ?, ?)',
      ).bind(oldLink, nowMs - 2 * DAY_MS, nowMs - DAY_MS),
      env.DB.prepare(
        'INSERT INTO auth_link_uses (token_hash, used_at, expires_at) VALUES (?, ?, ?)',
      ).bind(liveLink, nowMs, nowMs + DAY_MS),
    ]);

    const oldObject = uid('access-log/old');
    const liveObject = uid('access-log/live');
    const day = (offset: number): string =>
      new Date(nowMs + offset * DAY_MS).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO access_log_objects (object_key, day, hour, key_id) VALUES (?, ?, 1, 'k1')",
      ).bind(oldObject, day(-200)),
      env.DB.prepare(
        "INSERT INTO access_log_objects (object_key, day, hour, key_id) VALUES (?, ?, 1, 'k1')",
      ).bind(liveObject, day(-10)),
    ]);

    const oldSuppression = hex64();
    const liveSuppression = hex64();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO email_suppressions (address_hash, reason, created_at) VALUES (?, 'bounce', ?)",
      ).bind(oldSuppression, nowMs - 400 * DAY_MS),
      env.DB.prepare(
        "INSERT INTO email_suppressions (address_hash, reason, created_at) VALUES (?, 'bounce', ?)",
      ).bind(liveSuppression, nowMs - 300 * DAY_MS),
    ]);

    const oldAudit = await seedAudit(nowMs - 6 * YEAR_MS);
    const liveAudit = await seedAudit(nowMs - 4 * YEAR_MS);

    const oldBatch = await seedS6(day(-760));
    const liveBatch = await seedS6(day(-700));

    const oldHold = uid('skel');
    const liveHold = uid('skel');
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO username_holds (skeleton, username, user_id, released_at) VALUES (?, ?, NULL, ?)',
      ).bind(oldHold, 'old_nick', nowMs - DAY_MS),
      env.DB.prepare(
        'INSERT INTO username_holds (skeleton, username, user_id, released_at) VALUES (?, ?, NULL, ?)',
      ).bind(liveHold, 'live_nick', nowMs + DAY_MS),
    ]);

    const oldTombstone = await publish();
    await setStatus(oldTombstone.lineageId, 'retracted', nowMs - 400 * DAY_MS);
    const recentTombstone = await publish();
    await setStatus(recentTombstone.lineageId, 'retracted', nowMs - 100 * DAY_MS);
    const forkedTombstone = await publish();
    await setStatus(forkedTombstone.lineageId, 'retracted', nowMs - 400 * DAY_MS);
    const forkId = uid('lin');
    await env.DB.prepare(
      'INSERT INTO lineages (id, owner_user_id, forked_from_version, head_version, visibility, created_at, updated_at) ' +
        "VALUES (?, NULL, ?, NULL, 'private', ?, ?)",
    )
      .bind(forkId, forkedTombstone.versionId, nowMs, nowMs)
      .run();
    const oldActive = await publish();
    await setStatus(oldActive.lineageId, 'active', nowMs - 400 * DAY_MS);

    const result = await runCleanup(env.DB, now, { limits: GENEROUS });
    expect(result.done).toBe(true);

    const gone: [string, unknown][] = [
      ['SELECT 1 FROM "session" WHERE "id" = ?', oldSession],
      ['SELECT 1 FROM "verification" WHERE "id" = ?', oldVerification],
      ['SELECT 1 FROM auth_link_uses WHERE token_hash = ?', oldLink],
      ['SELECT 1 FROM access_log_objects WHERE object_key = ?', oldObject],
      ['SELECT 1 FROM email_suppressions WHERE address_hash = ?', oldSuppression],
      ['SELECT 1 FROM audit_log WHERE id = ?', oldAudit],
      ['SELECT 1 FROM s6_batches WHERE id = ?', oldBatch],
      ['SELECT 1 FROM s6_pairs WHERE batch_id = ?', oldBatch],
      ['SELECT 1 FROM username_holds WHERE skeleton = ?', oldHold],
      ['SELECT 1 FROM lineages WHERE id = ?', oldTombstone.lineageId],
      ['SELECT 1 FROM versions WHERE id = ?', oldTombstone.versionId],
    ];
    for (const [sql, param] of gone) expect(await exists(sql, param), sql).toBe(false);

    const kept: [string, unknown][] = [
      ['SELECT 1 FROM "session" WHERE "id" = ?', liveSession],
      ['SELECT 1 FROM "verification" WHERE "id" = ?', liveVerification],
      ['SELECT 1 FROM auth_link_uses WHERE token_hash = ?', liveLink],
      ['SELECT 1 FROM access_log_objects WHERE object_key = ?', liveObject],
      ['SELECT 1 FROM email_suppressions WHERE address_hash = ?', liveSuppression],
      ['SELECT 1 FROM audit_log WHERE id = ?', liveAudit],
      ['SELECT 1 FROM s6_batches WHERE id = ?', liveBatch],
      ['SELECT 1 FROM s6_pairs WHERE batch_id = ?', liveBatch],
      ['SELECT 1 FROM username_holds WHERE skeleton = ?', liveHold],
      ['SELECT 1 FROM lineages WHERE id = ?', recentTombstone.lineageId],
      ['SELECT 1 FROM lineages WHERE id = ?', forkedTombstone.lineageId],
      ['SELECT 1 FROM lineages WHERE id = ?', forkId],
      ['SELECT 1 FROM lineages WHERE id = ?', oldActive.lineageId],
    ];
    for (const [sql, param] of kept) expect(await exists(sql, param), sql).toBe(true);
  });

  it('keeps audit rows younger than 5 years undeletable (migration 0011)', async () => {
    const recent = await seedAudit(Date.now() - 4 * YEAR_MS);
    await expect(
      env.DB.prepare('DELETE FROM audit_log WHERE id = ?').bind(recent).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare('UPDATE audit_log SET action = ? WHERE id = ?').bind('x.y', recent).run(),
    ).rejects.toThrow(/append-only/);
    const old = await seedAudit(Date.now() - 6 * YEAR_MS);
    await env.DB.prepare('DELETE FROM audit_log WHERE id = ?').bind(old).run();
    expect(await exists('SELECT 1 FROM audit_log WHERE id = ?', old)).toBe(false);
  });

  it('is bounded per run and finishes on later runs', async () => {
    const nowMs = Date.now();
    const holds = [uid('skel'), uid('skel'), uid('skel')];
    for (const skeleton of holds) {
      await env.DB.prepare(
        'INSERT INTO username_holds (skeleton, username, user_id, released_at) VALUES (?, ?, NULL, ?)',
      )
        .bind(skeleton, 'bounded', nowMs - DAY_MS)
        .run();
    }
    const tight = { rowsPerRound: 1, maxRounds: 1, budgetMs: 60_000 };
    const first = await runCleanup(env.DB, new Date(), { limits: tight });
    expect(first.deleted['username-holds']).toBe(1);
    expect(first.done).toBe(false);
    for (let run = 0; run < 10; run += 1) {
      const next = await runCleanup(env.DB, new Date(), { limits: tight });
      if (next.done) break;
    }
    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM username_holds WHERE skeleton IN (?, ?, ?)`,
    )
      .bind(...holds)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('runs as the cleanup job and logs counts only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(cleanupJob.name).toBe(CLEANUP_JOB);
      await cleanupJob.run(
        createScheduledController({ scheduledTime: Date.now(), cron: '5 0 * * *' }),
        env,
        createExecutionContext(),
      );
      const line = log.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.includes('job.cleanup'));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line ?? '{}') as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (key === 'event') continue;
        expect(['number', 'boolean']).toContain(typeof value);
      }
    } finally {
      log.mockRestore();
    }
  });
});
