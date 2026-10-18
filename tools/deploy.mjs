// Deploys open-auri from the operator's machine (plan T5.1), using the Wrangler login already in
// place (or CLOUDFLARE_API_TOKEN in the GitHub deploy workflow):
//
//   node --env-file=.env tools/deploy.mjs --env staging|production [--confirm-production]
//                                         [--skip-tests]
//
// Steps, in order, stopping at the first error:
//   1. the Wrangler login includes CLOUDFLARE_ACCOUNT_ID (`wrangler whoami --json`);
//   2. tools/check-sensitive.mjs, the root tests (unless --skip-tests) and the web build with the
//      real PUBLIC_* values (staging builds with its workers.dev origin);
//   3. renders both wrangler.jsonc and uploads the secrets (tools/sync-secrets.mjs);
//   4. D1 Time Travel bookmark (printed here only, for a rollback);
//   5. remote D1 migrations;
//   6. `wrangler deploy` of the web Worker, then of the jobs Worker;
//   7. smoke checks over HTTP against the environment's origin.
// Production requires --confirm-production and refuses --skip-tests (staging only). PUBLIC_ORIGIN
// is derived from --env (production: PRODUCTION_ORIGIN; staging: its workers.dev origin), never
// taken from .env. Staging reads its own BETTER_AUTH_SECRET, ACCESS_LOG_KEY, IPHASH_PEPPER and
// RESEND_WEBHOOK_SECRET from `<KEY>_STAGING` when set (tools/sync-secrets.mjs, which warns by key
// name when staging falls back to the production key).
//
// planDeploy() is pure (the ordered step list); runDeploy() executes it with injected effects;
// the CLI at the bottom wires the real ones. Child processes run without a shell. Values from
// .env are never printed: Wrangler output is captured and never forwarded (it may carry account
// e-mail or IDs); only step names, exit codes and the Time Travel bookmark reach the terminal.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RenderError, isEntryPoint, loadValues, renderTemplate } from './render-wrangler.mjs';
import { WORKER_DIRS, syncSecrets, whoamiIncludesAccount } from './sync-secrets.mjs';

export const USAGE =
  'Usage: node --env-file=.env tools/deploy.mjs --env staging|production ' +
  '[--confirm-production] [--skip-tests]';
/** Production custom domain (public: it is the product). Staging stays on workers.dev. */
export const PRODUCTION_ORIGIN = 'https://open-auri.com';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_LIMIT = 1024 * 1024;

/** PUBLIC_* keys the web build embeds (web/src/env.ts); all must be set. */
export const PUBLIC_BUILD_KEYS = [
  'PUBLIC_ORIGIN',
  'PUBLIC_GITHUB_URL',
  'PUBLIC_LGPD_CONTROLLER',
  'PUBLIC_LGPD_CONTACT_EMAIL',
  'PUBLIC_LGPD_CNPJ',
  'PUBLIC_LGPD_ADDRESS',
  'PUBLIC_LGPD_DPO_NAME',
  'PUBLIC_POLICY_EFFECTIVE_DATE',
  'PUBLIC_TURNSTILE_SITE_KEY',
];

/** @typedef {import('./render-wrangler.mjs').WorkerId} WorkerId */
/** @typedef {'staging' | 'production'} TargetEnv */
/** @typedef {{ env: TargetEnv, confirmProduction: boolean, skipTests: boolean }} DeployArgs */
/**
 * One planned step. `cwd` is relative to the repository root. Kinds:
 * - whoami: `wrangler <args>`, stdout must list CLOUDFLARE_ACCOUNT_ID;
 * - node: `node <args>` with inherited output (check-sensitive, tests);
 * - build: renders web/wrangler.jsonc, then `vite build` with `env` overrides;
 * - render: renders the Worker's wrangler.jsonc;
 * - secrets: tools/sync-secrets.mjs with `args`;
 * - bookmark: `wrangler <args>`, stdout carries the Time Travel bookmark;
 * - wrangler: `wrangler <args>`, exit code only;
 * - smoke: HTTP checks against `origin`.
 * @typedef {{
 *   step: number,
 *   name: string,
 *   kind: 'whoami' | 'node' | 'build' | 'render' | 'secrets' | 'bookmark' | 'wrangler' | 'smoke',
 *   cwd: string,
 *   args: string[],
 *   worker?: WorkerId,
 *   env?: Record<string, string>,
 *   origin?: string,
 * }} DeployStep
 */
