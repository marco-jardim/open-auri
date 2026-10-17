// Weekly D1 backup to R2 (T5.3, docs/lgpd.md operation 22, measure M7).
//
// Every application table of D1 is read in keyset pages (rowid, or the primary key of WITHOUT
// ROWID tables) and written as gzip NDJSON to the R2 bucket MEDIA under
// `backups/<YYYY>-W<ww>/<table>.ndjson.gz` (backup week of the run: the ISO week, UTC, but
// starting Monday 03:00 UTC instead of 00:00; see backupWeek). A table too large for one
// run continues in `<table>.2.ndjson.gz`, `<table>.3.ndjson.gz`, ... When every table is done,
// `backups/<week>/manifest.json` lists the tables (with their CREATE statement), row counts, files
// (rows, bytes, SHA-256 of the gzip bytes), the triggers and the schema version (name of the last
// applied migration in d1_migrations); see tools/restore-backup.mjs and docs/operacao/backups.md.
//
// NOT backed up: the access-log tables (`access_log_*`: the access records themselves live only in
// the R2 prefix `access-log/`, operation 25), the rate-limit counters, `d1_migrations` (its last
// name is the manifest's schema version), D1 internals (`_cf_*`) and SQLite internals.
//
// Bounded per run: at most `maxPages` D1 pages of `pageSize` rows and `budgetMs` of wall time,
// checked before each page; a file is cut at `chunkBytes` of NDJSON. The progress (week, tables,
// per-table keyset cursor, files written) is kept in KV `CONFIG` (`job:backup:state`), written once
// at the end of the run. A run that dies halfway redoes its pages next time and overwrites the same
// object keys. Idempotent per week: once the manifest is written, every later run of the same
// backup week is a single KV read. A new week starts a new backup (registered only on the hourly
// cron, so the first run of a week is Monday 03:00 UTC); an unfinished older week is left without a
// manifest (restore refuses it) and goes with the retention.
//
// Retention: after a manifest is written, every `backups/<week>/` older than 12 weeks is deleted.
// This is not a point-in-time snapshot (tables are read over minutes or hours); D1 Time Travel is
// the point-in-time tool (runbook in docs/operacao/backups.md).
//
// Logs carry counts and timings only: no table content, key or cursor.
import { DAY_MS } from './dates.ts';
import type { ScheduledJob } from './registry.ts';

export const BACKUP_JOB = 'backup';
export const BACKUP_PREFIX = 'backups/';
export const BACKUP_STATE_KEY = 'job:backup:state';
export const BACKUP_RETENTION_WEEKS = 12;
export const BACKUP_FORMAT = 'open-auri-d1-backup';

export interface BackupLimits {
  /** Rows per D1 page. */
  pageSize: number;
  /** D1 pages per run. */
  maxPages: number;
  /** Wall time per run, checked before each page. */
  budgetMs: number;
  /** NDJSON bytes (before gzip) after which the current file is closed. */
  chunkBytes: number;
}

export const BACKUP_LIMITS: Readonly<BackupLimits> = Object.freeze({
  pageSize: 500,
  maxPages: 400,
  budgetMs: 25_000,
  chunkBytes: 8 * 1024 * 1024,
});

const EXCLUDED_TABLES: readonly RegExp[] = [
  /^access_log/,
  /^rate_limit_counters$/,
  /^d1_migrations$/,
  /^_cf_/,
  /^sqlite_/,
];

/** True for the tables that go into the backup. */
export function isBackedUpTable(name: string): boolean {
  return !EXCLUDED_TABLES.some((pattern) => pattern.test(name));
}

/** ISO-8601 week of `date` (UTC), as `YYYY-Www`. */
export function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** A backup week starts this long after the ISO week (Monday 03:00 UTC, the documented start). */
export const BACKUP_WEEK_START_MS = 3 * 60 * 60 * 1000;

/**
 * Backup week of `now`: the ISO week of `now` minus 3 hours, so Monday 00:00-02:59 UTC still
 * belongs to the previous week (only resumes or skips it) and a new backup starts at 03:00.
 */
export function backupWeek(now: Date): string {
  return isoWeek(new Date(now.getTime() - BACKUP_WEEK_START_MS));
}

/** `backups/<week>/` of the week of `now`. */
export function weekPrefix(week: string): string {
  return `${BACKUP_PREFIX}${week}/`;
}

/** Object key of the `index`-th (0-based) file of `table`. */
export function backupFileKey(week: string, table: string, index: number): string {
  return `${weekPrefix(week)}${table}${index === 0 ? '' : `.${index + 1}`}.ndjson.gz`;
}

/** Weeks strictly older than this one are deleted (the current week plus 12 earlier ones stay). */
export function retentionCutoffWeek(now: Date): string {
  return backupWeek(new Date(now.getTime() - BACKUP_RETENTION_WEEKS * 7 * DAY_MS));
}

type KeyValue = string | number | null;

