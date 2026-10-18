import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  PRODUCTION_ORIGIN,
  PUBLIC_BUILD_KEYS,
  SMOKE_CHECKS,
  evaluateSmoke,
  originFor,
  parseArgs,
  parseBookmark,
  planDeploy,
  plainEnv,
  runDeploy,
  valuesForDeploy,
} from '../../tools/deploy.mjs';

const ACCOUNT = 'fixture-account-0001';
const BOOKMARK = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';

/** @param {Record<string, string>} extra */
function valuesOf(extra = {}) {
  /** @type {Record<string, string>} */
  const publics = {};
  for (const key of PUBLIC_BUILD_KEYS) publics[key] = `fixture-${key.toLowerCase()}`;
  return new Map(
    Object.entries({
      ...publics,
      PUBLIC_ORIGIN: PRODUCTION_ORIGIN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      WORKER_NAME_WEB: 'fixture-web',
      CLOUDFLARE_WORKERS_SUBDOMAIN: 'fixture-sub',
      D1_DATABASE_NAME: 'fixture-db',
      D1_DATABASE_NAME_STAGING: 'fixture-db-staging',
      ...extra,
    }),
  );
}

/** @param {Record<string, string>} pairs */
function headersOf(pairs) {
  const map = new Map(Object.entries(pairs));
  return { get: (/** @type {string} */ name) => map.get(name) ?? null };
}

const GOOD_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'hid=(self)',
  'content-security-policy': "frame-ancestors 'none'",
  'strict-transport-security': 'max-age=63072000',
  'content-type': 'application/json; charset=utf-8',
};

test('parseArgs requires --env and accepts the two flags once, in any order', () => {
  assert.deepEqual(parseArgs(['--env', 'staging']), {
    env: 'staging',
    confirmProduction: false,
    skipTests: false,
  });
  assert.deepEqual(parseArgs(['--skip-tests', '--env', 'production', '--confirm-production']), {
    env: 'production',
    confirmProduction: true,
    skipTests: true,
  });
  for (const args of [
    [],
    ['--env'],
    ['--env', 'dev'],
    ['--env=staging'],
    ['--env', 'staging', '--env', 'production'],
    ['--env', 'staging', '--skip-tests', '--skip-tests'],
    ['--env', 'staging', '--force'],
    ['staging'],
  ]) {
    assert.throws(() => parseArgs(args), /Usage:/, JSON.stringify(args));
  }
});

test('planDeploy lists the steps in order for staging, with names and arguments only', () => {
  const plan = planDeploy(parseArgs(['--env', 'staging']), valuesOf());
  assert.deepEqual(
    plan.map(({ step, name }) => `${step}:${name}`),
    [
      '1:account',
      '2:check-sensitive',
      '2:tests',
      '2:build-web',
      '3:render-web',
      '3:render-jobs',
      '3:secrets-web',
      '3:secrets-jobs',
      '4:time-travel-bookmark',
      '5:migrations',
      '6:deploy-web',
      '6:deploy-jobs',
      '7:smoke',
    ],
  );
  const byName = Object.fromEntries(plan.map((step) => [step.name, step]));
  assert.deepEqual(byName.account.args, ['whoami', '--json']);
  assert.deepEqual(byName['check-sensitive'].args, ['tools/check-sensitive.mjs']);
  assert.deepEqual(byName.tests.args, ['--test', 'test/**/*.test.mjs']);
  assert.deepEqual(byName['build-web'].env, {
    PUBLIC_ORIGIN: 'https://fixture-web-staging.fixture-sub.workers.dev',
  });
  assert.deepEqual(byName['secrets-jobs'].args, ['--env', 'staging', '--worker', 'jobs']);
  assert.deepEqual(byName['time-travel-bookmark'].args, [
    'd1',
    'time-travel',
    'info',
    'fixture-db-staging',
    '--env',
    'staging',
    '--json',
  ]);
  assert.deepEqual(byName.migrations.args, [
    'd1',
    'migrations',
    'apply',
    'DB',
    '--remote',
    '--env',
    'staging',
  ]);
  assert.equal(byName['deploy-web'].cwd, 'web');
  assert.equal(byName['deploy-jobs'].cwd, join('workers', 'jobs'));
  assert.deepEqual(byName['deploy-jobs'].args, ['deploy', '--env', 'staging']);
  assert.equal(byName.smoke.origin, 'https://fixture-web-staging.fixture-sub.workers.dev');
});