/**
 * @typedef {(args: string[], options: { cwd: string, env: NodeJS.ProcessEnv, input?: string })
 *   => Promise<{ code: number, stdout: string }>} WranglerRunner
 */
/**
 * @typedef {(program: 'node' | 'vite', args: string[],
 *   options: { cwd: string, env: NodeJS.ProcessEnv }) => Promise<number>} ToolRunner
 */
/**
 * @typedef {{ path: string, status: number, contentType?: string, securityHeaders?: boolean }}
 *   SmokeCheck
 */

/**
 * @param {string[]} args
 * @returns {DeployArgs}
 */
export function parseArgs(args) {
  /** @type {TargetEnv | undefined} */
  let env;
  let confirmProduction = false;
  let skipTests = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--confirm-production' && !confirmProduction) {
      confirmProduction = true;
    } else if (flag === '--skip-tests' && !skipTests) {
      skipTests = true;
    } else if (flag === '--env' && env === undefined) {
      const value = args[index + 1];
      if (value !== 'staging' && value !== 'production') throw new RenderError(USAGE);
      env = value;
      index += 1;
    } else {
      throw new RenderError(USAGE);
    }
  }
  if (env === undefined) throw new RenderError(USAGE);
  return { env, confirmProduction, skipTests };
}

/**
 * The origin the environment serves (and the build embeds as PUBLIC_ORIGIN).
 * @param {TargetEnv} env
 * @param {Map<string, string>} values
 */
export function originFor(env, values) {
  if (env === 'production') return PRODUCTION_ORIGIN;
  const worker = values.get('WORKER_NAME_WEB');
  const subdomain = values.get('CLOUDFLARE_WORKERS_SUBDOMAIN');
  return `https://${worker}-staging.${subdomain}.workers.dev`;
}

/**
 * The values a deploy renders and builds with: PUBLIC_ORIGIN always comes from the target
 * environment (originFor), whatever the .env holds for local development. Returns a copy.
 * @param {TargetEnv} env
 * @param {Map<string, string>} values
 */
export function valuesForDeploy(env, values) {
  const copy = new Map(values);
  copy.set('PUBLIC_ORIGIN', originFor(env, values));
  return copy;
}

/**
 * Ordered steps of one deploy. Pure: validates arguments and the presence (never the content)
 * of the needed values, and runs nothing. PUBLIC_ORIGIN is derived from the environment.
 * @param {DeployArgs} args
 * @param {Map<string, string>} values
 * @param {{ dotenv?: boolean }} [options] dotenv false (GitHub deploy, values from secrets): the
 *   sensitive-data scan runs in its --no-env mode
 * @returns {DeployStep[]}
 */
