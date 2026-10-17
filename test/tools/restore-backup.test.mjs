import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  buildRestoreSql,
  downloadCommands,
  insertSql,
  localName,
  parseArgs,
  RestoreError,
  sqlLiteral,
  validateManifest,
} from '../../tools/restore-backup.mjs';

const WEEK = '2031-W10';

/** @param {Record<string, unknown>[]} rows */
function fileOf(name, rows, index = 0) {
  const bytes = gzipSync(rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  const key = `backups/${WEEK}/${name}${index === 0 ? '' : `.${index + 1}`}.ndjson.gz`;
  return {
    entry: {
      key,
      rows: rows.length,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    bytes: new Uint8Array(bytes),
  };
}

function fixture() {
  const users = fileOf('user', [{ id: 'u1', name: "O'Brien", emailVerified: 1, banExpires: null }]);
  const lineages1 = fileOf('lineages', [{ id: 'lin-00001', head_version: 'ver-00001' }]);
  const lineages2 = fileOf('lineages', [{ id: 'lin-00002', head_version: null }], 1);
  const manifest = {
    format: 'open-auri-d1-backup',
    formatVersion: 1,
    week: WEEK,
    startedAt: '2031-03-03T03:00:00.000Z',
    completedAt: '2031-03-03T03:01:00.000Z',
    schemaVersion: '0011_audit_retention.sql',
    excluded: [],
    tables: [
      { name: 'user', sql: 'CREATE TABLE "user" (...)', rows: 1, files: [users.entry] },
      {
        name: 'lineages',
        sql: 'CREATE TABLE lineages (...)',
        rows: 2,
        files: [lineages1.entry, lineages2.entry],
      },
    ],
    triggers: [
      {
        name: 'audit_log_no_delete',
        table: 'audit_log',
        sql: 'CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT 1; END',
      },
    ],
  };
  const files = new Map([
    [users.entry.key, users.bytes],
    [lineages1.entry.key, lineages1.bytes],
    [lineages2.entry.key, lineages2.bytes],
  ]);
  return { manifest, files };
}

/** @param {Map<string, Uint8Array>} files */
function reader(files) {
  return (/** @type {string} */ key) => {
    const bytes = files.get(key);
    if (!bytes) throw new Error('missing');
    return bytes;
  };
}

test('parseArgs requires a directory and accepts --out and --print-downloads', () => {
  assert.deepEqual(parseArgs(['dir']), { dir: 'dir', out: null, bucket: null });
  assert.deepEqual(parseArgs(['dir', '--out', 'x.sql']), {
    dir: 'dir',
    out: 'x.sql',
    bucket: null,
  });
  assert.deepEqual(parseArgs(['dir', '--print-downloads', 'b']), {
    dir: 'dir',
    out: null,
    bucket: 'b',
  });
  assert.throws(() => parseArgs([]), RestoreError);
  assert.throws(() => parseArgs(['dir', '--out']), RestoreError);
  assert.throws(() => parseArgs(['dir', '--unknown']), RestoreError);
});

test('sqlLiteral and insertSql quote values and identifiers', () => {
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(3), '3');
  assert.equal(sqlLiteral(true), '1');
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.throws(() => sqlLiteral(Number.NaN), RestoreError);
  assert.equal(
    insertSql('rankings', { metric: 'favorites', window: '7d', rank: 1 }),
    'INSERT INTO "rankings" ("metric", "window", "rank") VALUES (\'favorites\', \'7d\', 1);',
  );
  assert.throws(() => insertSql('bad name', { a: 1 }), RestoreError);
  assert.throws(() => insertSql('t', { 'a"; DROP': 1 }), RestoreError);
});

test('validateManifest rejects unknown formats and unsafe entries', () => {
  const { manifest } = fixture();
  // Returns the validated manifest itself (a regression here once made it return undefined).
  assert.equal(validateManifest(manifest), manifest);
  assert.equal(validateManifest(manifest).week, WEEK);
  assert.throws(() => validateManifest({ ...manifest, format: 'other' }), RestoreError);
  assert.throws(() => validateManifest({ ...manifest, week: 'latest' }), RestoreError);
  const badKey = structuredClone(manifest);
  badKey.tables[0].files[0].key = `backups/${WEEK}/../x.ndjson.gz`;
  assert.throws(() => validateManifest(badKey), RestoreError);
  const badTrigger = structuredClone(manifest);
  badTrigger.triggers[0].sql = 'DROP TABLE user';
  assert.throws(() => validateManifest(badTrigger), RestoreError);
});

test('buildRestoreSql defers foreign keys, drops triggers, inserts, then restores triggers', () => {
  const { manifest, files } = fixture();
  const result = buildRestoreSql(validateManifest(manifest), reader(files));
  assert.equal(result.tables, 2);
  assert.equal(result.rows, 3);
  const lines = result.sql.trim().split('\n');
  assert.equal(lines[1], 'PRAGMA defer_foreign_keys = on;');
  assert.equal(lines[2], 'DROP TRIGGER IF EXISTS "audit_log_no_delete";');
  assert.equal(
    lines[3],
    'INSERT INTO "user" ("id", "name", "emailVerified", "banExpires") VALUES (\'u1\', \'O\'\'Brien\', 1, NULL);',
  );
  assert.match(lines[4] ?? '', /^INSERT INTO "lineages" .*'lin-00001'/);
  assert.match(lines[5] ?? '', /^INSERT INTO "lineages" .*'lin-00002', NULL\);$/);
  assert.equal(lines[6], manifest.triggers[0].sql + ';');
  assert.equal(lines.length, 7);
});

test('buildRestoreSql refuses a file whose checksum, size or row count differs', () => {
  const { manifest, files } = fixture();
  const tampered = new Map(files);
  const key = manifest.tables[0].files[0].key;
  const original = files.get(key) ?? new Uint8Array();
  const copy = new Uint8Array(original);
  copy[copy.length - 1] ^= 0xff;
  tampered.set(key, copy);
  assert.throws(() => buildRestoreSql(validateManifest(manifest), reader(tampered)), /Checksum/);

  const short = structuredClone(manifest);
  short.tables[0].files[0].bytes += 1;
  assert.throws(() => buildRestoreSql(validateManifest(short), reader(files)), /Size/);

  const count = structuredClone(manifest);
  count.tables[1].rows = 5;
  assert.throws(() => buildRestoreSql(validateManifest(count), reader(files)), /Row count/);
});

test('downloadCommands lists one wrangler get per file, without running anything', () => {
  const { manifest } = fixture();
  const commands = downloadCommands(validateManifest(manifest), 'bucket-name', 'restore');
  assert.equal(commands.length, 3);
  assert.equal(localName(manifest.tables[1].files[1].key), 'lineages.2.ndjson.gz');
  for (const command of commands) {
    assert.match(
      command,
      /^npx wrangler r2 object get "bucket-name\/backups\/2031-W10\/[^"]+" --file "[^"]+" --remote$/,
    );
  }
});
