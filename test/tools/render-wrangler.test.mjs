import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, SECRETS, renderTemplate } from '../../tools/render-wrangler.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

function fixture(t, dotenv) {
  const root = mkdtempSync(join(tmpdir(), 'render-wrangler-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tools'));
  mkdirSync(join(root, 'web'));
  const script = join(root, 'tools', 'render-wrangler.mjs');
  copyFileSync(new URL('../../tools/render-wrangler.mjs', import.meta.url), script);
  if (dotenv !== undefined) writeFileSync(join(root, '.env'), dotenv);
  writeFileSync(
    join(root, 'web', 'template.jsonc'),
    '{"name":"${OA_TEST_WORKER}","label":"${OA_TEST_LABEL}"}\n',
  );
  return {
    root,
    output: join(root, 'web', 'output.jsonc'),
    run: (env = {}, args = ['template.jsonc', 'output.jsonc']) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: join(root, 'web'),
        env: { ...process.env, OA_TEST_WORKER: '', OA_TEST_LABEL: '', ...env },
        encoding: 'utf8',
      }),
    runDotenv: () => {
      const env = { ...process.env };
      delete env.OA_TEST_WORKER;
      delete env.OA_TEST_LABEL;
      return spawnSync(process.execPath, [script, 'template.jsonc', 'output.jsonc'], {
        cwd: join(root, 'web'),
        env,
        encoding: 'utf8',
      });
    },
  };
}

function silent(result, values) {
  assert.equal(result.stdout, '');
  for (const value of values) assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
}

test('reads root .env with CRLF, comments, quotes and equals signs without logging values', (t) => {
  const repo = fixture(
    t,
    '\uFEFF# comment\r\n\r\nOA_TEST_WORKER = "fixture-worker" # comment\r\n' +
      "export OA_TEST_LABEL='fixture=label#kept'\r\nUNUSED=unquoted # comment\r\n",
  );
  const result = repo.runDotenv();
  assert.equal(result.status, 0, result.stderr);
  const output = readFileSync(repo.output, 'utf8');
  assert.ok(output.startsWith('// GENERATED — do not edit; source: template.jsonc\n'));
  assert.deepEqual(JSON.parse(output.split('\n').slice(1).join('\n')), {
    name: 'fixture-worker',
    label: 'fixture=label#kept',
  });
  silent(result, ['fixture-worker', 'fixture=label#kept', 'unquoted']);
});