export function planDeploy(args, values, { dotenv = true } = {}) {
  const { env, confirmProduction, skipTests } = args;
  if (env === 'production' && !confirmProduction) {
    throw new RenderError('Production deploy requires --confirm-production');
  }
  if (env === 'production' && skipTests) {
    throw new RenderError('--skip-tests is not allowed for a production deploy');
  }
  const dbKey = env === 'production' ? 'D1_DATABASE_NAME' : 'D1_DATABASE_NAME_STAGING';
  const required = [
    'CLOUDFLARE_ACCOUNT_ID',
    'WORKER_NAME_WEB',
    dbKey,
    ...PUBLIC_BUILD_KEYS.filter((key) => key !== 'PUBLIC_ORIGIN'),
  ];
  if (env === 'staging') required.push('CLOUDFLARE_WORKERS_SUBDOMAIN');
  const missing = required.filter((key) => !values.get(key)).sort();
  if (missing.length) {
    throw new RenderError(`Missing environment variables: ${missing.join(', ')}`);
  }
  const origin = originFor(env, values);
  const web = WORKER_DIRS.web;
  const jobs = WORKER_DIRS.jobs;
  const envArgs = ['--env', env];

  /** @type {DeployStep[]} */
  const steps = [
    { step: 1, name: 'account', kind: 'whoami', cwd: web, args: ['whoami', '--json'] },
    {
      step: 2,
      name: 'check-sensitive',
      kind: 'node',
      cwd: '.',
      args: ['tools/check-sensitive.mjs', ...(dotenv ? [] : ['--no-env'])],
    },
  ];
  if (!skipTests) {
    steps.push({
      step: 2,
      name: 'tests',
      kind: 'node',
      cwd: '.',
      args: ['--test', 'test/**/*.test.mjs'],
    });
  }
  steps.push(
    {
      step: 2,
      name: 'build-web',
      kind: 'build',
      cwd: web,
      args: ['build'],
      env: { PUBLIC_ORIGIN: origin },
    },
    { step: 3, name: 'render-web', kind: 'render', cwd: web, args: [], worker: 'web' },
    { step: 3, name: 'render-jobs', kind: 'render', cwd: jobs, args: [], worker: 'jobs' },
    {
      step: 3,
      name: 'secrets-web',
      kind: 'secrets',
      cwd: web,
      args: [...envArgs, '--worker', 'web'],
      worker: 'web',
    },
    {
      step: 3,
      name: 'secrets-jobs',
      kind: 'secrets',
      cwd: jobs,
      args: [...envArgs, '--worker', 'jobs'],
      worker: 'jobs',
    },
    {
      step: 4,
      name: 'time-travel-bookmark',
      kind: 'bookmark',
      cwd: web,
      args: ['d1', 'time-travel', 'info', values.get(dbKey) ?? '', ...envArgs, '--json'],
    },
    {
      step: 5,
      name: 'migrations',
      kind: 'wrangler',
      cwd: web,
      args: ['d1', 'migrations', 'apply', 'DB', '--remote', ...envArgs],
    },
    { step: 6, name: 'deploy-web', kind: 'wrangler', cwd: web, args: ['deploy', ...envArgs] },
    { step: 6, name: 'deploy-jobs', kind: 'wrangler', cwd: jobs, args: ['deploy', ...envArgs] },
    { step: 7, name: 'smoke', kind: 'smoke', cwd: '.', args: [], origin },
  );
  return steps;
}

/**
 * Bookmark from `wrangler d1 time-travel info --json`. Only a bookmark-shaped string is
 * accepted, so nothing else from Wrangler's output can reach the terminal.
 * @param {string} stdout
 */
export function parseBookmark(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('bookmark' in parsed)) return undefined;
  const { bookmark } = parsed;
  return typeof bookmark === 'string' && /^[0-9a-f-]{8,128}$/i.test(bookmark)
    ? bookmark
    : undefined;
}

/** HTTP checks of the smoke step (paths only; the origin comes from the plan). */
export const SMOKE_CHECKS = /** @type {readonly SmokeCheck[]} */ ([
  { path: '/', status: 200, securityHeaders: true },
  { path: '/docs', status: 200 },
  { path: '/api/v1/feed', status: 200, contentType: 'application/json' },
  { path: '/og/deploy-smoke-unknown.png', status: 404 },
]);

/** Security headers every HTML response must carry (web/src/lib/server/security/headers.ts). */
export const SECURITY_HEADERS = /** @type {const} */ ([
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', undefined],
  ['permissions-policy', undefined],
  ['content-security-policy', undefined],
  ['strict-transport-security', undefined],
]);

/**
 * Failures of one smoke response (empty when it passes).
 * @param {SmokeCheck} check
 * @param {{ status: number, headers: { get(name: string): string | null } }} response
 * @returns {string[]}
 */
export function evaluateSmoke(check, response) {
  /** @type {string[]} */
  const failures = [];
  if (response.status !== check.status) {
    failures.push(`${check.path}: expected HTTP ${check.status}, got ${response.status}`);
  }
  if (check.contentType) {
    const type = response.headers.get('content-type') ?? '';
    if (!type.toLowerCase().startsWith(check.contentType)) {
      failures.push(`${check.path}: expected content-type ${check.contentType}`);
    }
  }
  if (check.securityHeaders) {
    for (const [name, expected] of SECURITY_HEADERS) {
      const value = response.headers.get(name);
      if (value === null || value === '') failures.push(`${check.path}: missing header ${name}`);
      else if (expected !== undefined && value.trim() !== expected) {
        failures.push(`${check.path}: header ${name} is not ${expected}`);
      }
    }
  }
  return failures;
}

