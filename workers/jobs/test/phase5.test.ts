// T5.T battery, jobs part (plan T5.T ~2405-2418: "jobs executados e idempotentes", "dump sem
// PII", "restauração de backup"):
//   1. Every scheduled job of the registry runs twice in a row with the same `scheduledTime`
//      without error, and the second run changes nothing (D1 content of every table, every R2
//      object's size and ETag, every KV CONFIG value). Specific checks on top: the backup manifest
//      is stable (and a fresh backup of the same data at the same time has the same bytes), the
//      public dump has the same bytes, cleanup / og-sweep / regate / rotate-salt find nothing left
//      on the second run.
//   2. The public dump carries no PII (e-mail, IPv4, IPv6, 64-hex, seeded user ids and e-mails).
//   3. The backup leaves out the access-log index and the rate-limit counters (tables and rows).
//   4. Restore round trip: the backup written by the job is turned into SQL by the operator tool
//      (tools/restore-backup.mjs, `buildRestoreSql`), applied to an EMPTY migrated D1 (RESTORE_DB,
//      test-only binding of vitest.config.ts) and the row counts match the manifest.
// The queue consumer (access-log) is idempotent per retried group: access-log-consumer.test.ts.
import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { buildRestoreSql, validateManifest } from '../../../tools/restore-backup.mjs';
import { gateVersion } from '../../../web/src/lib/server/social/gate.ts';
import { publishLineage, saveCurveGate } from '../../../web/src/lib/server/social/repo.ts';
import {
  BACKUP_STATE_KEY,
  backupJob,
  type BackupManifest,
  backupWeek,
  isBackedUpTable,
  sha256Hex,
  weekPrefix,
} from '../src/jobs/backup.ts';
import { utcDay } from '../src/jobs/dates.ts';
import { OG_SWEEP_CURSOR_KEY } from '../src/jobs/og-sweep.ts';
import {
  PUBLIC_DUMP_LATEST_KEY,
  PUBLIC_DUMP_PREFIX,
  type PublicDump,
} from '../src/jobs/public-dump.ts';
import { CRONS, registry, type CronExpression, type ScheduledJob } from '../src/jobs/registry.ts';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const IPV4 = '198.51.100.23';
const IPV6 = '2001:db8:5::23';
const UA = 'Mozilla/5.0 (phase5-jobs-agent)';

