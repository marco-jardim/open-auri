// Operator-only export of the Marco Civil access log for a judicial order (plan §3.8, T3.3 item 7).
//
//   node tools/access-log-query.mjs --case <ref> --from <ISO> --to <ISO> --operator <id>
//                                   --out <file.ndjson> [--env staging|production]
//
// --from/--to are ISO 8601 date-times with an explicit offset (Z or ±hh:mm); the window is
// inclusive. Steps:
//   1. records the request in D1 `access_log_requests` (migration 0007; append-only, it is the
//      request's audit trail) before anything is decrypted;
//   2. finds the objects of the window in `access_log_objects` (Wrangler cannot list R2 objects);
//   3. downloads only those objects (`wrangler r2 object get --remote`) into a private temporary
//      directory, decrypts them in memory with ACCESS_LOG_KEY from the repository .env (a keyring:
//      old key ids keep decrypting after a rotation) and keeps only records inside the window;
//   4. writes the NDJSON export to --out (never overwrites; file mode 0600), records
//      exported_count, and deletes the temporary encrypted copies.
// Decrypted lines never reach stdout or stderr: the terminal only shows the request id, counts
// and the output path. Wrangler runs with the operator's own login (OAuth from `wrangler login`),
// pinned to CLOUDFLARE_ACCOUNT_ID, as in tools/sync-secrets.mjs; its output is never forwarded.
// SQL goes through `wrangler d1 execute --command`, which has no bind parameters: every value is
// validated against a strict pattern and quoted with sqlString().
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccessLogCrypto } from '../workers/jobs/src/jobs/access-log-crypto.js';
import { RenderError, isEntryPoint, loadValues, renderTemplate } from './render-wrangler.mjs';
import { whoamiIncludesAccount } from './sync-secrets.mjs';

export const USAGE =
  'Usage: node tools/access-log-query.mjs --case <ref> --from <ISO> --to <ISO> ' +
  '--operator <id> --out <file.ndjson> [--env staging|production]';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_LIMIT = 64 * 1024 * 1024;
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CASE_REF = /^[\p{L}\p{N} ._/º°ª#:()-]{3,120}$/u;
const OPERATOR = /^[\p{L}\p{N} ._@-]{2,80}$/u;
const OBJECT_KEY = /^access-log\/\d{4}\/\d{2}\/\d{2}\/(?:\d{2}|s6)-[0-9a-f-]{36}\.ndjson\.enc$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** @typedef {'staging' | 'production'} TargetEnv */
/**
 * @typedef {{ caseRef: string, from: Date, to: Date, operator: string, out: string,
 *   env: TargetEnv | undefined }} QueryArgs
 */
/**
 * @typedef {(args: string[], options: { cwd: string, env: NodeJS.ProcessEnv })
 *   => Promise<{ code: number, stdout: string }>} WranglerRunner
 */
/** @typedef {{ object_key: string, day: string, hour: number | null }} IndexRow */

/**
 * @param {string[]} args
 * @returns {QueryArgs}
 */
export function parseArgs(args) {
  /** @type {Map<string, string>} */
  const flags = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? '';
    const value = args[index + 1];
    const known = ['--case', '--from', '--to', '--operator', '--out', '--env'].includes(flag);
    if (!known || value === undefined || flags.has(flag)) throw new RenderError(USAGE);
    flags.set(flag, value);
  }
  const caseRef = (flags.get('--case') ?? '').trim();
  const operator = (flags.get('--operator') ?? '').trim();
  const fromText = flags.get('--from') ?? '';
  const toText = flags.get('--to') ?? '';
  const out = flags.get('--out') ?? '';
  const env = flags.get('--env');
  if (!caseRef || !operator || !fromText || !toText || !out) throw new RenderError(USAGE);
  if (!CASE_REF.test(caseRef)) throw new RenderError('Invalid --case reference');
  if (!OPERATOR.test(operator)) throw new RenderError('Invalid --operator');
  if (env !== undefined && env !== 'staging' && env !== 'production') {
    throw new RenderError(USAGE);
  }
  if (!ISO_WITH_OFFSET.test(fromText) || !ISO_WITH_OFFSET.test(toText)) {
    throw new RenderError('--from/--to must be ISO 8601 date-times with an offset (Z or ±hh:mm)');
  }
  const from = new Date(fromText);
  const to = new Date(toText);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new RenderError('Invalid window: --from must be before --to');
  }
  return { caseRef, from, to, operator, out, env };
}

/**
 * SQL string literal (values are validated before; quotes are doubled anyway).
 * @param {string} value
 */
export function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * @param {{ id: string, caseRef: string, from: Date, to: Date, requestedAt: Date,
 *   operator: string }} request
 */