/** Keys of the project's .env family (see .env.example), dropped from the scan/test children. */
const PROJECT_KEY =
  /^(?:PUBLIC_|CLOUDFLARE_|WORKER_NAME_|D1_|KV_|R2_|ACCESS_LOG_|RESEND_|TURNSTILE_|BETTER_AUTH_|IPHASH_|ADMIN_|SIGNUP_ENABLED$|EMAIL_TRANSPORT$)/;

/**
 * Environment for check-sensitive and the root tests: the operator's environment without the
 * project's keys that `node --env-file=.env` loaded, so the tests run as a plain `npm test`
 * (never seeing real values) and their output cannot echo them.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function plainEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !PROJECT_KEY.test(key)));
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Runs the plan with injected effects, stopping at the first error.
 * @param {string[]} argv
 * @param {{
 *   values: Map<string, string>,
 *   wrangler: WranglerRunner,
 *   tool: ToolRunner,
 *   render: (workerDir: string) => void,
 *   secrets: (args: string[]) => Promise<void>,
 *   fetch: (url: string) => Promise<{ status: number,
 *     headers: { get(name: string): string | null } }>,
 *   log: (line: string) => void,
 *   root?: string,
 *   baseEnv?: NodeJS.ProcessEnv,
 *   sleep?: (ms: number) => Promise<void>,
 *   smokeAttempts?: number,
 *   dotenv?: boolean,
 * }} deps
 * @returns {Promise<{ bookmark: string | undefined }>}
 */
export async function runDeploy(argv, deps) {
  const args = parseArgs(argv);
  // deps.values (and the render/secrets effects) must already be valuesForDeploy(env, ...).
  const steps = planDeploy(args, deps.values, { dotenv: deps.dotenv ?? true });
  const root = deps.root ?? ROOT;
  const accountId = deps.values.get('CLOUDFLARE_ACCOUNT_ID') ?? '';
  const sleep = deps.sleep ?? delay;
  const attempts = deps.smokeAttempts ?? 3;
  // Pin the account for every child; the rest of the environment is the operator's own.
  const childEnv = {
    ...(deps.baseEnv ?? {}),
    CLOUDFLARE_ACCOUNT_ID: accountId,
    WRANGLER_SEND_METRICS: 'false',
  };
  /** @type {string | undefined} */
  let bookmark;

  deps.log(`Deploying to ${args.env} (${steps.length} steps).`);
  for (const step of steps) {
    const cwd = join(root, step.cwd);
    deps.log(`[${step.step}/7] ${step.name}`);
    switch (step.kind) {
      case 'whoami': {
        const result = await deps.wrangler(step.args, { cwd, env: childEnv });
        if (result.code !== 0) throw new RenderError('Wrangler is not authenticated');
        if (!whoamiIncludesAccount(result.stdout, accountId)) {
          throw new RenderError('The Wrangler login does not include CLOUDFLARE_ACCOUNT_ID');
        }
        break;
      }
      case 'node': {
        const code = await deps.tool('node', step.args, {
          cwd,
          env: plainEnv(deps.baseEnv ?? {}),
        });
        if (code !== 0) throw new RenderError(`Step ${step.name} failed (exit ${code})`);
        break;
      }
      case 'build': {
        deps.render(cwd);
        const code = await deps.tool('vite', step.args, {
          cwd,
          env: { ...childEnv, ...step.env },
        });
        if (code !== 0) throw new RenderError(`Step ${step.name} failed (exit ${code})`);
        // Same post-build step as `npm run build`: the canonical-host wrapper becomes the entry
        // (issue #33), so a deploy never ships the bare SvelteKit worker.
        const wrapped = await deps.tool('node', ['scripts/wrap-worker.mjs'], {
          cwd,
          env: plainEnv(deps.baseEnv ?? {}),
        });
        if (wrapped !== 0) throw new RenderError(`Step ${step.name} failed to wrap the worker`);
        break;
      }
      case 'render':
        deps.render(cwd);
        break;
      case 'secrets':
        await deps.secrets(step.args);
        break;
      case 'bookmark': {
        const result = await deps.wrangler(step.args, { cwd, env: childEnv });
        bookmark = result.code === 0 ? parseBookmark(result.stdout) : undefined;
        if (!bookmark) throw new RenderError('Could not read the D1 Time Travel bookmark');
        deps.log(`Time Travel bookmark (${args.env}, before migrations): ${bookmark}`);
        break;
      }
      case 'wrangler': {
        const result = await deps.wrangler(step.args, { cwd, env: childEnv });
        if (result.code !== 0) {
          throw new RenderError(
            `Step ${step.name} failed (exit ${result.code}); rerun ` +
              `"npx wrangler ${step.args.join(' ')}" in ${step.cwd} to see Wrangler's output`,
          );
        }
        break;
      }
      case 'smoke': {
        const origin = step.origin ?? '';
        for (const check of SMOKE_CHECKS) {
          /** @type {string[]} */
          let failures = [];
          for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
              failures = evaluateSmoke(check, await deps.fetch(`${origin}${check.path}`));
            } catch {
              failures = [`${check.path}: request failed`];
            }
            if (!failures.length) break;
            if (attempt < attempts) await sleep(5000);
          }
          if (failures.length) throw new RenderError(`Smoke failed: ${failures.join('; ')}`);
          deps.log(`  ok ${check.path}`);
        }
        break;
      }
    }
  }
  deps.log(`Deploy to ${args.env} finished.`);
  return { bookmark };
}