/** Patterns that must never appear in the public dump. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const IPV6_FULL_RE = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/i;
const IPV6_COMPRESSED_RE = /(?:[0-9a-f]{1,4})?::[0-9a-f]{1,4}/i;
const HEX64_RE = /\b[0-9a-f]{64}\b/i;

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function curveId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => BASE32[b % 32]).join('');
}

// ---- Fixtures ------------------------------------------------------------------------------------

interface SeededUser {
  id: string;
  email: string;
  nickname: string;
}

async function seedUser(): Promise<SeededUser> {
  const id = uid('p5user');
  const email = `${id}@example.com`;
  const nickname = `P5Nick${crypto.randomUUID().slice(0, 8)}`;
  const at = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", ' +
      '"username", "displayUsername", "usernameSkeleton", "role", "banned") ' +
      'VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0)',
  )
    .bind(id, 'Private Name', email, at, at, nickname.toLowerCase(), nickname, uid('skel'), 'user')
    .run();
  return { id, email, nickname };
}

interface Published {
  lineageId: string;
  versionId: string;
}

async function publish(
  owner: SeededUser,
  visibility: 'public' | 'private',
  license: 'CC0-1.0' | 'CC-BY-4.0',
  gateVer: string,
): Promise<Published> {
  const id = curveId();
  const lineageId = uid('p5lin');
  const versionId = uid('p5ver');
  const result = await publishLineage(env.DB, {
    lineageId,
    ownerUserId: owner.id,
    visibility,
    curve: {
      id,
      s1: `S1-${crypto.randomUUID()}`.padEnd(68, 'x'),
      canonKey: `v1;0;PK,1000,30,100;${id}`,
      // The current gate version: the re-gate job leaves these curves alone.
      gateVer,
      gateOk: true,
      gateReasons: [],
      levelDb: -3,
    },
    version: {
      id: versionId,
      name: 'Phase 5 fixture',
      description: 'Phase 5 fixture.',
      license,
      recipe: null,
      lang: 'pt-BR',
    },
    now: Date.now(),
  });
  if (!result.ok) throw new Error(`publish failed: ${result.code}`);
  return { lineageId, versionId };
}

interface Fixtures {
  author: SeededUser;
  zeroAuthor: SeededUser;
  fan: SeededUser;
  ccBy: Published;
  cc0: Published;
  privateOne: Published;
  sessionToken: string;
  staleCurveId: string;
  staleOgKey: string;
  accessLogKey: string;
  rateLimitKeys: { expired: string; live: string };
}

/** Data every job has something to do with (the first run acts, the second must not). */
async function seed(scheduled: number): Promise<Fixtures> {
  const version = await gateVersion();
  const author = await seedUser();
  const zeroAuthor = await seedUser();
  const fan = await seedUser();
  const ccBy = await publish(author, 'public', 'CC-BY-4.0', version);
  const cc0 = await publish(zeroAuthor, 'public', 'CC0-1.0', version);
  const privateOne = await publish(author, 'private', 'CC-BY-4.0', version);
  const now = Date.now();
  const past = new Date(scheduled - 86_400_000).toISOString();
  const future = new Date(scheduled + 86_400_000).toISOString();
  const sessionToken = uid('p5tok');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO favorites (user_id, lineage_id, created_at) VALUES (?, ?, ?)').bind(
      fan.id,
      ccBy.lineageId,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO activity (user_id, lineage_id, kind, first_at, last_at, count) VALUES (?, ?, 'installed', ?, ?, 1)",
    ).bind(fan.id, ccBy.lineageId, now, now),
    // An expired session (cleanup deletes it) and a live one, both with IPs and a User-Agent.
    env.DB.prepare(
      'INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", ' +
        '"userAgent", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(uid('p5ses'), past, uid('p5tok'), past, past, IPV4, UA, fan.id),
    env.DB.prepare(
      'INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", ' +
        '"userAgent", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(uid('p5ses'), future, sessionToken, past, past, IPV6, UA, author.id),
    // An expired verification token keyed by an e-mail (cleanup deletes it).
    env.DB.prepare(
      'INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(uid('p5ver'), fan.email, uid('p5val'), past, past, past),
  ]);

  // A curve cached under an old gate version (the re-gate job re-checks it once).
  const staleCurveId = curveId();
  const stale = await saveCurveGate(
    env.DB,
    {
      id: staleCurveId,
      s1: `S1-${crypto.randomUUID()}`.padEnd(68, 'x'),
      canonKey: `v1;0;PK,1000,30,100;${staleCurveId}`,
      gateVer: 'v0:phase5-stale',
      gateOk: true,
      gateReasons: [],
      levelDb: -3,
    },
    1,
  );
  if (!stale.ok) throw new Error(`stale curve seed failed: ${stale.code}`);

  // An OG image of a version that does not exist (og-sweep deletes it).
  const staleOgKey = `og/${curveId()}-${uid('p5ghost')}.png`;
  await env.MEDIA.put(staleOgKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    httpMetadata: { contentType: 'image/png' },
  });

  // Access-log index row (recent: retention keeps it) and rate-limit counters: never backed up.
  const accessLogKey = `access-log/phase5/${uid('p5al')}.ndjson.enc`;
  const rateLimitKeys = { expired: uid('p5rl-expired'), live: uid('p5rl-live') };
  const seconds = Math.floor(scheduled / 1000);
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO access_log_objects (object_key, day, hour, key_id) VALUES (?, ?, 1, ?)',
    ).bind(accessLogKey, utcDay(new Date(scheduled)), 'p5-key'),
    env.DB.prepare(
      'INSERT INTO rate_limit_counters (key, window_start, count, expires_at) VALUES (?, 0, 1, ?)',
    ).bind(rateLimitKeys.expired, seconds - 60),
    env.DB.prepare(
      'INSERT INTO rate_limit_counters (key, window_start, count, expires_at) VALUES (?, 0, 1, ?)',
    ).bind(rateLimitKeys.live, seconds + 86_400),
  ]);

  return {
    author,
    zeroAuthor,
    fan,
    ccBy,
    cc0,
    privateOne,
    sessionToken,
    staleCurveId,
    staleOgKey,
    accessLogKey,
    rateLimitKeys,
  };
}

// ---- State snapshots -----------------------------------------------------------------------------

type Snapshot = Map<string, string>;

/** Every application table (content hash), R2 object (size + ETag) and KV CONFIG value. */
async function snapshot(): Promise<Snapshot> {
  const state: Snapshot = new Map();
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' " +
      "AND substr(name, 1, 4) <> '_cf_' ORDER BY name",
  ).all<{ name: string }>();
  for (const { name } of tables.results) {
    const rows = await env.DB.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    const lines = rows.results.map((row) => JSON.stringify(row)).sort();
    const digest = await sha256Hex(new TextEncoder().encode(lines.join('\n')));
    state.set(`d1:${name}`, `${lines.length}:${digest}`);
  }
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ cursor });
    for (const object of page.objects)
      state.set(`r2:${object.key}`, `${object.size}:${object.etag}`);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  let kvCursor: string | undefined;
  do {
    const page = await env.CONFIG.list(kvCursor ? { cursor: kvCursor } : {});
    for (const key of page.keys)
      state.set(`kv:${key.name}`, (await env.CONFIG.get(key.name)) ?? '');
    kvCursor = page.list_complete ? undefined : page.cursor;
  } while (kvCursor);
  return state;
}