test('process.env wins and works in CI without a .env file', (t) => {
  for (const dotenv of [undefined, 'OA_TEST_WORKER=from-dotenv\nOA_TEST_LABEL=from-dotenv\n']) {
    const repo = fixture(t, dotenv);
    const result = repo.run({ OA_TEST_WORKER: 'from-ci-worker', OA_TEST_LABEL: 'from-ci-label' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(repo.output, 'utf8'), /from-ci-worker/);
    assert.match(readFileSync(repo.output, 'utf8'), /from-ci-label/);
    silent(result, ['from-ci-worker', 'from-ci-label', 'from-dotenv']);
  }
});

test('escapes values for the JSON string they are placed in', (t) => {
  const repo = fixture(t);
  const tricky = 'fixture "quoted" \\ back\tslash';
  const result = repo.run({ OA_TEST_WORKER: tricky, OA_TEST_LABEL: 'Name <x@example.test>' });
  assert.equal(result.status, 0, result.stderr);
  const output = readFileSync(repo.output, 'utf8');
  assert.deepEqual(JSON.parse(output.split('\n').slice(1).join('\n')), {
    name: tricky,
    label: 'Name <x@example.test>',
  });
  silent(result, [tricky, 'x@example.test']);
});

test('lists only missing names, deduplicated, without partial writes or value leaks', (t) => {
  const repo = fixture(t);
  writeFileSync(
    join(repo.root, 'web', 'template.jsonc'),
    '${OA_TEST_WORKER} ${OA_TEST_MISSING} ${OA_TEST_LABEL} ${OA_TEST_MISSING}',
  );
  const result = repo.run({ OA_TEST_WORKER: 'fixture-private-value-123', OA_TEST_LABEL: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing environment variables: OA_TEST_LABEL, OA_TEST_MISSING/);
  assert.ok(!existsSync(repo.output));
  silent(result, ['fixture-private-value-123']);
});

test('EMAIL_TRANSPORT defaults to resend when missing or empty; an explicit value wins', (t) => {
  assert.deepEqual(DEFAULTS, { EMAIL_TRANSPORT: 'resend' });
  for (const [env, expected] of [
    [{}, 'resend'],
    [{ EMAIL_TRANSPORT: '' }, 'resend'],
    [{ EMAIL_TRANSPORT: 'capture' }, 'capture'],
  ]) {
    const repo = fixture(t);
    writeFileSync(
      join(repo.root, 'web', 'template.jsonc'),
      '{"name":"${OA_TEST_WORKER}","transport":"${EMAIL_TRANSPORT}"}\n',
    );
    const childEnv = { ...process.env, OA_TEST_WORKER: 'w', ...env };
    if (!('EMAIL_TRANSPORT' in env)) delete childEnv.EMAIL_TRANSPORT;
    const result = spawnSync(
      process.execPath,
      [join(repo.root, 'tools', 'render-wrangler.mjs'), 'template.jsonc', 'output.jsonc'],
      { cwd: join(repo.root, 'web'), env: childEnv, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(repo.output, 'utf8');
    assert.equal(JSON.parse(output.split('\n').slice(1).join('\n')).transport, expected);
  }
  // Keys without a default still fail when missing.
  const repo = fixture(t);
  const missing = repo.run({ OA_TEST_WORKER: 'w' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing environment variables: OA_TEST_LABEL/);
});

test('invalid dotenv syntax never echoes its contents', (t) => {
  for (const line of ['fixture-private-value-456', 'OA_TEST_WORKER="fixture-private-value-456']) {
    const repo = fixture(t, line);
    const result = repo.runDotenv();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid .env syntax at line 1/);
    silent(result, ['fixture-private-value-456']);
  }
});

const SECRET_SOURCES = [
  'BETTER_AUTH_SECRET',
  'RESEND_API_KEY',
  'TURNSTILE_SECRET_KEY',
  'IPHASH_PEPPER',
  'ACCESS_LOG_KEY',
  'RESEND_WEBHOOK_SECRET',
];

function runDevVars(repo, args) {
  const env = { ...process.env };
  for (const key of SECRET_SOURCES) delete env[key];
  return spawnSync(
    process.execPath,
    [join(repo.root, 'tools', 'render-wrangler.mjs'), '--dev-vars', ...args],
    { cwd: join(repo.root, 'web'), env, encoding: 'utf8' },
  );
}

const DEV_SECRETS = {
  BETTER_AUTH_SECRET: 'fixture-auth-secret-AAAA',
  RESEND_API_KEY: 're_fixture_key_BBBB',
  TURNSTILE_SECRET_KEY: 'fixture turnstile #CCCC',
  IPHASH_PEPPER: 'fixture-pepper-DDDD',
  ACCESS_LOG_KEY: 'fixture-access-log-EEEE',
};

function dotenvOf(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${value}"`)
    .join('\n');
}

test('--dev-vars writes renamed secrets, skips absent optional ones and never echoes values', (t) => {
  const repo = fixture(t, `OA_UNRELATED=keep-out\n${dotenvOf(DEV_SECRETS)}\n`);
  const result = runDevVars(repo, ['.dev.vars']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Skipped optional secret \(not set\): RESEND_WEBHOOK_SECRET/);
  const written = readFileSync(join(repo.root, 'web', '.dev.vars'), 'utf8');
  assert.ok(written.startsWith('# GENERATED'));
  const lines = written.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(lines, [
    'BETTER_AUTH_SECRET=fixture-auth-secret-AAAA',
    'RESEND_API_KEY=re_fixture_key_BBBB',
    "TURNSTILE_SECRET='fixture turnstile #CCCC'",
    'IPHASH_PEPPER=fixture-pepper-DDDD',
    'ACCESS_LOG_KEY=fixture-access-log-EEEE',
  ]);
  assert.ok(!written.includes('TURNSTILE_SECRET_KEY'));
  assert.ok(!written.includes('keep-out'));
  silent(result, Object.values(DEV_SECRETS));
});

test('--dev-vars includes the optional webhook secret when present and filters by worker', (t) => {
  const repo = fixture(
    t,
    `${dotenvOf({ ...DEV_SECRETS, RESEND_WEBHOOK_SECRET: 'whsec_fixtureFFFF' })}\n`,
  );
  const web = runDevVars(repo, ['.dev.vars']);
  assert.equal(web.status, 0, web.stderr);
  assert.equal(web.stderr, '');
  const webVars = readFileSync(join(repo.root, 'web', '.dev.vars'), 'utf8');
  assert.match(webVars, /^RESEND_WEBHOOK_SECRET=whsec_fixtureFFFF$/m);

  const jobs = runDevVars(repo, ['jobs.vars', '--worker', 'jobs']);
  assert.equal(jobs.status, 0, jobs.stderr);
  const jobsVars = readFileSync(join(repo.root, 'web', 'jobs.vars'), 'utf8');
  const names = jobsVars
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0]);
  assert.deepEqual(names, ['ACCESS_LOG_KEY']);
  silent(web, ['whsec_fixtureFFFF', ...Object.values(DEV_SECRETS)]);
  silent(jobs, Object.values(DEV_SECRETS));
});

test('--dev-vars lists missing required secret names without writing or leaking', (t) => {
  const { BETTER_AUTH_SECRET: _omit, ...partial } = DEV_SECRETS;
  void _omit;
  const repo = fixture(t, `${dotenvOf({ ...partial, IPHASH_PEPPER: '' })}\n`);
  const result = runDevVars(repo, ['.dev.vars']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing environment variables: BETTER_AUTH_SECRET, IPHASH_PEPPER/);
  assert.ok(!existsSync(join(repo.root, 'web', '.dev.vars')));
  silent(result, Object.values(partial).filter(Boolean));
});

test('--dev-vars rejects bad arguments and unsafe values with controlled messages', (t) => {
  const repo = fixture(t, `${dotenvOf(DEV_SECRETS)}\n`);
  for (const args of [[], ['--worker', 'web'], ['.dev.vars', '--worker', 'cron'], ['a', 'b']]) {
    const result = runDevVars(repo, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  const unsafe = fixture(
    t,
    `${dotenvOf({ ...DEV_SECRETS, IPHASH_PEPPER: 'a\'b"c' })}\n`.replace(
      'IPHASH_PEPPER="a\'b"c"',
      'IPHASH_PEPPER=a\'b"c',
    ),
  );
  const result = runDevVars(unsafe, ['.dev.vars']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Secret IPHASH_PEPPER cannot be written to \.dev\.vars safely/);
  silent(result, ['a\'b"c']);
});

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Renders a real template with `fixture:<KEY>` for every placeholder and parses the result.
 * The templates only use full-line `//` comments, so stripping those lines yields JSON.
 */
function renderReal(t, relativePath) {
  const template = join(REPO, relativePath);
  const source = readFileSync(template, 'utf8');
  const keys = [...new Set([...source.matchAll(PLACEHOLDER)].map((match) => match[1]))];
  const dir = mkdtempSync(join(tmpdir(), 'render-real-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'wrangler.jsonc');
  renderTemplate(template, output, new Map(keys.map((key) => [key, `fixture:${key}`])));
  const json = readFileSync(output, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return { source, keys, config: JSON.parse(json) };
}

function documentedKeys() {
  return new Set(
    readFileSync(join(REPO, '.env.example'), 'utf8')
      .split(/\r?\n/)
      .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
      .filter(Boolean),
  );
}

function assertTemplateHygiene(source, keys) {
  // Only ${VAR} placeholders: no literal account/resource IDs (32 hex) or UUIDs.
  assert.doesNotMatch(source, /\b[0-9a-f]{32}\b/i);
  assert.doesNotMatch(source, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  const documented = documentedKeys();
  assert.deepEqual(
    keys.filter((key) => !documented.has(key)),
    [],
    'every placeholder is documented in .env.example',
  );
}

/**
 * Our own console lines stay; the platform's invocation logs (full request URLs, with tokens in
 * the query of e-mailed links) are off and query strings are redacted, in every environment.
 */
const OBSERVABILITY = {
  enabled: true,
  redact_query_string: true,
  logs: { enabled: true, invocation_logs: false },
};

/** Analytics Engine datasets of the METRICS binding (T5.2); web and jobs share them. */
const METRICS_DATASET = 'open_auri_metrics';
const METRICS_STAGING = 'open_auri_metrics_staging';

/**
 * Production custom domain of the web Worker (T5.4b): top level and env.production only. The
 * domain is public (it is the product); its workers.dev host answers 301 to it.
 */
const PRODUCTION_ROUTES = [{ pattern: 'open-auri.com', custom_domain: true }];

/** Static Assets of the web Worker (the adapter's output directory and binding). */
const WEB_ASSETS = { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' };

/**
 * env.production and env.staging (#33): the Worker first on page routes only, i.e. every path but
 * the hashed /_app/* files, the top-level entries of web/static and the generated service worker.
 */
const RUN_WORKER_FIRST = [
  '/*',
  '!/_app/*',
  '!/art/*',
  '!/data/*',
  '!/fonts/*',
  '!/icons/*',
  '!/og-font/*',
  '!/lang-boot.js',
  '!/manifest.webmanifest',
  '!/robots.txt',
  '!/service-worker.js',
  '!/third-party-licenses.txt',
];

/** The run_worker_first exclusion for each top-level entry of web/static (dir/* or the file). */
function staticExclusions() {
  return readdirSync(join(REPO, 'web', 'static'), { withFileTypes: true })
    .map((entry) => (entry.isDirectory() ? `!/${entry.name}/*` : `!/${entry.name}`))
    .sort();
}

/** Bindings the Workers runtime may omit (local dev and tests); declared optional in `Env`. */
const OPTIONAL_BINDINGS = new Set(['METRICS']);

test('web template declares every binding at the top level and in each environment', (t) => {
  const { source, keys, config } = renderReal(t, 'web/wrangler.template.jsonc');
  assertTemplateHygiene(source, keys);
  assert.equal(config.account_id, 'fixture:CLOUDFLARE_ACCOUNT_ID');
  assert.equal(config.compatibility_date, '2026-10-16');
  assert.deepEqual(config.compatibility_flags, ['nodejs_compat', 'nodejs_als']);

  const suffix = { top: '', production: '', staging: '_STAGING' };
  const namespaces = { top: '100', production: '100', staging: '200' };
  const targets = { top: config, production: config.env.production, staging: config.env.staging };
  assert.deepEqual(Object.keys(config.env).sort(), ['production', 'staging']);
  for (const [label, target] of Object.entries(targets)) {
    const s = suffix[label];
    assert.equal(
      target.name,
      label === 'staging' ? 'fixture:WORKER_NAME_WEB-staging' : 'fixture:WORKER_NAME_WEB',
    );
    assert.deepEqual(target.observability, OBSERVABILITY, label);
    assert.deepEqual(target.d1_databases, [
      {
        binding: 'DB',
        database_name: `fixture:D1_DATABASE_NAME${s}`,
        database_id: `fixture:D1_DATABASE_ID${s}`,
        migrations_dir: 'migrations',
      },
    ]);
    assert.deepEqual(target.kv_namespaces, [{ binding: 'CONFIG', id: `fixture:KV_CONFIG_ID${s}` }]);
    assert.deepEqual(target.r2_buckets, [
      { binding: 'MEDIA', bucket_name: `fixture:R2_BUCKET${s}` },
    ]);
    assert.deepEqual(target.queues, {
      producers: [{ binding: 'ACCESS_LOG_QUEUE', queue: `fixture:ACCESS_LOG_QUEUE${s}` }],
    });
    const n = namespaces[label];
    assert.deepEqual(target.ratelimits, [
      { name: 'RL_AUTH', namespace_id: `${n}1`, simple: { limit: 20, period: 60 } },
      { name: 'RL_API', namespace_id: `${n}2`, simple: { limit: 120, period: 60 } },
      { name: 'RL_WRITE', namespace_id: `${n}3`, simple: { limit: 30, period: 60 } },
    ]);
    assert.deepEqual(target.analytics_engine_datasets, [
      { binding: 'METRICS', dataset: label === 'staging' ? METRICS_STAGING : METRICS_DATASET },
    ]);
    assert.deepEqual(Object.keys(target.vars).sort(), [
      'ACCESS_LOG_ENABLED',
      'ADMIN_2FA_REQUIRED',
      'EMAIL_TRANSPORT',
      'GITHUB_URL',
      'PUBLIC_ORIGIN',
      'RESEND_FROM',
      'SIGNUP_ENABLED',
    ]);
    assert.equal(target.vars.GITHUB_URL, 'fixture:PUBLIC_GITHUB_URL');
    assert.equal(target.vars.EMAIL_TRANSPORT, 'fixture:EMAIL_TRANSPORT');
    // env.production serves the custom domain (T5.4b); the top level (wrangler dev, tests) and
    // staging have no route.
    assert.equal(target.workers_dev, true, label);
    if (label === 'production') assert.deepEqual(target.routes, PRODUCTION_ROUTES, label);
    else assert.equal(target.routes, undefined, label);
  }
  // #33: production and staging run the Worker (the canonical-host wrapper written by
  // web/scripts/wrap-worker.mjs) before Static Assets on page routes, so prerendered pages on
  // workers.dev get the 301 (staging exercises the same path; its workers.dev origin passes
  // through); static files (/_app/*, web/static, the service worker) stay assets first, and so
  // does the top level (dev, tests). An env `assets` replaces the top-level one, so binding and
  // directory repeat.
  assert.equal(config.main, '.svelte-kit/cloudflare/_worker.js');
  assert.deepEqual(config.assets, WEB_ASSETS);
  assert.equal(config.assets.run_worker_first, undefined, 'top level keeps assets first');
  for (const label of ['production', 'staging']) {
    assert.deepEqual(
      config.env[label].assets,
      { ...WEB_ASSETS, run_worker_first: RUN_WORKER_FIRST },
      label,
    );
  }
  // Every top-level entry of web/static is excluded (data/ is generated, so it may be absent here).
  const excluded = new Set(RUN_WORKER_FIRST);
  assert.deepEqual(
    staticExclusions().filter((pattern) => !excluded.has(pattern)),
    [],
    'every web/static entry has a run_worker_first exclusion',
  );
  assert.equal(config.vars.PUBLIC_ORIGIN, 'fixture:PUBLIC_ORIGIN');
  assert.equal(
    config.env.staging.vars.PUBLIC_ORIGIN,
    'https://fixture:WORKER_NAME_WEB-staging.fixture:CLOUDFLARE_WORKERS_SUBDOMAIN.workers.dev',
  );
  // Secrets never appear in the template: they go through .dev.vars / wrangler secret.
  for (const spec of SECRETS) assert.ok(!keys.includes(spec.source), spec.source);
});

/** Property names (and optionality) of `export interface Env` in web/src/lib/server/types.ts. */
function handWrittenEnv() {
  const source = readFileSync(join(REPO, 'web', 'src', 'lib', 'server', 'types.ts'), 'utf8');
  const body = /export interface Env \{([\s\S]*?)\n\}/.exec(source)?.[1];
  assert.ok(body, 'web/src/lib/server/types.ts declares `export interface Env`');
  return new Map(
    [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)(\?)?:/gm)].map((match) => [
      match[1],
      match[2] === '?',
    ]),
  );
}

/** Binding and var names a wrangler environment exposes (assets fall back to the top level). */
function exposedNames(target, topLevel) {
  return [
    (target.assets ?? topLevel.assets)?.binding,
    ...(target.d1_databases ?? []).map((entry) => entry.binding),
    ...(target.kv_namespaces ?? []).map((entry) => entry.binding),
    ...(target.r2_buckets ?? []).map((entry) => entry.binding),
    ...(target.queues?.producers ?? []).map((entry) => entry.binding),
    ...(target.ratelimits ?? []).map((entry) => entry.name),
    ...(target.analytics_engine_datasets ?? []).map((entry) => entry.binding),
    ...Object.keys(target.vars ?? {}),
  ]
    .filter(Boolean)
    .sort();
}

test('hand-written web Env matches the template bindings, vars and the secret list', (t) => {
  const { config } = renderReal(t, 'web/wrangler.template.jsonc');
  const env = handWrittenEnv();
  const secrets = new Map(
    SECRETS.filter((spec) => spec.workers.includes('web')).map((spec) => [
      spec.name,
      !spec.required,
    ]),
  );
  const declaredRuntime = [...env.keys()].filter((name) => !secrets.has(name)).sort();
  for (const [label, target] of Object.entries({
    top: config,
    production: config.env.production,
    staging: config.env.staging,
  })) {
    assert.deepEqual(declaredRuntime, exposedNames(target, config), `Env vs ${label}`);
  }
  for (const name of declaredRuntime) {
    const optional = OPTIONAL_BINDINGS.has(name);
    assert.equal(env.get(name), optional, `${name} is ${optional ? 'optional' : 'required'}`);
  }
  for (const [name, optional] of secrets) {
    assert.equal(env.get(name), optional, `secret ${name} declared with matching optionality`);
  }
});

test('jobs template consumes the access-log queue with a DLQ and runs the daily, hourly, quarter-hour and weekly crons', (t) => {
  const { source, keys, config } = renderReal(t, 'workers/jobs/wrangler.template.jsonc');
  assertTemplateHygiene(source, keys);
  assert.equal(config.main, 'src/index.ts');
  assert.equal(config.workers_dev, false);
  const targets = { top: config, production: config.env.production, staging: config.env.staging };
  for (const [label, target] of Object.entries(targets)) {
    const s = label === 'staging' ? '_STAGING' : '';
    assert.equal(
      target.name,
      label === 'staging' ? 'fixture:WORKER_NAME_JOBS-staging' : 'fixture:WORKER_NAME_JOBS',
    );
    assert.deepEqual(target.observability, OBSERVABILITY, label);
    assert.deepEqual(
      target.triggers,
      { crons: ['5 0 * * *', '0 * * * *', '*/15 * * * *', '0 3 * * 1'] },
      label,
    );
    assert.deepEqual(target.limits, { cpu_ms: 60000 }, label);
    assert.deepEqual(
      target.d1_databases.map((db) => [db.binding, db.database_id]),
      [['DB', `fixture:D1_DATABASE_ID${s}`]],
    );
    assert.deepEqual(target.kv_namespaces, [{ binding: 'CONFIG', id: `fixture:KV_CONFIG_ID${s}` }]);
    assert.deepEqual(target.r2_buckets, [
      { binding: 'MEDIA', bucket_name: `fixture:R2_BUCKET${s}` },
    ]);
    assert.deepEqual(target.queues, {
      consumers: [
        {
          queue: `fixture:ACCESS_LOG_QUEUE${s}`,
          dead_letter_queue: `fixture:ACCESS_LOG_DLQ${s}`,
          max_batch_size: 100,
          max_batch_timeout: 30,
        },
      ],
    });
    assert.equal(target.vars.ACCESS_LOG_QUEUE_NAME, `fixture:ACCESS_LOG_QUEUE${s}`);
    assert.deepEqual(target.analytics_engine_datasets, [
      { binding: 'METRICS', dataset: label === 'staging' ? METRICS_STAGING : METRICS_DATASET },
    ]);
  }
  for (const spec of SECRETS) assert.ok(!keys.includes(spec.source), spec.source);
});

test('usage and I/O errors are controlled and never echo environment values', (t) => {
  const repo = fixture(t);
  const env = { OA_TEST_WORKER: 'fixture-private-value-789', OA_TEST_LABEL: 'fixture-label' };
  for (const args of [[], ['absent.jsonc', 'output.jsonc'], ['template.jsonc', 'absent/output']]) {
    const result = repo.run(env, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|Could not read|Could not write/);
    silent(result, Object.values(env));
  }
});