export function insertRequestSql(request) {
  const values = [
    request.id,
    request.caseRef,
    request.from.toISOString(),
    request.to.toISOString(),
    request.requestedAt.toISOString(),
    request.operator,
  ].map(sqlString);
  return (
    'INSERT INTO access_log_requests ' +
    '(id, case_ref, window_from, window_to, requested_at, requested_by) ' +
    `VALUES (${values.join(', ')})`
  );
}

/**
 * @param {Date} from
 * @param {Date} to
 */
export function indexQuerySql(from, to) {
  const first = from.toISOString().slice(0, 10);
  const last = to.toISOString().slice(0, 10);
  return (
    'SELECT object_key, day, hour FROM access_log_objects ' +
    `WHERE day >= ${sqlString(first)} AND day <= ${sqlString(last)} ` +
    'ORDER BY day, hour, object_key'
  );
}

/**
 * @param {string} id
 * @param {number} count
 */
export function exportedCountSql(id, count) {
  if (!Number.isInteger(count) || count < 0) throw new RenderError('Invalid export count');
  return `UPDATE access_log_requests SET exported_count = ${count} WHERE id = ${sqlString(id)}`;
}

/**
 * Rows of a `wrangler d1 execute --json` result (first statement).
 * @param {string} stdout
 * @returns {Record<string, unknown>[]}
 */
export function parseD1Rows(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) throw new RenderError('Unexpected D1 output');
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    throw new RenderError('Unexpected D1 output');
  }
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  if (typeof first !== 'object' || first === null || !('results' in first)) {
    throw new RenderError('Unexpected D1 output');
  }
  const { results } = first;
  if (!Array.isArray(results)) throw new RenderError('Unexpected D1 output');
  return results.filter((row) => typeof row === 'object' && row !== null);
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {IndexRow[]}
 */
export function toIndexRows(rows) {
  return rows.map((row) => {
    const { object_key: key, day, hour } = row;
    const hourOk = hour === null || (typeof hour === 'number' && hour >= 0 && hour <= 23);
    if (typeof key !== 'string' || !OBJECT_KEY.test(key)) throw new RenderError('Bad index row');
    if (typeof day !== 'string' || !DAY.test(day) || !hourOk)
      throw new RenderError('Bad index row');
    return { object_key: key, day, hour: /** @type {number | null} */ (hour) };
  });
}

/**
 * True when the object's time span (its hour, or its whole day for day-only S6 batches)
 * intersects the inclusive window.
 * @param {IndexRow} row
 * @param {Date} from
 * @param {Date} to
 */
export function objectInWindow(row, from, to) {
  const dayStart = Date.parse(`${row.day}T00:00:00Z`);
  const start = row.hour === null ? dayStart : dayStart + row.hour * HOUR_MS;
  const end = start + (row.hour === null ? DAY_MS : HOUR_MS) - 1;
  return start <= to.getTime() && end >= from.getTime();
}

/**
 * Keeps a stored line when its timestamp is inside the inclusive window; day-only (S6) lines are
 * kept when their day intersects it.
 * @param {unknown} line
 * @param {Date} from
 * @param {Date} to
 */
export function lineInWindow(line, from, to) {
  if (typeof line !== 'object' || line === null || !('ts' in line)) return false;
  const { ts } = line;
  if (typeof ts !== 'string') return false;
  if (DAY.test(ts)) {
    const start = Date.parse(`${ts}T00:00:00Z`);
    return start <= to.getTime() && start + DAY_MS - 1 >= from.getTime();
  }
  const time = Date.parse(ts);
  return !Number.isNaN(time) && time >= from.getTime() && time <= to.getTime();
}

/**
 * Decrypts one object and returns its lines inside the window (as NDJSON strings).
 * @param {import('../workers/jobs/src/jobs/access-log-crypto.js').AccessLogCrypto} cipher
 * @param {string} key
 * @param {Uint8Array} data
 * @param {Date} from
 * @param {Date} to
 */
export async function decryptLines(cipher, key, data, from, to) {
  const plain = new TextDecoder('utf-8', { fatal: true }).decode(
    await cipher.openObject(key, data),
  );
  /** @type {string[]} */
  const kept = [];
  for (const text of plain.split('\n')) {
    if (!text) continue;
    /** @type {unknown} */
    let line;
    try {
      line = JSON.parse(text);
    } catch {
      throw new RenderError('Corrupt access-log object');
    }
    if (lineInWindow(line, from, to)) kept.push(JSON.stringify(line));
  }
  return kept;
}

/** @param {string} keyring */
function openKeyring(keyring) {
  try {
    return createAccessLogCrypto(keyring);
  } catch {
    throw new RenderError('ACCESS_LOG_KEY is not a valid keyring');
  }
}

/**
 * @param {string[]} args
 * @param {{
 *   values: Map<string, string>,
 *   run: WranglerRunner,
 *   render: (workerDir: string) => void,
 *   log: (line: string) => void,
 *   root?: string,
 *   baseEnv?: NodeJS.ProcessEnv,
 *   now?: () => Date,
 *   uuid?: () => string,
 *   tempDir?: () => string,
 * }} deps
 */