export interface BackupFile {
  key: string;
  rows: number;
  bytes: number;
  sha256: string;
}

interface TableState {
  name: string;
  sql: string;
  /** Primary-key columns of a WITHOUT ROWID table; null = keyset on rowid. */
  keyColumns: string[] | null;
  rows: number;
  files: BackupFile[];
  cursor: KeyValue[] | null;
  done: boolean;
}

export interface BackupTrigger {
  name: string;
  table: string;
  sql: string;
}

interface BackupState {
  week: string;
  startedAt: string;
  schemaVersion: string | null;
  tables: TableState[];
  triggers: BackupTrigger[];
  done: boolean;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: 1;
  week: string;
  startedAt: string;
  completedAt: string;
  schemaVersion: string | null;
  excluded: string[];
  tables: { name: string; sql: string; rows: number; files: BackupFile[] }[];
  triggers: BackupTrigger[];
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const ROWID_ALIAS = '__oa_rowid';

async function planBackup(db: D1Database, week: string, now: Date): Promise<BackupState> {
  const objects = await db
    .prepare(
      "SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE type IN ('table', 'trigger') " +
        'AND sql IS NOT NULL ORDER BY rowid',
    )
    .all<{ type: string; name: string; tbl: string; sql: string }>();
  const tables: TableState[] = [];
  const triggers: BackupTrigger[] = [];
  for (const object of objects.results) {
    if (!isBackedUpTable(object.tbl)) continue;
    if (object.type === 'trigger') {
      triggers.push({ name: object.name, table: object.tbl, sql: object.sql });
      continue;
    }
    let keyColumns: string[] | null = null;
    if (/\bWITHOUT\s+ROWID\b/i.test(object.sql)) {
      const info = await db
        .prepare(`PRAGMA table_info(${quoteIdent(object.name)})`)
        .all<{ name: string; pk: number }>();
      keyColumns = info.results
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
    }
    tables.push({
      name: object.name,
      sql: object.sql,
      keyColumns,
      rows: 0,
      files: [],
      cursor: null,
      done: false,
    });
  }
  let schemaVersion: string | null = null;
  if (
    objects.results.some((object) => object.type === 'table' && object.name === 'd1_migrations')
  ) {
    const last = await db
      .prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')
      .first<{ name: string }>();
    schemaVersion = last?.name ?? null;
  }
  return { week, startedAt: now.toISOString(), schemaVersion, tables, triggers, done: false };
}

/** One keyset page of `table` after its cursor. */
async function readPage(
  db: D1Database,
  table: TableState,
  pageSize: number,
): Promise<{ rows: Record<string, unknown>[]; cursor: KeyValue[] | null }> {
  const name = quoteIdent(table.name);
  let statement: D1PreparedStatement;
  if (table.keyColumns === null) {
    const where = table.cursor === null ? '' : 'WHERE rowid > ? ';
    statement = db.prepare(
      `SELECT rowid AS ${ROWID_ALIAS}, * FROM ${name} ${where}ORDER BY rowid LIMIT ?`,
    );
    statement =
      table.cursor === null ? statement.bind(pageSize) : statement.bind(...table.cursor, pageSize);
  } else {
    const columns = table.keyColumns.map(quoteIdent).join(', ');
    const marks = table.keyColumns.map(() => '?').join(', ');
    const where = table.cursor === null ? '' : `WHERE (${columns}) > (${marks}) `;
    statement = db.prepare(`SELECT * FROM ${name} ${where}ORDER BY ${columns} LIMIT ?`);
    statement =
      table.cursor === null ? statement.bind(pageSize) : statement.bind(...table.cursor, pageSize);
  }
  const { results } = await statement.all<Record<string, unknown>>();
  const last = results[results.length - 1];
  let cursor = table.cursor;
  if (last !== undefined) {
    cursor =
      table.keyColumns === null
        ? [last[ROWID_ALIAS] as KeyValue]
        : table.keyColumns.map((column) => last[column] as KeyValue);
  }
  if (table.keyColumns === null) {
    for (const row of results) delete row[ROWID_ALIAS];
  }
  return { rows: results, cursor };
}

export async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface BackupDeps {
  db: D1Database;
  bucket: Pick<R2Bucket, 'put' | 'list' | 'delete'>;
  state: Pick<KVNamespace, 'get' | 'put'>;
  now: Date;
  limits?: Readonly<BackupLimits>;
  /** Milliseconds clock for the time budget (default `Date.now`). */
  clock?: () => number;
}

export interface BackupResult {
  week: string;
  /** `complete`: the manifest was written by this run; `resumed`: more runs are needed; `skipped`:
   * this week's backup was already complete. */
  status: 'complete' | 'resumed' | 'skipped';
  pages: number;
  rows: number;
  files: number;
  /** Objects deleted by the retention. */
  pruned: number;
}

function parseState(raw: string | null): BackupState | null {
  if (raw === null || raw === '') return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && 'week' in value && 'tables' in value) {
      return value as BackupState;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return null;
}

/** Deletes every `backups/<week>/` older than the retention (bounded to a few list pages). */
export async function pruneBackups(
  bucket: Pick<R2Bucket, 'list' | 'delete'>,
  now: Date,
  maxPages = 20,
): Promise<number> {
  const cutoff = retentionCutoffWeek(now);
  const old: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, delimiter: '/', cursor });
    for (const prefix of page.delimitedPrefixes) {
      const week = prefix.slice(BACKUP_PREFIX.length, -1);
      if (/^\d{4}-W\d{2}$/.test(week) && week < cutoff) old.push(prefix);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  let deleted = 0;
  let pages = 0;
  for (const prefix of old) {
    let more: string | undefined;
    do {
      if (pages >= maxPages) return deleted;
      pages += 1;
      const page = await bucket.list({ prefix, cursor: more });
      const keys = page.objects.map((object) => object.key);
      if (keys.length > 0) {
        await bucket.delete(keys);
        deleted += keys.length;
      }
      more = page.truncated ? page.cursor : undefined;
    } while (more);
  }
  return deleted;
}

