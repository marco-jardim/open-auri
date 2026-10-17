import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseArgs,
  planSecrets,
  secretPutArgs,
  syncSecrets,
  whoamiIncludesAccount,
} from '../../tools/sync-secrets.mjs';

const ACCOUNT = 'fixture-account-0001';
const SECRET_VALUES = {
  BETTER_AUTH_SECRET: 'fixture-auth-secret-AAAA',
  RESEND_API_KEY: 're_fixture_key_BBBB',
  TURNSTILE_SECRET_KEY: 'fixture-turnstile-CCCC',
  IPHASH_PEPPER: 'fixture-pepper-DDDD',
  ACCESS_LOG_KEY: 'fixture-access-log-EEEE',
};

function valuesOf(extra = {}) {
  return new Map(Object.entries({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, ...SECRET_VALUES, ...extra }));
}

function whoamiJson(...ids) {
  return JSON.stringify({ loggedIn: true, accounts: ids.map((id) => ({ id, name: 'n' })) });
}

test('parseArgs accepts --env and --worker in any order and rejects anything else', () => {
  assert.deepEqual(parseArgs([]), { env: undefined, worker: 'web' });
  assert.deepEqual(parseArgs(['--env', 'staging']), { env: 'staging', worker: 'web' });
  assert.deepEqual(parseArgs(['--worker', 'jobs', '--env', 'production']), {
    env: 'production',
    worker: 'jobs',
  });
  for (const args of [
    ['--env'],
    ['--env', 'dev'],
    ['--worker', 'cron'],
    ['--env', 'staging', '--env', 'production'],
    ['--worker', 'web', '--worker', 'jobs'],
    ['staging'],
    ['--env=staging'],
  ]) {
    assert.throws(() => parseArgs(args), /Usage:/, JSON.stringify(args));
  }
});

test('planSecrets filters by worker, skips absent optional secrets and lists names only', () => {
  assert.deepEqual(planSecrets(valuesOf(), 'web'), {
    uploads: [
      { name: 'BETTER_AUTH_SECRET', source: 'BETTER_AUTH_SECRET' },
      { name: 'RESEND_API_KEY', source: 'RESEND_API_KEY' },
      { name: 'TURNSTILE_SECRET', source: 'TURNSTILE_SECRET_KEY' },
      { name: 'IPHASH_PEPPER', source: 'IPHASH_PEPPER' },
      { name: 'ACCESS_LOG_KEY', source: 'ACCESS_LOG_KEY' },
    ],
    skipped: ['RESEND_WEBHOOK_SECRET'],
    fallbacks: [],
  });
  const withWebhook = planSecrets(valuesOf({ RESEND_WEBHOOK_SECRET: 'whsec_x' }), 'web');
  assert.equal(withWebhook.uploads.at(-1)?.name, 'RESEND_WEBHOOK_SECRET');
  assert.deepEqual(withWebhook.skipped, []);
  assert.deepEqual(planSecrets(valuesOf(), 'jobs'), {
    uploads: [{ name: 'ACCESS_LOG_KEY', source: 'ACCESS_LOG_KEY' }],
    skipped: [],
    fallbacks: [],
  });
});

const STAGING_VALUES = {
  BETTER_AUTH_SECRET_STAGING: 'fixture-auth-staging-FFFF',
  ACCESS_LOG_KEY_STAGING: 'fixture-access-log-staging-GGGG',
  IPHASH_PEPPER_STAGING: 'fixture-pepper-staging-HHHH',
  RESEND_WEBHOOK_SECRET_STAGING: 'whsec_fixture_staging_IIII',
};

test('planSecrets reads <KEY>_STAGING for staging only, for the per-environment secrets', () => {
  const values = valuesOf({ RESEND_WEBHOOK_SECRET: 'whsec_prod', ...STAGING_VALUES });
  assert.deepEqual(planSecrets(values, 'web', 'staging'), {
    uploads: [
      { name: 'BETTER_AUTH_SECRET', source: 'BETTER_AUTH_SECRET_STAGING' },
      { name: 'RESEND_API_KEY', source: 'RESEND_API_KEY' },
      { name: 'TURNSTILE_SECRET', source: 'TURNSTILE_SECRET_KEY' },
      { name: 'IPHASH_PEPPER', source: 'IPHASH_PEPPER_STAGING' },
      { name: 'ACCESS_LOG_KEY', source: 'ACCESS_LOG_KEY_STAGING' },
      { name: 'RESEND_WEBHOOK_SECRET', source: 'RESEND_WEBHOOK_SECRET_STAGING' },
    ],
    skipped: [],
    fallbacks: [],
  });
  assert.deepEqual(planSecrets(values, 'jobs', 'staging').uploads, [
    { name: 'ACCESS_LOG_KEY', source: 'ACCESS_LOG_KEY_STAGING' },
  ]);
  // Production (and the top level) never read the _STAGING keys.
  for (const env of ['production', undefined]) {
    const plan = planSecrets(values, 'web', env);
    assert.ok(
      plan.uploads.every(({ source }) => !source.endsWith('_STAGING')),
      String(env),
    );
    assert.deepEqual(plan.fallbacks, []);
  }
  // A _STAGING key only satisfies a required secret for staging.
  const onlyStaging = valuesOf(STAGING_VALUES);
  onlyStaging.delete('BETTER_AUTH_SECRET');
  const stagingPlan = planSecrets(onlyStaging, 'web', 'staging');
  assert.equal(stagingPlan.uploads[0]?.source, 'BETTER_AUTH_SECRET_STAGING');
  assert.throws(
    () => planSecrets(onlyStaging, 'web', 'production'),
    /^Error: Missing environment variables: BETTER_AUTH_SECRET$/,
  );
});