/** Keys whose value differs between two snapshots (added, removed or changed). */
function changes(before: Snapshot, after: Snapshot): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}

// ---- Running jobs --------------------------------------------------------------------------------

/** Every scheduled job once, with the first cron that registers it, in registration order. */
function registeredJobs(): { job: ScheduledJob; cron: CronExpression }[] {
  const seen = new Set<ScheduledJob>();
  const jobs: { job: ScheduledJob; cron: CronExpression }[] = [];
  for (const cron of [CRONS.daily, CRONS.hourly, CRONS.quarterHour, CRONS.weekly] as const) {
    for (const job of registry.scheduled[cron] ?? []) {
      if (seen.has(job)) continue;
      seen.add(job);
      jobs.push({ job, cron });
    }
  }
  return jobs;
}

/** Runs one job and returns its parsed JSON console lines. */
async function runJob(
  job: ScheduledJob,
  cron: CronExpression,
  scheduledTime: number,
): Promise<Record<string, unknown>[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await job.run(
      createScheduledController({ cron, scheduledTime }),
      env,
      createExecutionContext(),
    );
    return log.mock.calls.flatMap((call) => {
      try {
        const value: unknown = JSON.parse(String(call[0]));
        return typeof value === 'object' && value !== null
          ? [Object.fromEntries(Object.entries(value))]
          : [];
      } catch {
        // Only JSON lines are job summaries.
        return [];
      }
    });
  } finally {
    log.mockRestore();
  }
}

function summary(lines: Record<string, unknown>[], event: string): Record<string, unknown> {
  const line = lines.find((entry) => entry.event === event);
  if (!line) throw new Error(`no ${event} line`);
  return line;
}

