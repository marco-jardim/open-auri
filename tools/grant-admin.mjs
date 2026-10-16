// Operator-only: gives the admin role to an account (plan T3.8). The role is never granted by the
// UI; this tool is the only way in.
//
//   node tools/grant-admin.mjs [--email <address>] [--create] [--operator <label>]
//                              [--env staging|production] [--local]
//
// --email defaults to ADMIN_EMAIL from the repository .env. The address is never printed: the
// terminal only shows the outcome and the audit row id.
// --create creates the account when it does not exist yet. Safest option chosen: the account is
// created WITHOUT any password (no credential row, so nobody can sign in with it), with the
// e-mail marked verified (the address is the operator's own, from .env or typed by the operator)
// and the admin role. Nothing is sent. To take it over, the operator opens /esqueci-senha and
// requests a reset for that address: only its mailbox receives the link, and the reset creates
// the password. Then 2FA must be enabled in /conta before /admin opens (ADMIN_2FA_REQUIRED).
// Printing a generated password was rejected: it would land in terminal scrollback and logs.
// --operator is an optional label recorded as the audit row's actor_id (actor_kind 'operator').
// --local targets the local D1 of `wrangler dev` (no account check); otherwise --remote, with the
// Wrangler login pinned to CLOUDFLARE_ACCOUNT_ID and checked with `wrangler whoami`, as in
// tools/sync-secrets.mjs. Wrangler output is never forwarded.
//
// SQL: the statements that carry the e-mail go through `wrangler d1 execute --file` with a
// private temporary file (mode 0600, removed afterwards), so the address appears neither in the
// process list nor in shell history (unless typed with --email). Values are validated against
// strict patterns and quoted with sqlString() (Wrangler has no bind parameters). The outcome is
// read back with a SELECT on the audit row id only. Statements, in order:
//   1. (--create) INSERT the user when no row has that e-mail;
//   2. INSERT the audit row ('user.grant_admin', target the user id, detail with the previous
//      role and whether it was created), only when the user exists;
//   3. UPDATE the role to 'admin'.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseD1Rows, sqlString } from './access-log-query.mjs';
import { RenderError, isEntryPoint, loadValues, renderTemplate } from './render-wrangler.mjs';
import { whoamiIncludesAccount } from './sync-secrets.mjs';

export const USAGE =
  'Usage: node tools/grant-admin.mjs [--email <address>] [--create] [--operator <label>] ' +
  '[--env staging|production] [--local]';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_LIMIT = 1024 * 1024;
const OPERATOR = /^[\p{L}\p{N} ._@-]{2,80}$/u;
// Conservative address shape: no quotes, backslashes, semicolons, whitespace or control chars.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const EMAIL = new RegExp(`^[a-z0-9.!#$%&*+/=?^_\`{|}~-]{1,64}@${LABEL}(?:\\.${LABEL})+$`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @typedef {'staging' | 'production'} TargetEnv */
/**
 * @typedef {{ email: string | undefined, create: boolean, operator: string | undefined,
 *   env: TargetEnv | undefined, local: boolean }} GrantArgs
 */
/**
 * @typedef {(args: string[], options: { cwd: string, env: NodeJS.ProcessEnv })
 *   => Promise<{ code: number, stdout: string }>} WranglerRunner
 */

/**
 * @param {string[]} args
 * @returns {GrantArgs}
 */
export function parseArgs(args) {
  /** @type {GrantArgs} */
  const parsed = {
    email: undefined,
    create: false,
    operator: undefined,
    env: undefined,
    local: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--create' && !parsed.create) {
      parsed.create = true;
      continue;
    }
    if (flag === '--local' && !parsed.local) {
      parsed.local = true;
      continue;
    }
    const value = args[index + 1];
    index += 1;
    if (value === undefined || value.startsWith('--')) throw new RenderError(USAGE);
    if (flag === '--email' && parsed.email === undefined) parsed.email = value;
    else if (flag === '--operator' && parsed.operator === undefined) {
      if (!OPERATOR.test(value.trim())) throw new RenderError('Invalid --operator');
      parsed.operator = value.trim();
    } else if (
      flag === '--env' &&
      parsed.env === undefined &&
      (value === 'staging' || value === 'production')
    ) {
      parsed.env = value;
    } else {
      throw new RenderError(USAGE);
    }
  }
  return parsed;
}

/**
 * Lowercased, NFKC-normalized address (as Better Auth stores it). Throws without echoing it.
 * @param {string} value
 */
export function normalizeEmail(value) {
  const email = value.normalize('NFKC').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    throw new RenderError('Invalid e-mail address (value not shown)');
  }
  return email;
}

/**
 * The statements of one grant (see the header comment). All values validated and quoted.
 * @param {{ email: string, create: boolean, userId: string, auditId: string,
 *   operator: string | undefined, now: Date }} grant
 */
