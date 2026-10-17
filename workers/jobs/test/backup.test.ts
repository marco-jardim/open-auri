// T5.3 backup job: gzip NDJSON per application table in R2 `backups/<YYYY>-W<ww>/`, a manifest
// (tables, row counts, schema version, SHA-256 per file), access-log tables, rate-limit counters
// and d1_migrations excluded, bounded runs resumed through the KV cursor, idempotent per week and
// 12-week retention. Runs on the jobs Worker's local D1 (web migrations), R2 and KV.
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_JOB,
  BACKUP_STATE_KEY,
  backupFileKey,
  backupJob,
  type BackupManifest,
  isBackedUpTable,
  isoWeek,
  runBackup,
  sha256Hex,
  weekPrefix,
} from '../src/jobs/backup.ts';
import { DAY_MS } from '../src/jobs/dates.ts';

const WEEK_MS = 7 * DAY_MS;
const GENEROUS = { pageSize: 500, maxPages: 10_000, budgetMs: 60_000, chunkBytes: 8 * 1024 * 1024 };

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

async function readBytes(key: string): Promise<Uint8Array> {
  const object = await env.MEDIA.get(key);
  if (object === null) throw new Error(`missing object ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function manifestOf(week: string): Promise<BackupManifest> {
  const object = await env.MEDIA.get(`${weekPrefix(week)}manifest.json`);
  if (object === null) throw new Error('missing manifest');
  return JSON.parse(await object.text()) as BackupManifest;
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

beforeEach(async () => {
  await env.CONFIG.delete(BACKUP_STATE_KEY);
});

describe('backup helpers', () => {
  it('computes ISO weeks and file keys', () => {
    expect(isoWeek(new Date('2026-10-16T12:00:00Z'))).toBe('2026-W42');
    expect(isoWeek(new Date('2021-01-03T00:00:00Z'))).toBe('2020-W53');
    expect(isoWeek(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01');
    expect(backupFileKey('2026-W42', 'user', 0)).toBe('backups/2026-W42/user.ndjson.gz');
    expect(backupFileKey('2026-W42', 'user', 2)).toBe('backups/2026-W42/user.3.ndjson.gz');
  });

  it('excludes access logs, rate-limit counters, migrations and internals', () => {
    for (const name of [
      'access_log_objects',
      'access_log_requests',
      'rate_limit_counters',
      'd1_migrations',
      '_cf_KV',
      'sqlite_sequence',
    ]) {
      expect(isBackedUpTable(name), name).toBe(false);
    }
    for (const name of ['user', 'session', 'lineages', 'versions', 'audit_log', 's6_pairs']) {
      expect(isBackedUpTable(name), name).toBe(true);
    }
  });
});

describe('backup job', () => {
  it('writes every application table and a manifest, never the access logs or counters', async () => {
    const now = new Date('2031-03-05T03:00:00Z');
    const week = isoWeek(now);
    const userId = await seedUser();
    await env.DB.prepare(
      "INSERT INTO access_log_objects (object_key, day, hour, key_id) VALUES (?, '2031-03-01', 1, 'k1')",
    )
      .bind(uid('access-log/x'))
      .run();
    await env.DB.prepare(
      'INSERT INTO rate_limit_counters (key, window_start, count, expires_at) VALUES (?, 0, 1, ?)',
    )
      .bind(uid('rl'), now.getTime() + DAY_MS)
      .run();

    const result = await runBackup({
      db: env.DB,
      bucket: env.MEDIA,
      state: env.CONFIG,
      now,
      limits: GENEROUS,
    });
    expect(result.status).toBe('complete');

    const manifest = await manifestOf(week);
    expect(manifest.format).toBe('open-auri-d1-backup');
    expect(manifest.week).toBe(week);
    expect(manifest.schemaVersion).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    const names = manifest.tables.map((table) => table.name);
    expect(names).toEqual(expect.arrayContaining(['user', 'session', 'lineages', 'audit_log']));
    for (const name of names) expect(isBackedUpTable(name), name).toBe(true);
    expect(names.some((name) => name.startsWith('access_log'))).toBe(false);
    expect(names).not.toContain('rate_limit_counters');
    expect(names).not.toContain('d1_migrations');
    expect(manifest.triggers.map((trigger) => trigger.name)).toContain('audit_log_no_delete');
    expect(manifest.triggers.some((trigger) => !isBackedUpTable(trigger.table))).toBe(false);

    const keys = await listKeys(weekPrefix(week));
    expect(keys.some((key) => key.includes('access_log'))).toBe(false);
    expect(keys.some((key) => key.includes('rate_limit'))).toBe(false);

    // Internal consistency only: other test files may share the database, so no global counts.
    for (const table of manifest.tables) {
      expect(
        table.files.reduce((sum, file) => sum + file.rows, 0),
        table.name,
      ).toBe(table.rows);
      for (const file of table.files) {
        const bytes = await readBytes(file.key);
        expect(file.bytes).toBe(bytes.byteLength);
        expect(file.sha256).toBe(await sha256Hex(bytes));
        expect((await gunzip(bytes)).trim().split('\n')).toHaveLength(file.rows);
        // No Content-Encoding: a download must yield the exact gzip bytes the manifest hashes.
        const head = await env.MEDIA.head(file.key);
        expect(head?.httpMetadata?.contentEncoding).toBeUndefined();
      }
    }

    const users = manifest.tables.find((table) => table.name === 'user');
    const text = await gunzip(await readBytes(users?.files[0]?.key ?? ''));
    const rows = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.some((row) => row.id === userId)).toBe(true);
    expect(rows.every((row) => !('__oa_rowid' in row))).toBe(true);

    // Idempotent per week: the next run of the same week does nothing.
    const again = await runBackup({
      db: env.DB,
      bucket: env.MEDIA,
      state: env.CONFIG,
      now: new Date(now.getTime() + DAY_MS),
      limits: GENEROUS,
    });
    expect(again.status).toBe('skipped');
    expect(again.pages).toBe(0);
  });

  it('is bounded per run and resumes through the KV cursor', async () => {
    const now = new Date('2031-06-11T03:00:00Z');
    const week = isoWeek(now);
    // 13+ users = 5+ pages of 3 > 4 pages per run: the user table must span several files.
    const seeded: string[] = [];
    for (let index = 0; index < 13; index += 1) seeded.push(await seedUser());
    const tight = { pageSize: 3, maxPages: 4, budgetMs: 60_000, chunkBytes: 8 * 1024 * 1024 };

    const first = await runBackup({
      db: env.DB,
      bucket: env.MEDIA,
      state: env.CONFIG,
      now,
      limits: tight,
    });
    expect(first.status).toBe('resumed');
    expect(first.pages).toBeLessThanOrEqual(4);
    expect(await env.CONFIG.get(BACKUP_STATE_KEY)).not.toBeNull();
    expect(await env.MEDIA.head(`${weekPrefix(week)}manifest.json`)).toBeNull();

    let status = first.status;
    for (let run = 0; run < 500 && status !== 'complete'; run += 1) {
      status = (
        await runBackup({ db: env.DB, bucket: env.MEDIA, state: env.CONFIG, now, limits: tight })
      ).status;
    }
    expect(status).toBe('complete');

    const manifest = await manifestOf(week);
    const users = manifest.tables.find((table) => table.name === 'user');
    expect(users?.files.length ?? 0).toBeGreaterThan(1);
    const ids: unknown[] = [];
    for (const file of users?.files ?? []) {
      for (const line of (await gunzip(await readBytes(file.key))).trim().split('\n')) {
        ids.push((JSON.parse(line) as Record<string, unknown>).id);
      }
    }
    // Every row exactly once across the files, and every seeded user is there.
    expect(ids).toHaveLength(users?.rows ?? -1);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of seeded) expect(ids).toContain(id);
  });

  it('deletes backup weeks older than 12 weeks after a complete backup', async () => {
    const now = new Date('2031-09-10T03:00:00Z');
    const oldWeek = isoWeek(new Date(now.getTime() - 13 * WEEK_MS));
    const keptWeek = isoWeek(new Date(now.getTime() - 11 * WEEK_MS));
    await env.MEDIA.put(`${weekPrefix(oldWeek)}manifest.json`, '{}');
    await env.MEDIA.put(`${weekPrefix(oldWeek)}user.ndjson.gz`, 'x');
    await env.MEDIA.put(`${weekPrefix(keptWeek)}manifest.json`, '{}');

    const result = await runBackup({
      db: env.DB,
      bucket: env.MEDIA,
      state: env.CONFIG,
      now,
      limits: GENEROUS,
    });
    expect(result.status).toBe('complete');
    expect(result.pruned).toBeGreaterThanOrEqual(2);
    expect(await listKeys(weekPrefix(oldWeek))).toEqual([]);
    expect(await env.MEDIA.head(`${weekPrefix(keptWeek)}manifest.json`)).not.toBeNull();
    expect(await env.MEDIA.head(`${weekPrefix(isoWeek(now))}manifest.json`)).not.toBeNull();
  });

  it('runs as the backup job and logs counts only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(backupJob.name).toBe(BACKUP_JOB);
      await backupJob.run(
        createScheduledController({
          scheduledTime: Date.parse('2031-12-03T03:00:00Z'),
          cron: '0 3 * * 1',
        }),
        env,
        createExecutionContext(),
      );
      const line = log.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.includes('job.backup'));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line ?? '{}') as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(
        ['event', 'files', 'ms', 'pages', 'pruned', 'rows', 'status'].sort(),
      );
    } finally {
      log.mockRestore();
    }
  });
});