test('planDeploy skips only the tests with --skip-tests', () => {
  const names = planDeploy(parseArgs(['--env', 'staging', '--skip-tests']), valuesOf()).map(
    (step) => step.name,
  );
  assert.ok(!names.includes('tests'));
  assert.ok(names.includes('check-sensitive'));
  assert.ok(names.includes('build-web'));
});

test('planDeploy refuses --skip-tests for production, even when confirmed', () => {
  assert.throws(
    () =>
      planDeploy(
        parseArgs(['--env', 'production', '--confirm-production', '--skip-tests']),
        valuesOf(),
      ),
    /^Error: --skip-tests is not allowed for a production deploy$/,
  );
  const names = planDeploy(
    parseArgs(['--env', 'production', '--confirm-production']),
    valuesOf(),
  ).map((step) => step.name);
  assert.ok(names.includes('tests'));
});

test('without a .env (GitHub deploy) the scan runs in --no-env mode', () => {
  const plan = planDeploy(parseArgs(['--env', 'staging']), valuesOf(), { dotenv: false });
  assert.deepEqual(plan.find((step) => step.name === 'check-sensitive')?.args, [
    'tools/check-sensitive.mjs',
    '--no-env',
  ]);
});

test('production needs --confirm-production and uses the custom-domain origin', () => {
  assert.throws(
    () => planDeploy(parseArgs(['--env', 'production']), valuesOf()),
    /--confirm-production/,
  );
  const local = valuesOf({ PUBLIC_ORIGIN: 'http://localhost:5173' });
  const plan = planDeploy(parseArgs(['--env', 'production', '--confirm-production']), local);
  const byName = Object.fromEntries(plan.map((step) => [step.name, step]));
  assert.equal(byName.smoke.origin, PRODUCTION_ORIGIN);
  assert.deepEqual(byName['build-web'].env, { PUBLIC_ORIGIN: PRODUCTION_ORIGIN });
  assert.equal(valuesForDeploy('production', local).get('PUBLIC_ORIGIN'), PRODUCTION_ORIGIN);
  assert.equal(
    valuesForDeploy('staging', local).get('PUBLIC_ORIGIN'),
    'https://fixture-web-staging.fixture-sub.workers.dev',
  );
  assert.equal(local.get('PUBLIC_ORIGIN'), 'http://localhost:5173', 'input map untouched');
  assert.equal(byName['time-travel-bookmark'].args[3], 'fixture-db');
  assert.deepEqual(byName['deploy-web'].args, ['deploy', '--env', 'production']);
  assert.equal(originFor('production', valuesOf()), 'https://open-auri.com');
});

test('planDeploy lists missing keys by name only', () => {
  const values = valuesOf({ CLOUDFLARE_WORKERS_SUBDOMAIN: '', PUBLIC_LGPD_CNPJ: '' });
  values.delete('CLOUDFLARE_ACCOUNT_ID');
  assert.throws(
    () => planDeploy(parseArgs(['--env', 'staging']), values),
    /^Error: Missing environment variables: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_WORKERS_SUBDOMAIN, PUBLIC_LGPD_CNPJ$/,
  );
});

test('plainEnv drops the project keys and keeps the rest', () => {
  assert.deepEqual(
    plainEnv({
      PATH: 'p',
      HOME: 'h',
      PUBLIC_ORIGIN: 'x',
      CLOUDFLARE_API_TOKEN: 'x',
      D1_DATABASE_ID: 'x',
      BETTER_AUTH_SECRET: 'x',
      TURNSTILE_SECRET_KEY: 'x',
      ADMIN_EMAIL: 'x',
      EMAIL_TRANSPORT: 'x',
      SIGNUP_ENABLED: 'x',
      ACCESS_LOG_KEY: 'x',
      BETTER_AUTH_SECRET_STAGING: 'x',
      ACCESS_LOG_KEY_STAGING: 'x',
      IPHASH_PEPPER_STAGING: 'x',
      RESEND_WEBHOOK_SECRET_STAGING: 'x',
      NODE_OPTIONS: 'n',
    }),
    { PATH: 'p', HOME: 'h', NODE_OPTIONS: 'n' },
  );
});