/** One bounded pass of the weekly backup (see the file header). */
export async function runBackup(deps: BackupDeps): Promise<BackupResult> {
  const limits = deps.limits ?? BACKUP_LIMITS;
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const week = backupWeek(deps.now);
  const result: BackupResult = { week, status: 'resumed', pages: 0, rows: 0, files: 0, pruned: 0 };

  const stored = parseState(await deps.state.get(BACKUP_STATE_KEY));
  if (stored !== null && stored.week === week && stored.done) {
    result.status = 'skipped';
    return result;
  }
  const state =
    stored !== null && stored.week === week ? stored : await planBackup(deps.db, week, deps.now);

  const withinBudget = (): boolean =>
    result.pages < limits.maxPages && clock() - started < limits.budgetMs;

  for (const table of state.tables) {
    while (!table.done && withinBudget()) {
      const lines: string[] = [];
      let bytes = 0;
      let rows = 0;
      let cursor = table.cursor;
      let finished = false;
      while (withinBudget() && bytes < limits.chunkBytes) {
        const page = await readPage(deps.db, { ...table, cursor }, limits.pageSize);
        result.pages += 1;
        for (const row of page.rows) {
          const line = `${JSON.stringify(row)}\n`;
          lines.push(line);
          bytes += line.length;
        }
        rows += page.rows.length;
        cursor = page.cursor;
        if (page.rows.length < limits.pageSize) {
          finished = true;
          break;
        }
      }
      if (rows > 0) {
        const key = backupFileKey(week, table.name, table.files.length);
        const body = await gzipText(lines.join(''));
        // Stored as an opaque gzip file, without Content-Encoding: an HTTP client (Wrangler's
        // `r2 object get`) would otherwise decompress it on download, and the size and SHA-256 in
        // the manifest (checked by tools/restore-backup.mjs) are those of the gzip bytes.
        await deps.bucket.put(key, body, { httpMetadata: { contentType: 'application/gzip' } });
        table.files.push({ key, rows, bytes: body.byteLength, sha256: await sha256Hex(body) });
        table.rows += rows;
        result.rows += rows;
        result.files += 1;
      }
      table.cursor = cursor;
      if (finished) table.done = true;
    }
    if (!table.done) break;
  }

  if (state.tables.every((table) => table.done)) {
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: 1,
      week,
      startedAt: state.startedAt,
      completedAt: deps.now.toISOString(),
      schemaVersion: state.schemaVersion,
      excluded: ['access_log_*', 'rate_limit_counters', 'd1_migrations', '_cf_*', 'sqlite_*'],
      tables: state.tables.map((table) => ({
        name: table.name,
        sql: table.sql,
        rows: table.rows,
        files: table.files,
      })),
      triggers: state.triggers,
    };
    await deps.bucket.put(`${weekPrefix(week)}manifest.json`, JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });
    state.done = true;
    result.status = 'complete';
    result.pruned = await pruneBackups(deps.bucket, deps.now);
  }

  await deps.state.put(BACKUP_STATE_KEY, JSON.stringify(state));
  return result;
}

/** The `backup` scheduled job (options injectable for tests). Not registered here. */
export function createBackupJob(options: Pick<BackupDeps, 'limits' | 'clock'> = {}): ScheduledJob {
  return {
    name: BACKUP_JOB,
    async run(controller, env) {
      const started = Date.now();
      const result = await runBackup({
        db: env.DB,
        bucket: env.MEDIA,
        state: env.CONFIG,
        now: new Date(controller.scheduledTime),
        ...options,
      });
      console.log(
        JSON.stringify({
          event: 'job.backup',
          status: result.status,
          pages: result.pages,
          rows: result.rows,
          files: result.files,
          pruned: result.pruned,
          ms: Date.now() - started,
        }),
      );
    },
  };
}

export const backupJob: ScheduledJob = createBackupJob();