test('planSecrets lists staging fallbacks to the shared key (names only, empty counts as unset)', () => {
  const values = valuesOf({
    RESEND_WEBHOOK_SECRET: 'whsec_prod',
    IPHASH_PEPPER_STAGING: STAGING_VALUES.IPHASH_PEPPER_STAGING,
    ACCESS_LOG_KEY_STAGING: '',
  });
  const plan = planSecrets(values, 'web', 'staging');
  assert.deepEqual(plan.fallbacks, [
    'BETTER_AUTH_SECRET',
    'ACCESS_LOG_KEY',
    'RESEND_WEBHOOK_SECRET',
  ]);
  const accessLog = plan.uploads.find(({ name }) => name === 'ACCESS_LOG_KEY');
  assert.equal(accessLog?.source, 'ACCESS_LOG_KEY');
  // An absent optional secret is skipped, not a fallback.
  const bare = planSecrets(valuesOf(), 'web', 'staging');
  assert.deepEqual(bare.skipped, ['RESEND_WEBHOOK_SECRET']);
  assert.ok(!bare.fallbacks.includes('RESEND_WEBHOOK_SECRET'));
});

test('syncSecrets uploads the _STAGING values to staging and never prints them', async () => {
  const { calls, lines, deps } = fakeDeps();
  for (const [key, value] of Object.entries(STAGING_VALUES)) deps.values.set(key, value);
  await syncSecrets(['--env', 'staging'], deps);
  const puts = calls.filter((call) => call.args?.[0] === 'secret');
  const inputs = Object.fromEntries(puts.map((call) => [call.args?.[2], call.input]));
  assert.equal(inputs.BETTER_AUTH_SECRET, STAGING_VALUES.BETTER_AUTH_SECRET_STAGING);
  assert.equal(inputs.IPHASH_PEPPER, STAGING_VALUES.IPHASH_PEPPER_STAGING);
  assert.equal(inputs.ACCESS_LOG_KEY, STAGING_VALUES.ACCESS_LOG_KEY_STAGING);
  assert.equal(inputs.RESEND_WEBHOOK_SECRET, STAGING_VALUES.RESEND_WEBHOOK_SECRET_STAGING);
  assert.equal(inputs.RESEND_API_KEY, SECRET_VALUES.RESEND_API_KEY);
  assert.ok(!lines.some((line) => line.startsWith('Warning:')));
  for (const value of [...Object.values(SECRET_VALUES), ...Object.values(STAGING_VALUES)]) {
    assert.ok(!lines.join('\n').includes(value));
  }
});

test('planSecrets reports missing required secrets by .env name without values', () => {
  const values = valuesOf({ RESEND_API_KEY: '' });
  values.delete('TURNSTILE_SECRET_KEY');
  assert.throws(
    () => planSecrets(values, 'web'),
    (error) => {
      assert.equal(
        error.message,
        'Missing environment variables: RESEND_API_KEY, TURNSTILE_SECRET_KEY',
      );
      for (const value of Object.values(SECRET_VALUES)) assert.ok(!error.message.includes(value));
      return true;
    },
  );
});

test('secretPutArgs targets the top level or a named environment', () => {
  assert.deepEqual(secretPutArgs('IPHASH_PEPPER', undefined), ['secret', 'put', 'IPHASH_PEPPER']);
  assert.deepEqual(secretPutArgs('IPHASH_PEPPER', 'staging'), [
    'secret',
    'put',
    'IPHASH_PEPPER',
    '--env',
    'staging',
  ]);
});