test('parseBookmark accepts only a bookmark-shaped value', () => {
  const stdout = `noise\n${JSON.stringify({ bookmark: BOOKMARK, timestamp: 'x' })}\n`;
  assert.equal(parseBookmark(stdout), BOOKMARK);
  assert.equal(parseBookmark(JSON.stringify({ bookmark: 'user@example.invalid' })), undefined);
  assert.equal(parseBookmark('{"other":1}'), undefined);
  assert.equal(parseBookmark('not json {'), undefined);
});

test('evaluateSmoke checks status, content type and the security headers', () => {
  const [home, , feed, og] = SMOKE_CHECKS;
  assert.deepEqual(evaluateSmoke(home, { status: 200, headers: headersOf(GOOD_HEADERS) }), []);
  assert.deepEqual(evaluateSmoke(og, { status: 404, headers: headersOf({}) }), []);
  assert.deepEqual(evaluateSmoke(feed, { status: 200, headers: headersOf(GOOD_HEADERS) }), []);
  assert.deepEqual(evaluateSmoke(og, { status: 200, headers: headersOf({}) }), [
    '/og/deploy-smoke-unknown.png: expected HTTP 404, got 200',
  ]);
  assert.deepEqual(
    evaluateSmoke(feed, { status: 200, headers: headersOf({ 'content-type': 'text/html' }) }),
    ['/api/v1/feed: expected content-type application/json'],
  );
  const weak = { ...GOOD_HEADERS, 'x-frame-options': 'SAMEORIGIN' };
  delete weak['strict-transport-security'];
  assert.deepEqual(evaluateSmoke(home, { status: 200, headers: headersOf(weak) }), [
    '/: header x-frame-options is not DENY',
    '/: missing header strict-transport-security',
  ]);
});

/**
 * Fake effects recording every call in order.
 * @param {{ whoami?: string, failing?: string, smokeStatus?: number }} options
 */
function fakeDeps(options = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  /** @type {NodeJS.ProcessEnv[]} */
  const envs = [];
  /** @type {NodeJS.ProcessEnv[]} */
  const nodeEnvs = [];
  return {
    calls,
    lines,
    envs,
    nodeEnvs,
    deps: {
      values: valuesOf(),
      root: 'ROOT',
      baseEnv: {
        PATH: 'fixture-path',
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        PUBLIC_LGPD_CNPJ: 'fixture-public_lgpd_cnpj',
        RESEND_API_KEY: 'fixture-resend',
        SIGNUP_ENABLED: 'false',
      },
      sleep: async () => {},
      smokeAttempts: 2,
      log: (/** @type {string} */ line) => lines.push(line),
      render: (/** @type {string} */ dir) => calls.push(`render ${dir}`),
      secrets: async (/** @type {string[]} */ args) => {
        calls.push(`secrets ${args.join(' ')}`);
      },
      wrangler: async (
        /** @type {string[]} */ args,
        /** @type {{ cwd: string, env: NodeJS.ProcessEnv }} */ { cwd, env },
      ) => {
        calls.push(`wrangler ${args.join(' ')} @${cwd}`);
        envs.push(env);
        if (args[0] === 'whoami') {
          return {
            code: 0,
            stdout: options.whoami ?? JSON.stringify({ accounts: [{ id: ACCOUNT }] }),
          };
        }
        if (args[1] === 'time-travel')
          return { code: 0, stdout: JSON.stringify({ bookmark: BOOKMARK }) };
        return { code: options.failing === args[0] ? 1 : 0, stdout: '' };
      },
      tool: async (
        /** @type {'node' | 'vite'} */ program,
        /** @type {string[]} */ args,
        /** @type {{ cwd: string, env: NodeJS.ProcessEnv }} */ { cwd, env },
      ) => {
        calls.push(`${program} ${args.join(' ')} @${cwd}`);
        (program === 'node' ? nodeEnvs : envs).push(env);
        return 0;
      },
      fetch: async (/** @type {string} */ url) => {
        calls.push(`fetch ${url}`);
        const path = new URL(url).pathname;
        const status = path.startsWith('/og/') ? 404 : (options.smokeStatus ?? 200);
        return { status, headers: headersOf(GOOD_HEADERS) };
      },
    },
  };
}

