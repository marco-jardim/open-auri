// Operator-only: turns a weekly D1 backup (workers/jobs/src/jobs/backup.ts) into one SQL file for
// `wrangler d1 execute --file` (runbook: docs/operacao/backups.md). Offline: it never calls the
// network nor Wrangler. The operator downloads `backups/<week>/` first (the runbook prints the
// `wrangler r2 object get` commands with --print-downloads).
//
//   node tools/restore-backup.mjs <dir> [--out <file>] [--print-downloads <bucket>]
//
// <dir> holds manifest.json and the .ndjson.gz files with the names of the manifest keys (only the
// part after `backups/<week>/`). Every file is checked against the manifest (size and SHA-256)
// before anything is written; a mismatch aborts. The SQL, in order:
//   1. PRAGMA defer_foreign_keys = on (rows are inserted table by table; lineages point to versions
//      inserted after them);
//   2. DROP TRIGGER IF EXISTS for every trigger of the manifest (append-only and head-advance
//      triggers would refuse restoring historical rows);
//   3. INSERT of every row, table by table in manifest order;
//   4. the manifest's CREATE TRIGGER statements, restoring the protections.
// The target must be a database migrated up to the manifest's schema version and EMPTY (a new D1
// database, never production in place). Output: counts only; no row content is printed.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { isEntryPoint } from './render-wrangler.mjs';

export const USAGE =
  'Usage: node tools/restore-backup.mjs <dir> [--out <file>] [--print-downloads <bucket>]';
export const BACKUP_FORMAT = 'open-auri-d1-backup';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WEEK = /^\d{4}-W\d{2}$/;

export class RestoreError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RestoreError';
  }
}

/**
 * @param {string[]} args
 * @returns {{ dir: string, out: string | null, bucket: string | null }}
 */
export function parseArgs(args) {
  /** @type {{ dir: string, out: string | null, bucket: string | null }} */
  const parsed = { dir: '', out: null, bucket: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--out' || arg === '--print-downloads') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new RestoreError(USAGE);
      if (arg === '--out') parsed.out = value;
      else parsed.bucket = value;
      index += 1;
    } else if (arg !== undefined && !arg.startsWith('--') && parsed.dir === '') {
      parsed.dir = arg;
    } else {
      throw new RestoreError(USAGE);
    }
  }
  if (parsed.dir === '') throw new RestoreError(USAGE);
  return parsed;
}

/**
 * Checks the manifest shape and returns it typed. Throws RestoreError when it is not a complete
 * backup manifest of the known format.
 * @param {unknown} value
 */
export function validateManifest(value) {
  if (typeof value !== 'object' || value === null) throw new RestoreError('Invalid manifest');
  const manifest = /** @type {Record<string, unknown>} */ (value);
  if (manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== 1) {
    throw new RestoreError('Unknown backup format');
  }
  if (typeof manifest.week !== 'string' || !WEEK.test(manifest.week)) {
    throw new RestoreError('Invalid manifest week');
  }
  if (!Array.isArray(manifest.tables) || !Array.isArray(manifest.triggers)) {
    throw new RestoreError('Invalid manifest tables');
  }
  for (const table of manifest.tables) {
    if (typeof table?.name !== 'string' || !IDENT.test(table.name)) {
      throw new RestoreError('Invalid table name in manifest');
    }
    if (!Array.isArray(table.files) || typeof table.rows !== 'number') {
      throw new RestoreError('Invalid table entry in manifest');
    }
    for (const file of table.files) {
      if (
        typeof file?.key !== 'string' ||
        !file.key.startsWith(`backups/${manifest.week}/`) ||
        file.key.includes('..') ||
        typeof file.sha256 !== 'string' ||
        typeof file.bytes !== 'number' ||
        typeof file.rows !== 'number'
      ) {
        throw new RestoreError('Invalid file entry in manifest');
      }
    }
  }
  for (const trigger of manifest.triggers) {
    if (
      typeof trigger?.name !== 'string' ||
      !IDENT.test(trigger.name) ||
      typeof trigger.sql !== 'string' ||
      !/^CREATE\s+TRIGGER\b/i.test(trigger.sql)
    ) {
      throw new RestoreError('Invalid trigger entry in manifest');
    }
  }
  // Typed through a const: a multi-line comment right after `return` counts as a line break, and
  // automatic semicolon insertion would turn it into `return;`.
  /** @type {BackupManifest} */
  const typed = /** @type {BackupManifest} */ (/** @type {unknown} */ (manifest));
  return typed;
}