export async function queryAccessLog(args, deps) {
  const { caseRef, from, to, operator, out, env } = parseArgs(args);
  const { values, run, render, log } = deps;
  const root = deps.root ?? ROOT;
  const accountId = values.get('CLOUDFLARE_ACCOUNT_ID');
  const keyring = values.get('ACCESS_LOG_KEY');
  const bucket = values.get(env === 'staging' ? 'R2_BUCKET_STAGING' : 'R2_BUCKET');
  /** @type {[string, string | undefined][]} */
  const required = [
    ['CLOUDFLARE_ACCOUNT_ID', accountId],
    ['ACCESS_LOG_KEY', keyring],
    [env === 'staging' ? 'R2_BUCKET_STAGING' : 'R2_BUCKET', bucket],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length || !accountId || !keyring || !bucket) {
    throw new RenderError(`Missing environment variables: ${missing.join(', ')}`);
  }
  const outPath = resolve(out);
  if (existsSync(outPath)) throw new RenderError('Refusing to overwrite an existing --out file');
  const cipher = openKeyring(keyring);

  const cwd = join(root, 'web');
  render(cwd);
  const childEnv = { ...(deps.baseEnv ?? {}), CLOUDFLARE_ACCOUNT_ID: accountId };
  const envArgs = env ? ['--env', env] : [];
  const whoami = await run(['whoami', '--json'], { cwd, env: childEnv });
  if (whoami.code !== 0 || !whoamiIncludesAccount(whoami.stdout, accountId)) {
    throw new RenderError('Wrangler is not logged in to CLOUDFLARE_ACCOUNT_ID (wrangler login)');
  }
  /** @param {string} sql */
  const d1 = async (sql) => {
    const result = await run(
      ['d1', 'execute', 'DB', '--remote', '--json', ...envArgs, '--command', sql],
      { cwd, env: childEnv },
    );
    if (result.code !== 0) throw new RenderError('wrangler d1 execute failed');
    return parseD1Rows(result.stdout);
  };

  const id = (deps.uuid ?? randomUUID)();
  const requestedAt = (deps.now ?? (() => new Date()))();
  await d1(insertRequestSql({ id, caseRef, from, to, requestedAt, operator }));
  log(`Recorded request ${id} in access_log_requests`);

  const rows = toIndexRows(await d1(indexQuerySql(from, to))).filter((row) =>
    objectInWindow(row, from, to),
  );
  const temp = (deps.tempDir ?? (() => mkdtempSync(join(tmpdir(), 'open-auri-alq-'))))();
  /** @type {string[]} */
  const lines = [];
  try {
    for (const [index, row] of rows.entries()) {
      const file = join(temp, `${index}.enc`);
      const result = await run(
        ['r2', 'object', 'get', `${bucket}/${row.object_key}`, '--remote', '--file', file],
        { cwd, env: childEnv },
      );
      if (result.code !== 0) throw new RenderError('wrangler r2 object get failed');
      const data = new Uint8Array(readFileSync(file));
      rmSync(file, { force: true });
      try {
        lines.push(...(await decryptLines(cipher, row.object_key, data, from, to)));
      } catch (error) {
        if (error instanceof RenderError) throw error;
        throw new RenderError('Could not decrypt an access-log object (key id or integrity)');
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  lines.sort();
  writeFileSync(outPath, lines.length ? `${lines.join('\n')}\n` : '', { flag: 'wx', mode: 0o600 });
  await d1(exportedCountSql(id, lines.length));
  log(`Read ${rows.length} object(s); exported ${lines.length} record(s) to ${outPath}`);
  return { id, objects: rows.length, records: lines.length, out: outPath };
}

function wranglerScript() {
  const override = process.env.OPEN_AURI_WRANGLER_BIN;
  const script =
    override || fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  if (!existsSync(script)) throw new RenderError('Wrangler not found; run npm install first');
  return script;
}

/**
 * Runs Wrangler without a shell; output is captured, never forwarded.
 * @type {WranglerRunner}
 */
const runWrangler = (args, { cwd, env }) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [wranglerScript(), ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (/** @type {string} */ chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr.resume();
    child.on('error', () => reject(new RenderError('Could not start Wrangler')));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout }));
  });

if (isEntryPoint(import.meta.url)) {
  try {
    const values = loadValues();
    await queryAccessLog(process.argv.slice(2), {
      values,
      run: runWrangler,
      render: (workerDir) =>
        renderTemplate(
          join(workerDir, 'wrangler.template.jsonc'),
          join(workerDir, 'wrangler.jsonc'),
          values,
        ),
      log: (line) => console.log(line),
      baseEnv: process.env,
    });
  } catch (error) {
    // Only controlled diagnostics reach the terminal, never decrypted data or OS error text.
    console.error(error instanceof RenderError ? error.message : 'Access-log query failed');
    process.exitCode = 1;
  }
}
