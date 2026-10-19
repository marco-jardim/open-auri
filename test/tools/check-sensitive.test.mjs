import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scanner = fileURLToPath(new URL('../../tools/check-sensitive.mjs', import.meta.url));

function fixture(t, env, files) {
  const root = mkdtempSync(join(tmpdir(), 'sensitive-scanner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe' });
  writeFileSync(join(root, '.gitignore'), '.env\nignored.txt\n');
  if (env !== null) writeFileSync(join(root, '.env'), env);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return {
    root,
    run: (...args) =>
      spawnSync(process.execPath, [scanner, ...args], { cwd: root, encoding: 'utf8' }),
  };
}

test('detects tracked and untracked values case-insensitively without echoing values', (t) => {
  const secret = 'fixture-sensitive-token-987';
  const repo = fixture(t, `PRIVATE_TOKEN="${secret}" # operator value\n`, {
    'tracked.txt': `ordinary text\n${secret.toUpperCase()}\n`,
    'untracked.txt': secret,
    'ignored.txt': secret,
  });
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo.root, stdio: 'pipe' });
  const result = repo.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /tracked\.txt:2: PRIVATE_TOKEN/);
  assert.match(result.stdout, /untracked\.txt:1: PRIVATE_TOKEN/);
  assert.doesNotMatch(result.stdout, /ignored\.txt/);
  assert.ok(!`${result.stdout}${result.stderr}`.toLowerCase().includes(secret.toLowerCase()));
});

test('safelists public repository, worker names and flags, and ignores short or empty values', (t) => {
  const entries = {
    WORKER_NAME_WEB: 'fixture-web-worker',
    WORKER_NAME_JOBS: 'fixture-jobs-worker',
    ACCESS_LOG_ENABLED: 'true',
    SIGNUP_ENABLED: 'false',
    ADMIN_2FA_REQUIRED: 'true',
    PUBLIC_GITHUB_URL: 'https://github.com/fixture/project',
    SHORT_TOKEN: 'abcde',
    EMPTY_TOKEN: '',
  };
  const repo = fixture(
    t,
    Object.entries(entries)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    {
      'safe.txt': Object.values(entries).join('\n'),
    },
  );
  const result = repo.run('--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('derives email domains and workers subdomains and returns label-only JSON', (t) => {
  const email = 'operator@fixture-mail.invalid';
  const repo = fixture(
    t,
    [
      `ADMIN_EMAIL='${email}'`,
      'PUBLIC_ORIGIN=https://app.fixture-team.workers.dev',
      'CLOUDFLARE_WORKERS_SUBDOMAIN=fixture-team',
    ].join('\n'),
    {
      'contact.txt': 'https://FIXTURE-MAIL.INVALID/help\nfixture-team\n',
    },
  );
  const result = repo.run('--json');
  assert.equal(result.status, 1, result.stderr);
  const findings = JSON.parse(result.stdout);
  assert.ok(
    findings.some(
      ({ path, line, label }) =>
        path === 'contact.txt' && line === 1 && label === 'derived:EMAIL_DOMAIN(ADMIN_EMAIL)',
    ),
  );
  assert.ok(
    findings.some(({ line, label }) => line === 2 && label === 'derived:WORKERS_SUBDOMAIN'),
  );
  assert.ok(
    findings.some(({ line, label }) => line === 2 && label === 'CLOUDFLARE_WORKERS_SUBDOMAIN'),
  );
  assert.ok(findings.every((finding) => Object.keys(finding).join(',') === 'path,line,label'));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(email));
});

test('the product domain and its subdomains are public; the sender address stays scanned', (t) => {
  const repo = fixture(t, 'RESEND_FROM=fixture-sender@mail.open-auri.com\n', {
    'docs.txt': 'Envio por mail.open-auri.com, site https://open-auri.com\n',
    'leak.txt': 'fixture-sender@mail.open-auri.com\n',
  });
  const result = repo.run('--json');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { path: 'leak.txt', line: 1, label: 'RESEND_FROM' },
  ]);
});