test('whoamiIncludesAccount requires the exact account id in the JSON account list', () => {
  assert.equal(whoamiIncludesAccount(whoamiJson('other', ACCOUNT), ACCOUNT), true);
  assert.equal(whoamiIncludesAccount(`banner\n${whoamiJson(ACCOUNT)}\n`, ACCOUNT), true);
  assert.equal(whoamiIncludesAccount(whoamiJson('other'), ACCOUNT), false);
  assert.equal(whoamiIncludesAccount(whoamiJson(`${ACCOUNT}-x`), ACCOUNT), false);
  assert.equal(whoamiIncludesAccount(whoamiJson(ACCOUNT), ''), false);
  assert.equal(whoamiIncludesAccount('{"accounts":"nope"}', ACCOUNT), false);
  assert.equal(whoamiIncludesAccount(`{"loggedIn":false}`, ACCOUNT), false);
  assert.equal(whoamiIncludesAccount('{not json', ACCOUNT), false);
  assert.equal(whoamiIncludesAccount('', ACCOUNT), false);
});

function fakeDeps({ whoami = { code: 0, stdout: whoamiJson(ACCOUNT) }, failPut } = {}) {
  /** @type {{ kind: string, args?: string[], cwd?: string, input?: string, account?: string }[]} */
  const calls = [];
  const lines = [];
  return {
    calls,
    lines,
    deps: {
      values: valuesOf(),
      root: join('repo-root'),
      baseEnv: { PATH: 'fixture-path' },
      render: (workerDir) => calls.push({ kind: 'render', cwd: workerDir }),
      log: (line) => lines.push(line),
      run: async (args, { cwd, env, input }) => {
        calls.push({ kind: 'run', args, cwd, input, account: env.CLOUDFLARE_ACCOUNT_ID });
        assert.equal(env.PATH, 'fixture-path');
        if (args[0] === 'whoami') return whoami;
        return { code: args[2] === failPut ? 1 : 0, stdout: '' };
      },
    },
  };
}

test('syncSecrets renders, verifies the account, then pipes each value on stdin', async () => {
  const { calls, lines, deps } = fakeDeps();
  await syncSecrets(['--env', 'staging'], deps);
  assert.deepEqual(calls[0], { kind: 'render', cwd: join('repo-root', 'web') });
  assert.deepEqual(calls[1].args, ['whoami', '--json']);
  assert.equal(calls[1].input, undefined);
  const puts = calls.slice(2);
  assert.deepEqual(
    puts.map((call) => [call.args, call.input, call.account, call.cwd]),
    [
      ['BETTER_AUTH_SECRET', 'BETTER_AUTH_SECRET'],
      ['RESEND_API_KEY', 'RESEND_API_KEY'],
      ['TURNSTILE_SECRET', 'TURNSTILE_SECRET_KEY'],
      ['IPHASH_PEPPER', 'IPHASH_PEPPER'],
      ['ACCESS_LOG_KEY', 'ACCESS_LOG_KEY'],
    ].map(([name, source]) => [
      ['secret', 'put', name, '--env', 'staging'],
      SECRET_VALUES[source],
      ACCOUNT,
      join('repo-root', 'web'),
    ]),
  );
  assert.deepEqual(lines, [
    'Skipped optional secret (not set): RESEND_WEBHOOK_SECRET',
    'Warning: BETTER_AUTH_SECRET_STAGING is not set; staging uses the same BETTER_AUTH_SECRET as production',
    'Warning: IPHASH_PEPPER_STAGING is not set; staging uses the same IPHASH_PEPPER as production',
    'Warning: ACCESS_LOG_KEY_STAGING is not set; staging uses the same ACCESS_LOG_KEY as production',
    'Uploaded secret BETTER_AUTH_SECRET to web (staging)',
    'Uploaded secret RESEND_API_KEY to web (staging)',
    'Uploaded secret TURNSTILE_SECRET to web (staging)',
    'Uploaded secret IPHASH_PEPPER to web (staging)',
    'Uploaded secret ACCESS_LOG_KEY to web (staging)',
  ]);
  for (const value of Object.values(SECRET_VALUES)) {
    assert.ok(!lines.join('\n').includes(value));
  }
});

test('syncSecrets targets the jobs Worker directory and the top level without --env', async () => {
  const { calls, lines, deps } = fakeDeps();
  await syncSecrets(['--worker', 'jobs'], deps);
  assert.deepEqual(calls[0], { kind: 'render', cwd: join('repo-root', 'workers', 'jobs') });
  assert.deepEqual(calls[2].args, ['secret', 'put', 'ACCESS_LOG_KEY']);
  assert.deepEqual(lines, ['Uploaded secret ACCESS_LOG_KEY to jobs (top level)']);
});