/**
 * @typedef {{ key: string, rows: number, bytes: number, sha256: string }} BackupFile
 * @typedef {{ name: string, rows: number, files: BackupFile[] }} BackupTable
 * @typedef {{ name: string, table: string, sql: string }} BackupTrigger
 * @typedef {{ week: string, schemaVersion: string | null, tables: BackupTable[],
 *   triggers: BackupTrigger[] }} BackupManifest
 */

/** @param {string} key */
export function localName(key) {
  return key.slice(key.lastIndexOf('/') + 1);
}

/**
 * `wrangler r2 object get` commands that download a backup week into <dir> (printed, not run).
 * @param {ReturnType<typeof validateManifest>} manifest
 * @param {string} bucket
 * @param {string} dir
 */
export function downloadCommands(manifest, bucket, dir) {
  const keys = manifest.tables.flatMap((table) => table.files.map((file) => file.key));
  return keys.map(
    (key) =>
      `npx wrangler r2 object get "${bucket}/${key}" --file "${join(dir, localName(key))}" --remote`,
  );
}

/** @param {string} name */
export function quoteIdent(name) {
  if (!IDENT.test(name)) throw new RestoreError('Invalid identifier');
  return `"${name}"`;
}

/**
 * SQL literal of a JSON value read from the backup.
 * @param {unknown} value
 */
export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RestoreError('Non-finite number in backup');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
export function insertSql(table, row) {
  const columns = Object.keys(row);
  if (columns.length === 0) throw new RestoreError('Empty row in backup');
  return (
    `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) ` +
    `VALUES (${columns.map((column) => sqlLiteral(row[column])).join(', ')});`
  );
}

/**
 * Verifies every file against the manifest (size, SHA-256 of the gzip bytes, row count) and
 * returns the restore SQL. `readFile(key)` returns the gzip bytes of a manifest key.
 * @param {ReturnType<typeof validateManifest>} manifest
 * @param {(key: string) => Uint8Array} readFile
 * @returns {{ sql: string, tables: number, rows: number }}
 */
export function buildRestoreSql(manifest, readFile) {
  /** @type {string[]} */
  const lines = [
    `-- open-auri restore of backup week ${manifest.week}, schema ${manifest.schemaVersion ?? 'unknown'}`,
    'PRAGMA defer_foreign_keys = on;',
  ];
  for (const trigger of manifest.triggers) {
    lines.push(`DROP TRIGGER IF EXISTS ${quoteIdent(trigger.name)};`);
  }
  let rows = 0;
  for (const table of manifest.tables) {
    let tableRows = 0;
    for (const file of table.files) {
      const bytes = readFile(file.key);
      if (bytes.byteLength !== file.bytes) throw new RestoreError(`Size mismatch: ${file.key}`);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== file.sha256) throw new RestoreError(`Checksum mismatch: ${file.key}`);
      const text = gunzipSync(bytes).toString('utf8');
      let fileRows = 0;
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const row = /** @type {unknown} */ (JSON.parse(line));
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          throw new RestoreError(`Invalid row in ${file.key}`);
        }
        lines.push(insertSql(table.name, /** @type {Record<string, unknown>} */ (row)));
        fileRows += 1;
      }
      if (fileRows !== file.rows) throw new RestoreError(`Row count mismatch: ${file.key}`);
      tableRows += fileRows;
    }
    if (tableRows !== table.rows) throw new RestoreError(`Row count mismatch: ${table.name}`);
    rows += tableRows;
  }
  for (const trigger of manifest.triggers) {
    lines.push(`${trigger.sql.trim().replace(/;$/, '')};`);
  }
  return { sql: `${lines.join('\n')}\n`, tables: manifest.tables.length, rows };
}

if (isEntryPoint(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = validateManifest(
      JSON.parse(readFileSync(join(args.dir, 'manifest.json'), 'utf8')),
    );
    if (args.bucket !== null) {
      for (const command of downloadCommands(manifest, args.bucket, args.dir)) console.log(command);
    } else {
      const result = buildRestoreSql(manifest, (key) =>
        readFileSync(join(args.dir, localName(key))),
      );
      const out = args.out ?? join(args.dir, 'restore.sql');
      writeFileSync(out, result.sql, { mode: 0o600 });
      console.log(
        `Restore SQL written: ${result.tables} tables, ${result.rows} rows, week ${manifest.week}, ` +
          `schema ${manifest.schemaVersion ?? 'unknown'}`,
      );
    }
  } catch (error) {
    // Controlled diagnostics only: never row content.
    console.error(error instanceof RestoreError ? error.message : 'Could not prepare the restore');
    process.exitCode = 1;
  }
}