test('a public mailbox provider domain is not a finding; the full address still is', (t) => {
  const repo = fixture(t, 'ADMIN_EMAIL=fixture.operator@gmail.com\n', {
    'licenses.txt': 'Copyright (c) Someone <someone@gmail.com>\n',
    'leak.txt': 'fixture.operator@gmail.com\n',
  });
  const result = repo.run('--json');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { path: 'leak.txt', line: 1, label: 'ADMIN_EMAIL' },
  ]);
});

test('skips binary files, files larger than 5 MB and ignored files', (t) => {
  const secret = 'fixture-binary-secret-456';
  const repo = fixture(t, `PRIVATE_TOKEN=${secret}\n`, {
    'binary.dat': Buffer.from(`\0${secret}`),
    'large.txt': `${secret}${'x'.repeat(5 * 1024 * 1024)}`,
    'ignored.txt': secret,
  });
  const result = repo.run('--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('derives both Windows user-profile path spellings without echoing them', (t) => {
  const match = homedir().match(/^([A-Za-z]:)[\\/]Users[\\/]([^\\/]+)/i);
  if (!match) return t.skip('Requires a Windows user-profile home directory');
  const backslash = `${match[1]}\\Users\\${match[2]}`;
  const slash = `${match[1]}/Users/${match[2]}`;
  const repo = fixture(t, 'EMPTY_TOKEN=\n', {
    'profiles.txt': `${backslash}\\scratch\n${slash}/scratch\n`,
  });
  const result = repo.run('--json');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { path: 'profiles.txt', line: 1, label: 'derived:WINDOWS_USER_PROFILE' },
    { path: 'profiles.txt', line: 1, label: 'generic:WINDOWS_USER_PROFILE' },
    { path: 'profiles.txt', line: 2, label: 'derived:WINDOWS_USER_PROFILE' },
    { path: 'profiles.txt', line: 2, label: 'generic:WINDOWS_USER_PROFILE' },
  ]);
  assert.ok(!`${result.stdout}${result.stderr}`.toLowerCase().includes(match[2].toLowerCase()));
});

// Built by concatenation so this test file never contains a credential shape itself.
const GENERIC = {
  resend: ['re', '_Fixture1', '_', 'A'.repeat(24)].join(''),
  turnstile: ['0x4', 'AAAAAAA', 'fixture-key-123'].join(''),
  github: ['gh', 'p_', 'f'.repeat(36)].join(''),
  privateKey: ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
  profile: ['C:', '\\Users\\', 'fixtureuser\\scratch'].join(''),
};

test('--no-env works without a .env and scans only the generic shapes', (t) => {
  const envOnly = 'fixture-env-only-value-321';
  const repo = fixture(t, null, {
    'keys.txt': [
      'ordinary text',
      GENERIC.resend,
      GENERIC.turnstile,
      GENERIC.github,
      GENERIC.privateKey,
      GENERIC.profile,
      envOnly,
    ].join('\n'),
    'placeholders.md': 'C:\\Users\\<nome>\nC:\\Users\\Public\\x\nre_...\n<whsec_...>\n',
  });
  const result = repo.run('--no-env', '--json');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { path: 'keys.txt', line: 2, label: 'generic:RESEND_API_KEY' },
    { path: 'keys.txt', line: 3, label: 'generic:TURNSTILE_KEY' },
    { path: 'keys.txt', line: 4, label: 'generic:GITHUB_TOKEN' },
    { path: 'keys.txt', line: 5, label: 'generic:PRIVATE_KEY' },
    { path: 'keys.txt', line: 6, label: 'generic:WINDOWS_USER_PROFILE' },
  ]);
  const output = `${result.stdout}${result.stderr}`;
  for (const value of Object.values(GENERIC)) assert.ok(!output.includes(value));
});

test('--no-env exits 0 on a clean tree, and without the flag a missing .env fails with 2', (t) => {
  const repo = fixture(t, null, { 'clean.txt': 'nothing to see\n' });
  const clean = repo.run('--no-env', '--json');
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(JSON.parse(clean.stdout), []);
  const missing = repo.run('--json');
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /Sensitive-data scan failed/);
});