export function grantSql(grant) {
  const email = sqlString(normalizeEmail(grant.email));
  if (!UUID.test(grant.auditId) || !/^[a-f0-9]{32}$/.test(grant.userId)) {
    throw new RenderError('Invalid generated id');
  }
  const ms = grant.now.getTime();
  if (!Number.isSafeInteger(ms)) throw new RenderError('Invalid clock');
  const iso = sqlString(grant.now.toISOString());
  const userId = sqlString(grant.userId);
  const actor = grant.operator === undefined ? 'NULL' : sqlString(grant.operator);
  /** @type {string[]} */
  const statements = [];
  if (grant.create) {
    statements.push(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role, banned, ' +
        `twoFactorEnabled) SELECT ${userId}, 'admin', ${email}, 1, ${iso}, ${iso}, 'user', 0, 0 ` +
        `WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE email = ${email})`,
    );
  }
  statements.push(
    'INSERT INTO audit_log (id, actor_id, actor_kind, action, target_kind, target_id, detail, ' +
      `created_at) SELECT ${sqlString(grant.auditId)}, ${actor}, 'operator', 'user.grant_admin', ` +
      "'user', id, json_object('previousRole', COALESCE(role, 'user'), 'created', " +
      `CASE WHEN id = ${userId} THEN json('true') ELSE json('false') END), ${ms} ` +
      `FROM "user" WHERE email = ${email}`,
    `UPDATE "user" SET role = 'admin', updatedAt = ${iso} WHERE email = ${email}`,
  );
  return `${statements.join(';\n')};\n`;
}

/** @param {string} auditId */
export function outcomeSql(auditId) {
  if (!UUID.test(auditId)) throw new RenderError('Invalid generated id');
  return `SELECT target_id, detail FROM audit_log WHERE id = ${sqlString(auditId)}`;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {{ found: false } | { found: true, created: boolean, previousRole: string }}
 */
export function parseOutcome(rows) {
  const row = rows[0];
  if (!row) return { found: false };
  /** @type {unknown} */
  let detail;
  try {
    detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : null;
  } catch {
    throw new RenderError('Unexpected D1 output');
  }
  if (typeof detail !== 'object' || detail === null) throw new RenderError('Unexpected D1 output');
  const { previousRole, created } = /** @type {{ previousRole?: unknown, created?: unknown }} */ (
    detail
  );
  return {
    found: true,
    created: created === true,
    previousRole: typeof previousRole === 'string' ? previousRole : 'user',
  };
}

/**
 * @param {{ local: boolean, env: TargetEnv | undefined }} target
 * @param {string[]} rest
 */
export function d1Args(target, rest) {
  return [
    'd1',
    'execute',
    'DB',
    target.local ? '--local' : '--remote',
    ...(target.env ? ['--env', target.env] : []),
    ...rest,
  ];
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
export async function grantAdmin(args, deps) {
  const parsed = parseArgs(args);
  const { values, run, render, log } = deps;
  const source = parsed.email ?? values.get('ADMIN_EMAIL');
  if (!source) {
    throw new RenderError('Missing environment variables: ADMIN_EMAIL (or pass --email)');
  }
  const email = normalizeEmail(source);
  const accountId = values.get('CLOUDFLARE_ACCOUNT_ID');
  if (!parsed.local && !accountId) {
    throw new RenderError('Missing environment variables: CLOUDFLARE_ACCOUNT_ID');
  }

  const cwd = join(deps.root ?? ROOT, 'web');
  render(cwd);
  const childEnv = {
    ...(deps.baseEnv ?? {}),
    ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
  };
  if (!parsed.local) {
    const whoami = await run(['whoami', '--json'], { cwd, env: childEnv });
    if (whoami.code !== 0 || !whoamiIncludesAccount(whoami.stdout, accountId ?? '')) {
      throw new RenderError('Wrangler is not logged in to CLOUDFLARE_ACCOUNT_ID (wrangler login)');
    }
  }

  const uuid = deps.uuid ?? randomUUID;
  const auditId = uuid();
  const userId = uuid().replaceAll('-', '');
  const now = (deps.now ?? (() => new Date()))();
  const sql = grantSql({
    email,
    create: parsed.create,
    userId,
    auditId,
    operator: parsed.operator,
    now,
  });

  const temp = (deps.tempDir ?? (() => mkdtempSync(join(tmpdir(), 'open-auri-grant-'))))();
  try {
    const file = join(temp, 'grant.sql');
    writeFileSync(file, sql, { flag: 'wx', mode: 0o600 });
    const result = await run(d1Args(parsed, ['--yes', '--file', file]), { cwd, env: childEnv });
    if (result.code !== 0) throw new RenderError('wrangler d1 execute failed');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const check = await run(d1Args(parsed, ['--json', '--command', outcomeSql(auditId)]), {
    cwd,
    env: childEnv,
  });
  if (check.code !== 0) throw new RenderError('wrangler d1 execute failed (outcome check)');
  const outcome = parseOutcome(parseD1Rows(check.stdout));
  if (!outcome.found) {
    throw new RenderError(
      'No account with that e-mail; nothing changed (pass --create to create it)',
    );
  }
  const target = parsed.local ? 'local D1' : `remote D1${parsed.env ? ` (${parsed.env})` : ''}`;
  if (outcome.created) {
    log(`Created the admin account on ${target} without a password (audit ${auditId}).`);
    log('Next: open /esqueci-senha, request a reset for the admin address, set the password,');
    log('then enable two-step verification in /conta; /admin requires it.');
  } else if (outcome.previousRole === 'admin') {
    log(`The account already had the admin role on ${target} (audit ${auditId}).`);
  } else {
    log(`Granted the admin role on ${target} (audit ${auditId}).`);
  }
  return { auditId, ...outcome };
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
    await grantAdmin(process.argv.slice(2), {
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
    // Only controlled diagnostics reach the terminal, never the address or OS error text.
    console.error(error instanceof RenderError ? error.message : 'Could not grant the admin role');
    process.exitCode = 1;
  }
}