async function bytesOf(key: string): Promise<Uint8Array> {
  const object = await env.MEDIA.get(key);
  if (object === null) throw new Error(`missing object ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}

async function gunzipText(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function manifestText(week: string): Promise<string> {
  return new TextDecoder().decode(await bytesOf(`${weekPrefix(week)}manifest.json`));
}

// ---- Tests ---------------------------------------------------------------------------------------

describe('phase 5: jobs run twice with the same scheduled time', () => {
  it('every registered job: no error, and the second run changes nothing', async () => {
    // Now (KV expirations must be in the future); fixed for both runs of every job.
    const scheduled = Date.now();
    const week = backupWeek(new Date(scheduled));
    await env.CONFIG.delete(BACKUP_STATE_KEY);
    await env.CONFIG.delete(OG_SWEEP_CURSOR_KEY);
    const fx = await seed(scheduled);

    const jobs = registeredJobs();
    expect(jobs.map(({ job }) => job.name)).toEqual([
      'rotate-salt',
      'rate-limit-gc',
      'access-log-retention',
      's6-aggregate',
      'og-sweep',
      'cleanup',
      'trades-expire',
      'backup',
      // #28: the re-gate is registered on the quarter-hour cron only.
      'regate',
      'rankings',
      'public-dump',
    ]);

    for (const { job, cron } of jobs) {
      const first = await runJob(job, cron, scheduled);
      const before = await snapshot();
      const second = await runJob(job, cron, scheduled);
      const after = await snapshot();
      expect(changes(before, after), `${job.name}: state changed by the second run`).toEqual([]);

      switch (job.name) {
        case 'rotate-salt':
          expect(summary(second, 'job.rotate_salt')).toMatchObject({ created: 0, deleted: 0 });
          break;
        case 'rate-limit-gc': {
          const keys = await env.DB.prepare(
            'SELECT key FROM rate_limit_counters WHERE key IN (?, ?) ORDER BY key',
          )
            .bind(fx.rateLimitKeys.expired, fx.rateLimitKeys.live)
            .all<{ key: string }>();
          expect(keys.results.map((row) => row.key)).toEqual([fx.rateLimitKeys.live]);
          break;
        }
        case 'og-sweep':
          expect(summary(first, 'job.og-sweep').deleted).toBeGreaterThanOrEqual(1);
          expect(summary(second, 'job.og-sweep').deleted).toBe(0);
          expect(await env.MEDIA.head(fx.staleOgKey)).toBeNull();
          break;
        case 'cleanup': {
          const firstRun = summary(first, 'job.cleanup');
          expect(firstRun.sessions).toBeGreaterThanOrEqual(1);
          expect(firstRun.verifications).toBeGreaterThanOrEqual(1);
          // Every step of the second run deleted nothing.
          const secondRun = summary(second, 'job.cleanup');
          for (const [step, count] of Object.entries(secondRun)) {
            if (step === 'event' || step === 'ms' || step === 'done') continue;
            expect(count, `cleanup step ${step} on the second run`).toBe(0);
          }
          expect(secondRun.done).toBe(true);
          break;
        }
        case 'regate':
          expect(summary(first, 'job.regate').changed).toBeGreaterThanOrEqual(1);
          expect(summary(second, 'job.regate').changed).toBe(0);
          break;
        case 'backup': {
          expect(summary(first, 'job.backup').status).toBe('complete');
          expect(summary(second, 'job.backup').status).toBe('skipped');
          // Stable manifest: and a FRESH backup of the same data at the same time is byte-equal.
          const manifest = await manifestText(week);
          await env.CONFIG.delete(BACKUP_STATE_KEY);
          const fresh = await runJob(job, cron, scheduled);
          expect(summary(fresh, 'job.backup').status).toBe('complete');
          expect(await manifestText(week)).toBe(manifest);
          break;
        }
        case 'public-dump': {
          const key = `${PUBLIC_DUMP_PREFIX}${new Date(scheduled).toISOString().slice(0, 10)}.json.gz`;
          const dated = await bytesOf(key);
          expect(await bytesOf(PUBLIC_DUMP_LATEST_KEY)).toEqual(dated);
          await runJob(job, cron, scheduled);
          // Same data, same scheduled time: the same bytes.
          expect(await sha256Hex(await bytesOf(key))).toBe(await sha256Hex(dated));
          break;
        }
        default:
          break;
      }
    }
  }, 180_000);
});

describe('phase 5: public dump without PII', () => {
  it('no e-mail, IP, 64-hex hash, account id or private content; CC-BY credit only', async () => {
    const scheduled = Date.now();
    const fx = await seed(scheduled);
    const dumpJob = registry.scheduled[CRONS.weekly]?.find((job) => job.name === 'public-dump');
    if (!dumpJob) throw new Error('public-dump is not registered');
    await runJob(dumpJob, CRONS.weekly, scheduled);
    const json = await gunzipText(await bytesOf(PUBLIC_DUMP_LATEST_KEY));
    const dump = JSON.parse(json) as PublicDump;

    // The scan is meaningful: the seeded public lineages are in the dump.
    const ids = dump.lineages.map((lineage) => lineage.id);
    expect(ids).toContain(fx.ccBy.lineageId);
    expect(ids).toContain(fx.cc0.lineageId);
    expect(ids).not.toContain(fx.privateOne.lineageId);
    const credited = dump.lineages.find((lineage) => lineage.id === fx.ccBy.lineageId);
    expect(credited?.versions[0]?.author).toBe(fx.author.nickname);
    expect(credited?.favorites).toBe(1);
    expect(credited?.installs).toBe(1);

    expect(json).not.toMatch(EMAIL_RE);
    expect(json).not.toMatch(IPV4_RE);
    expect(json).not.toMatch(IPV6_FULL_RE);
    expect(json).not.toMatch(IPV6_COMPRESSED_RE);
    expect(json).not.toMatch(HEX64_RE);
    for (const user of [fx.author, fx.zeroAuthor, fx.fan]) {
      expect(json).not.toContain(user.id);
      expect(json).not.toContain(user.email);
    }
    // CC0 authors and fans are never named; nothing private, no session data.
    expect(json).not.toContain(fx.zeroAuthor.nickname);
    expect(json).not.toContain(fx.fan.nickname);
    for (const leak of [
      'Private Name',
      fx.sessionToken,
      UA,
      IPV4,
      IPV6,
      fx.privateOne.lineageId,
      fx.privateOne.versionId,
      fx.staleCurveId,
    ]) {
      expect(json).not.toContain(leak);
    }
  }, 60_000);
});

describe('phase 5: backup exclusions and restore round trip', () => {
  it('the job backup leaves out access logs and rate-limit counters, and restores into an empty D1', async () => {
    const scheduled = Date.now();
    const week = backupWeek(new Date(scheduled));
    await env.CONFIG.delete(BACKUP_STATE_KEY);
    const fx = await seed(scheduled);
    const job = registry.scheduled[CRONS.hourly]?.find((entry) => entry.name === 'backup');
    if (!job) throw new Error('backup is not registered');
    expect(summary(await runJob(job, CRONS.hourly, scheduled), 'job.backup').status).toBe(
      'complete',
    );

    const raw: unknown = JSON.parse(await manifestText(week));
    const manifest = raw as BackupManifest;
    const names = manifest.tables.map((table) => table.name);
    expect(names).toEqual(expect.arrayContaining(['user', 'session', 'lineages', 'versions']));
    expect(names.filter((name) => !isBackedUpTable(name))).toEqual([]);
    expect(names).not.toContain('access_log_objects');
    expect(names).not.toContain('rate_limit_counters');

    // Read every file once (the tool's reader is synchronous) and scan the rows for the excluded
    // data: neither the access-log key nor a rate-limit key appears anywhere in the backup.
    const files = new Map<string, Uint8Array>();
    for (const table of manifest.tables) {
      for (const file of table.files) files.set(file.key, await bytesOf(file.key));
    }
    let content = '';
    for (const bytes of files.values()) content += await gunzipText(bytes);
    expect(content).toContain(fx.author.id);
    for (const excluded of [fx.accessLogKey, fx.rateLimitKeys.live, fx.rateLimitKeys.expired]) {
      expect(content).not.toContain(excluded);
    }

    // Restore with the operator tool into an empty database migrated to the same schema.
    const restore = buildRestoreSql(validateManifest(raw), (key: string) => {
      const bytes = files.get(key);
      if (!bytes) throw new Error(`file not in the backup: ${key}`);
      return bytes;
    });
    expect(restore.tables).toBe(manifest.tables.length);
    await applyD1Migrations(env.RESTORE_DB, env.TEST_MIGRATIONS);
    for (const table of manifest.tables) {
      expect(await countRows(env.RESTORE_DB, table.name), `${table.name} empty before`).toBe(0);
    }
    const statements = splitSql(restore.sql);
    expect(statements[0]).toBe('PRAGMA defer_foreign_keys = on');
    // One batch = one transaction: the deferred foreign keys are checked once, at commit.
    await env.RESTORE_DB.batch(statements.map((sql) => env.RESTORE_DB.prepare(sql)));

    let restored = 0;
    for (const table of manifest.tables) {
      expect(await countRows(env.RESTORE_DB, table.name), table.name).toBe(table.rows);
      restored += table.rows;
    }
    expect(restored).toBe(restore.rows);
    // Excluded tables exist (migrations) but stay empty; the triggers came back.
    expect(await countRows(env.RESTORE_DB, 'access_log_objects')).toBe(0);
    expect(await countRows(env.RESTORE_DB, 'rate_limit_counters')).toBe(0);
    // Every trigger of the manifest is back; the only others are the migrations' own triggers on
    // the excluded (access-log) tables, which the restore never touches.
    const triggers = await env.RESTORE_DB.prepare(
      "SELECT name, tbl_name AS tbl FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    ).all<{ name: string; tbl: string }>();
    const backedUp = triggers.results.filter((row) => isBackedUpTable(row.tbl));
    expect(backedUp.map((row) => row.name)).toEqual(
      manifest.triggers.map((trigger) => trigger.name).sort(),
    );
    const user = await env.RESTORE_DB.prepare('SELECT "email" FROM "user" WHERE "id" = ?')
      .bind(fx.author.id)
      .first<{ email: string }>();
    expect(user?.email).toBe(fx.author.email);
  }, 120_000);
});

async function countRows(db: D1Database, table: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

/**
 * Splits the restore SQL into statements for `D1Database.batch` (`exec` splits on newlines, which
 * breaks multi-line triggers and string values). Respects '...' and "..." (doubled quotes), `--`
 * and block comments, and BEGIN/CASE ... END blocks (the `;` inside trigger bodies).
 */
function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  let index = 0;
  const isWordChar = (char: string | undefined) => char !== undefined && /[A-Za-z0-9_]/.test(char);
  while (index < sql.length) {
    const char = sql[index] ?? '';
    const next = sql[index + 1];
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === char) {
          if (sql[end + 1] === char) end += 2;
          else break;
        } else end += 1;
      }
      current += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (/[A-Za-z_]/.test(char) && !isWordChar(sql[index - 1])) {
      let end = index;
      while (isWordChar(sql[end])) end += 1;
      const word = sql.slice(index, end).toUpperCase();
      if (word === 'BEGIN' || word === 'CASE') depth += 1;
      else if (word === 'END') depth = Math.max(0, depth - 1);
      current += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === ';' && depth === 0) {
      if (current.trim() !== '') statements.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.trim() !== '') statements.push(current.trim());
  return statements;
}
