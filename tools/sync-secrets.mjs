// Uploads the runtime secrets from the repository .env to a Worker with `wrangler secret put`,
// one at a time, value on stdin. Never echoes values: only secret names reach the terminal.
//
//   node tools/sync-secrets.mjs [--env staging|production] [--worker web|jobs]
//
// Without --env the top-level (production) Worker is targeted. Before uploading, the Wrangler
// login must include CLOUDFLARE_ACCOUNT_ID (checked with `wrangler whoami --json`), and the
// Worker's wrangler.jsonc is re-rendered from its template.
//
// Wrangler runs as `node <repo>/node_modules/wrangler/bin/wrangler.js`: the same program as
// `npx wrangler`, but spawnable without a shell on Windows (npx is a .cmd shim there).
// OPEN_AURI_WRANGLER_BIN overrides that script path.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RenderError,
  SECRETS,
  isEntryPoint,
  loadValues,
  renderTemplate,
} from './render-wrangler.mjs';

export const USAGE =
  'Usage: node tools/sync-secrets.mjs [--env staging|production] [--worker web|jobs]';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** @type {Record<WorkerId, string>} */
export const WORKER_DIRS = { web: 'web', jobs: join('workers', 'jobs') };
const OUTPUT_LIMIT = 1024 * 1024;

/** @typedef {import('./render-wrangler.mjs').WorkerId} WorkerId */
/** @typedef {'staging' | 'production'} TargetEnv */
/**
 * @typedef {(args: string[], options: { cwd: string, env: NodeJS.ProcessEnv, input?: string })
 *   => Promise<{ code: number, stdout: string }>} WranglerRunner
 */

/**
 * @param {string[]} args
 * @returns {{ env: TargetEnv | undefined, worker: WorkerId }}
 */
export function parseArgs(args) {
  /** @type {TargetEnv | undefined} */
  let env;
  /** @type {WorkerId | undefined} */
  let worker;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const isEnv = value === 'staging' || value === 'production';
    const isWorker = value === 'web' || value === 'jobs';
    if (flag === '--env' && env === undefined && isEnv) {
      env = value;
    } else if (flag === '--worker' && worker === undefined && isWorker) {
      worker = value;
    } else {
      throw new RenderError(USAGE);
    }
  }
  return { env, worker: worker ?? 'web' };
}

/**
 * Names-only plan: which secrets go to `worker`, which optional ones are skipped.
 * Throws (listing .env key names only) when a required secret is absent or empty.
 * @param {Map<string, string>} values
 * @param {WorkerId} worker
 * @returns {{ uploads: { name: string, source: string }[], skipped: string[] }}
 */
export function planSecrets(values, worker) {
  const specs = SECRETS.filter((spec) => spec.workers.includes(worker));
  const missing = specs
    .filter((spec) => spec.required && !values.get(spec.source))
    .map((spec) => spec.source)
    .sort();
  if (missing.length) {
    throw new RenderError(`Missing environment variables: ${missing.join(', ')}`);
  }
  /** @type {{ name: string, source: string }[]} */
  const uploads = [];
  /** @type {string[]} */
  const skipped = [];
  for (const spec of specs) {
    if (values.get(spec.source)) uploads.push({ name: spec.name, source: spec.source });
    else skipped.push(spec.name);
  }
  return { uploads, skipped };
}

/**
 * @param {string} name
 * @param {TargetEnv | undefined} env
 */
export function secretPutArgs(name, env) {
  return ['secret', 'put', name, ...(env ? ['--env', env] : [])];
}

/**
 * True when `wrangler whoami --json` output lists an account whose id is `accountId`.
 * @param {string} stdout
 * @param {string} accountId
 */
export function whoamiIncludesAccount(stdout, accountId) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (!accountId || start < 0 || end < start) return false;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || !('accounts' in parsed)) return false;
  const { accounts } = parsed;
  if (!Array.isArray(accounts)) return false;
  return accounts.some(
    (account) =>
      typeof account === 'object' &&
      account !== null &&
      'id' in account &&
      account.id === accountId,
  );
}

/**
 * Orchestrates the sync with injected effects (the CLI below wires the real ones).
 * @param {string[]} args
 * @param {{
 *   values: Map<string, string>,
 *   run: WranglerRunner,
 *   render: (workerDir: string) => void,
 *   log: (line: string) => void,
 *   root?: string,
 *   baseEnv?: NodeJS.ProcessEnv,
 * }} deps
 */
export async function syncSecrets(args, { values, run, render, log, root = ROOT, baseEnv = {} }) {
  const { env, worker } = parseArgs(args);
  const accountId = values.get('CLOUDFLARE_ACCOUNT_ID');
  if (!accountId) throw new RenderError('Missing environment variables: CLOUDFLARE_ACCOUNT_ID');
  const { uploads, skipped } = planSecrets(values, worker);

  const cwd = join(root, WORKER_DIRS[worker]);
  render(cwd);

  // Pin the account for every Wrangler call; nothing else from .env enters the child env.
  const childEnv = { ...baseEnv, CLOUDFLARE_ACCOUNT_ID: accountId };
  const whoami = await run(['whoami', '--json'], { cwd, env: childEnv });
  if (whoami.code !== 0) throw new RenderError('Wrangler is not authenticated (wrangler login)');
  if (!whoamiIncludesAccount(whoami.stdout, accountId)) {
    throw new RenderError('The Wrangler login does not include CLOUDFLARE_ACCOUNT_ID; aborting');
  }

  const target = env ? `${worker} (${env})` : `${worker} (top level)`;
  for (const name of skipped) log(`Skipped optional secret (not set): ${name}`);
  for (const { name, source } of uploads) {
    const result = await run(secretPutArgs(name, env), {
      cwd,
      env: childEnv,
      input: values.get(source) ?? '',
    });
    if (result.code !== 0) {
      throw new RenderError(`wrangler secret put failed for ${name} on ${target}`);
    }
    log(`Uploaded secret ${name} to ${target}`);
  }
}

function wranglerScript() {
  const override = process.env.OPEN_AURI_WRANGLER_BIN;
  const script =
    override || fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  if (!existsSync(script)) throw new RenderError('Wrangler not found; run npm install first');
  return script;
}

/**
 * Runs Wrangler without a shell. Its output is captured and never forwarded (it may contain
 * account e-mail or IDs); only the exit code and, when asked, stdout are returned.
 * @type {WranglerRunner}
 */
const runWrangler = (args, { cwd, env, input }) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerScript(), ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (/** @type {string} */ chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr.resume();
    child.on('error', () => reject(new RenderError('Could not start Wrangler')));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.on('error', () => {
      // EPIPE when Wrangler exits before reading stdin; the exit code reports the failure.
      child.stdin.destroy();
    });
    child.stdin.end(input ?? '');
  });

if (isEntryPoint(import.meta.url)) {
  try {
    const values = loadValues();
    await syncSecrets(process.argv.slice(2), {
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
    // Only controlled diagnostics may reach the terminal, never input or OS error text.
    console.error(error instanceof RenderError ? error.message : 'Could not sync secrets');
    process.exitCode = 1;
  }
}