test('runDeploy executes the plan in order and prints the bookmark, never values', async () => {
  const { calls, lines, envs, nodeEnvs, deps } = fakeDeps();
  const result = await runDeploy(['--env', 'staging'], deps);
  assert.equal(result.bookmark, BOOKMARK);
  const web = join('ROOT', 'web');
  const jobs = join('ROOT', 'workers', 'jobs');
  const origin = 'https://fixture-web-staging.fixture-sub.workers.dev';
  assert.deepEqual(calls, [
    `wrangler whoami --json @${web}`,
    `node tools/check-sensitive.mjs @${join('ROOT', '.')}`,
    `node --test test/**/*.test.mjs @${join('ROOT', '.')}`,
    `render ${web}`,
    `vite build @${web}`,
    `node scripts/wrap-worker.mjs @${web}`,
    `render ${web}`,
    `render ${jobs}`,
    'secrets --env staging --worker web',
    'secrets --env staging --worker jobs',
    `wrangler d1 time-travel info fixture-db-staging --env staging --json @${web}`,
    `wrangler d1 migrations apply DB --remote --env staging @${web}`,
    `wrangler deploy --env staging @${web}`,
    `wrangler deploy --env staging @${jobs}`,
    `fetch ${origin}/`,
    `fetch ${origin}/docs`,
    `fetch ${origin}/api/v1/feed`,
    `fetch ${origin}/og/deploy-smoke-unknown.png`,
  ]);
  assert.equal(envs.length, 6); // 5 Wrangler calls + the Vite build
  for (const env of envs) {
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
    assert.equal(env.PATH, 'fixture-path');
  }
  // check-sensitive and the tests never see the project's .env keys.
  assert.equal(nodeEnvs.length, 2);
  for (const env of nodeEnvs) assert.deepEqual(env, { PATH: 'fixture-path' });
  assert.equal(envs.find((env) => env.PUBLIC_ORIGIN)?.PUBLIC_ORIGIN, origin);
  assert.ok(lines.some((line) => line.includes(BOOKMARK)));
  const output = lines.join('\n');
  for (const value of ['fixture-sub', ACCOUNT, 'fixture-public_lgpd_cnpj']) {
    assert.ok(!output.includes(value), value);
  }
});

test('runDeploy stops at the first error', async () => {
  const wrongAccount = fakeDeps({ whoami: JSON.stringify({ accounts: [{ id: 'other' }] }) });
  await assert.rejects(
    runDeploy(['--env', 'staging'], wrongAccount.deps),
    /does not include CLOUDFLARE_ACCOUNT_ID/,
  );
  assert.equal(wrongAccount.calls.length, 1);

  const failedMigration = fakeDeps({ failing: 'd1' });
  // The bookmark step also starts with 'd1' but is answered before the failure switch.
  await assert.rejects(runDeploy(['--env', 'staging'], failedMigration.deps), /migrations failed/);
  assert.ok(!failedMigration.calls.some((call) => call.startsWith('wrangler deploy')));

  const failedSmoke = fakeDeps({ smokeStatus: 500 });
  await assert.rejects(
    runDeploy(['--env', 'staging'], failedSmoke.deps),
    /Smoke failed: \/: expected HTTP 200, got 500/,
  );
  assert.equal(failedSmoke.calls.filter((call) => call.endsWith('.workers.dev/')).length, 2);

  const unconfirmed = fakeDeps();
  await assert.rejects(
    runDeploy(['--env', 'production'], unconfirmed.deps),
    /--confirm-production/,
  );
  assert.deepEqual(unconfirmed.calls, []);
});