/** @param {string} script path relative to a node_modules directory */
function resolveBin(script) {
  const found = [join(ROOT, 'web', 'node_modules'), join(ROOT, 'node_modules')]
    .map((dir) => join(dir, script))
    .find((candidate) => existsSync(candidate));
  if (!found) throw new RenderError(`${script} not found; run npm install first`);
  return found;
}

function wranglerScript() {
  const override = process.env.OPEN_AURI_WRANGLER_BIN;
  if (override) {
    if (!existsSync(override)) throw new RenderError('Wrangler not found; run npm install first');
    return override;
  }
  return resolveBin(join('wrangler', 'bin', 'wrangler.js'));
}

/**
 * Wrangler without a shell; output captured and never forwarded.
 * @type {WranglerRunner}
 */
const runWrangler = (args, { cwd, env, input }) =>
  new Promise((resolvePromise, reject) => {
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
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout }));
    child.stdin.on('error', () => {
      // EPIPE when Wrangler exits before reading stdin; the exit code reports the failure.
      child.stdin.destroy();
    });
    child.stdin.end(input ?? '');
  });

/**
 * Node scripts (check-sensitive, tests) and Vite, without a shell; their output is our own
 * code's and is forwarded so a failing test or build can be read.
 * @type {ToolRunner}
 */
const runTool = (program, args, { cwd, env }) =>
  new Promise((resolvePromise, reject) => {
    const full = program === 'vite' ? [resolveBin(join('vite', 'bin', 'vite.js')), ...args] : args;
    const child = spawn(process.execPath, full, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => reject(new RenderError(`Could not start ${program}`)));
    child.on('close', (code) => resolvePromise(code ?? 1));
  });

if (isEntryPoint(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const values = valuesForDeploy(parseArgs(argv).env, loadValues());
    /** @param {string} workerDir */
    const render = (workerDir) =>
      renderTemplate(
        join(workerDir, 'wrangler.template.jsonc'),
        join(workerDir, 'wrangler.jsonc'),
        values,
      );
    const log = (/** @type {string} */ line) => console.log(line);
    await runDeploy(argv, {
      values,
      wrangler: runWrangler,
      tool: runTool,
      render,
      secrets: (args) =>
        syncSecrets(args, { values, run: runWrangler, render, log, baseEnv: process.env }),
      fetch: (url) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) }),
      log,
      baseEnv: process.env,
      dotenv: existsSync(join(ROOT, '.env')),
    });
  } catch (error) {
    // Only controlled diagnostics may reach the terminal, never input or OS error text.
    console.error(error instanceof RenderError ? error.message : 'Deploy failed');
    process.exitCode = 1;
  }
}