test('the generic shapes are also scanned when a .env exists', (t) => {
  const repo = fixture(t, 'EMPTY_TOKEN=\n', { 'key.txt': `x\n${GENERIC.github}\n` });
  const result = repo.run('--json');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { path: 'key.txt', line: 2, label: 'generic:GITHUB_TOKEN' },
  ]);
});

test('accepts inline comments and exported or multiline quoted values', (t) => {
  const repo = fixture(
    t,
    'EMPTY_TOKEN=\nexport PRIVATE_TOKEN=fixture-inline-secret # ignored comment\nMULTILINE_TOKEN="fixture-multiline\nsecret-ending"\n',
    {
      'inline.txt': 'fixture-inline-secret',
      'multiline.txt': 'ordinary text\nfixture-multiline\nsecret-ending\n',
      'not-a-secret.txt': 'ignored comment',
    },
  );
  const result = repo.run('--json');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { path: 'inline.txt', line: 1, label: 'PRIVATE_TOKEN' },
    { path: 'multiline.txt', line: 2, label: 'MULTILINE_TOKEN' },
  ]);
});

test('blocks tracked Android secret filenames in any directory, including binary and large files', (t) => {
  const names = {
    'release.jks': 'file:ANDROID_KEYSTORE',
    'nested/release.keystore': 'file:ANDROID_KEYSTORE',
    'nested/keys/export.pepk': 'file:ANDROID_PEPK',
    'nested/keystore.properties': 'file:ANDROID_KEYSTORE_PROPERTIES',
    'google-services.json': 'file:ANDROID_GOOGLE_SERVICES',
    'nested/local.properties': 'file:ANDROID_LOCAL_PROPERTIES',
    'nested/UPPER.JKS': 'file:ANDROID_KEYSTORE',
  };
  const files = Object.fromEntries(
    Object.keys(names).map((path) => [path, Buffer.from([0, 1, 2])]),
  );
  files['nested/keys/export.pepk'] = Buffer.alloc(5 * 1024 * 1024 + 1);
  const repo = fixture(t, null, files);
  // Even an ignored credential accidentally forced into the index must be blocked.
  writeFileSync(join(repo.root, '.gitignore'), '.env\n*.jks\n*.keystore\n*.pepk\n');
  execFileSync('git', ['add', '-f', '--', ...Object.keys(names)], {
    cwd: repo.root,
    stdio: 'pipe',
  });
  const result = repo.run('--no-env', '--json');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    Object.keys(names)
      .sort()
      .map((path) => ({ path, line: 1, label: names[path] })),
  );
  const text = repo.run('--no-env');
  assert.equal(text.status, 1, text.stderr);
  assert.match(text.stdout, /release\.jks:1: file:ANDROID_KEYSTORE/);
  assert.match(text.stdout, /nested\/local\.properties:1: file:ANDROID_LOCAL_PROPERTIES/);
});

test('only exact Android basenames or final extensions are blocked, not example or backup names', (t) => {
  const safe = [
    'keystore.properties.example',
    'nested/google-services.json.example',
    'nested/local.properties.example',
    'release.jks.example',
    'release.keystore.bak',
    'export.pepk.txt',
    'not-keystore.properties',
    'my-local.properties',
    'other-google-services.json',
    'local.properties-dir/README.md',
    'keys.jks/README.md',
  ];
  const repo = fixture(
    t,
    null,
    Object.fromEntries(safe.map((path) => [path, 'fixture placeholder\n'])),
  );
  execFileSync('git', ['add', '--', ...safe], { cwd: repo.root, stdio: 'pipe' });
  const result = repo.run('--no-env', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('Android filenames are also blocked in env mode and for nonignored untracked files', (t) => {
  const repo = fixture(t, 'EMPTY_TOKEN=\n', { 'nested/local.properties': 'fixture setting\n' });
  for (const args of [['--json'], ['--no-env', '--json']]) {
    const result = repo.run(...args);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { path: 'nested/local.properties', line: 1, label: 'file:ANDROID_LOCAL_PROPERTIES' },
    ]);
  }
});