test('syncSecrets aborts before any upload when the account cannot be verified', async () => {
  for (const [whoami, pattern] of [
    [{ code: 1, stdout: '' }, /not authenticated/],
    [{ code: 0, stdout: whoamiJson('someone-else') }, /does not include CLOUDFLARE_ACCOUNT_ID/],
  ]) {
    const { calls, deps } = fakeDeps({ whoami });
    await assert.rejects(syncSecrets([], deps), pattern);
    assert.ok(!calls.some((call) => call.args?.[0] === 'secret'));
  }
  const { calls, deps } = fakeDeps();
  deps.values.delete('CLOUDFLARE_ACCOUNT_ID');
  await assert.rejects(
    syncSecrets([], deps),
    /Missing environment variables: CLOUDFLARE_ACCOUNT_ID/,
  );
  assert.deepEqual(calls, []);
});

test('syncSecrets stops at the first failed upload and names only the secret', async () => {
  const { calls, deps } = fakeDeps({ failPut: 'TURNSTILE_SECRET' });
  await assert.rejects(
    syncSecrets([], deps),
    /^Error: wrangler secret put failed for TURNSTILE_SECRET on web \(top level\)$/,
  );
  assert.equal(calls.filter((call) => call.args?.[0] === 'secret').length, 3);
});

const FAKE_WRANGLER = `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
if (args[0] === 'whoami') {
  process.stdout.write(JSON.stringify({ loggedIn: true, accounts: [{ id: process.env.FAKE_ACCOUNT }] }));
} else {
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, cwd: process.cwd() }) + '\\n');
  // A real Wrangler may print details; the script must never forward them.
  process.stdout.write('echo ' + input);
  process.stderr.write('echo ' + input);
}
`;

function cliFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sync-secrets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tools'));
  mkdirSync(join(root, 'web'));
  for (const name of ['render-wrangler.mjs', 'sync-secrets.mjs']) {
    copyFileSync(new URL(`../../tools/${name}`, import.meta.url), join(root, 'tools', name));
  }
  const dotenv = {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    WORKER_NAME_WEB: 'fixture-web',
    ...SECRET_VALUES,
  };
  writeFileSync(
    join(root, '.env'),
    Object.entries(dotenv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  writeFileSync(join(root, 'web', 'wrangler.template.jsonc'), '{"name":"${WORKER_NAME_WEB}"}\n');
  writeFileSync(join(root, 'fake-wrangler.mjs'), FAKE_WRANGLER);
  const log = join(root, 'calls.log');
  const run = (fakeAccount, args) => {
    const env = { ...process.env };
    for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'WORKER_NAME_WEB', 'RESEND_WEBHOOK_SECRET']) {
      delete env[key];
    }
    for (const key of Object.keys(SECRET_VALUES)) delete env[key];
    return spawnSync(process.execPath, [join(root, 'tools', 'sync-secrets.mjs'), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...env,
        OPEN_AURI_WRANGLER_BIN: join(root, 'fake-wrangler.mjs'),
        FAKE_ACCOUNT: fakeAccount,
        FAKE_LOG: log,
      },
    });
  };
  return { root, log, run };
}

test('CLI pipes values to Wrangler stdin and prints only secret names', (t) => {
  const repo = cliFixture(t);
  const result = repo.run(ACCOUNT, ['--env', 'production']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Skipped optional secret \(not set\): RESEND_WEBHOOK_SECRET/);
  assert.match(result.stdout, /Uploaded secret TURNSTILE_SECRET to web \(production\)/);
  for (const value of [ACCOUNT, ...Object.values(SECRET_VALUES)]) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes(value), 'no value is printed');
  }
  const calls = readFileSync(repo.log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((call) => [call.args.join(' '), call.input]),
    [
      ['secret put BETTER_AUTH_SECRET --env production', SECRET_VALUES.BETTER_AUTH_SECRET],
      ['secret put RESEND_API_KEY --env production', SECRET_VALUES.RESEND_API_KEY],
      ['secret put TURNSTILE_SECRET --env production', SECRET_VALUES.TURNSTILE_SECRET_KEY],
      ['secret put IPHASH_PEPPER --env production', SECRET_VALUES.IPHASH_PEPPER],
      ['secret put ACCESS_LOG_KEY --env production', SECRET_VALUES.ACCESS_LOG_KEY],
    ],
  );
  assert.match(readFileSync(join(repo.root, 'web', 'wrangler.jsonc'), 'utf8'), /fixture-web/);
});

test('CLI exits non-zero without uploading when the login lacks the account', (t) => {
  const repo = cliFixture(t);
  const result = repo.run('another-account', []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not include CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(result.stdout, '');
  assert.throws(() => readFileSync(repo.log, 'utf8'), { code: 'ENOENT' });
  for (const value of [ACCOUNT, ...Object.values(SECRET_VALUES)]) {
    assert.ok(!result.stderr.includes(value));
  }
});

test('CLI rejects bad arguments with the usage line', (t) => {
  const repo = cliFixture(t);
  const result = repo.run(ACCOUNT, ['--env', 'dev']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Usage: node tools\/sync-secrets\.mjs/);
});
