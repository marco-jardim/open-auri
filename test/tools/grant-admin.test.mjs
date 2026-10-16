import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  d1Args,
  grantAdmin,
  grantSql,
  normalizeEmail,
  outcomeSql,
  parseArgs,
  parseOutcome,
} from '../../tools/grant-admin.mjs';
import { RenderError } from '../../tools/render-wrangler.mjs';

const ACCOUNT = 'fixture-account-0001';
const EMAIL = 'Operador.Teste@Example.org';
const AUDIT_ID = '11111111-2222-4333-8444-555555555555';
const USER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USER_ID = USER_UUID.replaceAll('-', '');
const NOW = new Date('2026-10-16T12:00:00Z');

test('parseArgs accepts the documented flags once each', () => {
  assert.deepEqual(parseArgs([]), {
    email: undefined,
    create: false,
    operator: undefined,
    env: undefined,
    local: false,
  });
  assert.deepEqual(
    parseArgs(['--create', '--email', 'a@b.co', '--env', 'staging', '--operator', 'marcos']),
    { email: 'a@b.co', create: true, operator: 'marcos', env: 'staging', local: false },
  );
  assert.equal(parseArgs(['--local']).local, true);
  const bad = [
    ['--email'],
    ['--email', '--create'],
    ['--env', 'dev'],
    ['--create', '--create'],
    ['--email', 'a@b.co', '--email', 'c@d.co'],
    ['--operator', "x'; DROP"],
    ['--role', 'admin'],
  ];
  for (const args of bad) assert.throws(() => parseArgs(args), RenderError);
});

test('normalizeEmail lowercases and rejects anything that could break out of a literal', () => {
  assert.equal(normalizeEmail(`  ${EMAIL} `), 'operador.teste@example.org');
  for (const value of ["o'brien@example.org", 'a@b', 'a b@example.org', 'a@b.co;--', '@x.org']) {
    assert.throws(
      () => normalizeEmail(value),
      (error) => error instanceof RenderError && !error.message.includes(value),
    );
  }
});

test('grantSql: create-if-missing, audit row before the role update, all values quoted', () => {
  const sql = grantSql({
    email: EMAIL,
    create: true,
    userId: USER_ID,
    auditId: AUDIT_ID,
    operator: "o'p",
    now: NOW,
  });
  const statements = sql.trim().replace(/;$/, '').split(';\n');
  assert.equal(statements.length, 3);
  assert.match(statements[0] ?? '', /^INSERT INTO "user" .* WHERE NOT EXISTS/);
  assert.match(
    statements[0] ?? '',
    /'operador\.teste@example\.org', 1, '2026-10-16T12:00:00\.000Z'/,
  );
  assert.match(
    statements[1] ?? '',
    /^INSERT INTO audit_log .*'o''p', 'operator', 'user\.grant_admin'/,
  );
  assert.match(statements[1] ?? '', /json_object\('previousRole'/);
  assert.match(statements[1] ?? '', new RegExp(`${NOW.getTime()} FROM "user"`));
  assert.equal(
    statements[2],
    `UPDATE "user" SET role = 'admin', updatedAt = '2026-10-16T12:00:00.000Z' ` +
      "WHERE email = 'operador.teste@example.org'",
  );

  const plain = grantSql({
    email: EMAIL,
    create: false,
    userId: USER_ID,
    auditId: AUDIT_ID,
    operator: undefined,
    now: NOW,
  });
  assert.equal(plain.trim().split(';\n').length, 2);
  assert.match(plain, /SELECT '11111111-2222-4333-8444-555555555555', NULL, 'operator'/);
  assert.throws(
    () =>
      grantSql({
        email: EMAIL,
        create: false,
        userId: 'x',
        auditId: AUDIT_ID,
        operator: undefined,
        now: NOW,
      }),
    RenderError,
  );
});

test('outcome query and parsing', () => {
  assert.equal(
    outcomeSql(AUDIT_ID),
    `SELECT target_id, detail FROM audit_log WHERE id = '${AUDIT_ID}'`,
  );
  assert.throws(() => outcomeSql("x' OR 1=1"), RenderError);
  assert.deepEqual(parseOutcome([]), { found: false });
  assert.deepEqual(
    parseOutcome([{ target_id: 'u', detail: '{"previousRole":"user","created":true}' }]),
    { found: true, created: true, previousRole: 'user' },
  );
  assert.throws(() => parseOutcome([{ detail: 'nope' }]), RenderError);
  assert.deepEqual(d1Args({ local: true, env: undefined }, ['--json']), [
    'd1',
    'execute',
    'DB',
    '--local',
    '--json',
  ]);
  assert.deepEqual(d1Args({ local: false, env: 'staging' }, []), [
    'd1',
    'execute',
    'DB',
    '--remote',
    '--env',
    'staging',
  ]);
});

/**
 * @param {{ outcome: Record<string, unknown>[], whoami?: string }} options
 */
function fakeWrangler({ outcome, whoami = JSON.stringify({ accounts: [{ id: ACCOUNT }] }) }) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {string[]} */
  const files = [];
  /** @type {import('../../tools/grant-admin.mjs').WranglerRunner} */
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'whoami') return { code: 0, stdout: whoami };
    const fileIndex = args.indexOf('--file');
    if (fileIndex >= 0) {
      files.push(readFileSync(args[fileIndex + 1] ?? '', 'utf8'));
      return { code: 0, stdout: '' };
    }
    return { code: 0, stdout: JSON.stringify([{ results: outcome, success: true }]) };
  };
  return { run, calls, files };
}

function sequence() {
  const ids = [AUDIT_ID, USER_UUID];
  let index = 0;
  return () => ids[index++ % ids.length] ?? AUDIT_ID;
}

test('grantAdmin uses ADMIN_EMAIL, keeps the address out of argv and logs, removes the temp file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grant-test-'));
  try {
    const wrangler = fakeWrangler({
      outcome: [{ target_id: USER_ID, detail: '{"previousRole":"user","created":true}' }],
    });
    /** @type {string[]} */
    const logs = [];
    /** @type {string[]} */
    const temps = [];
    const result = await grantAdmin(['--create'], {
      values: new Map([
        ['CLOUDFLARE_ACCOUNT_ID', ACCOUNT],
        ['ADMIN_EMAIL', EMAIL],
      ]),
      run: wrangler.run,
      render: () => undefined,
      log: (line) => logs.push(line),
      now: () => NOW,
      uuid: sequence(),
      tempDir: () => {
        const created = mkdtempSync(join(dir, 'tmp-'));
        temps.push(created);
        return created;
      },
    });
    assert.deepEqual(result, {
      auditId: AUDIT_ID,
      found: true,
      created: true,
      previousRole: 'user',
    });
    assert.deepEqual(wrangler.calls[0], ['whoami', '--json']);
    assert.deepEqual(wrangler.calls[1]?.slice(0, 5), ['d1', 'execute', 'DB', '--remote', '--yes']);
    assert.match(wrangler.files[0] ?? '', /operador\.teste@example\.org/);
    const argv = wrangler.calls.flat().join(' ');
    assert.doesNotMatch(argv, /example\.org/i);
    assert.match(argv, /--command SELECT target_id, detail FROM audit_log/);
    const printed = logs.join('\n');
    assert.doesNotMatch(printed, /example\.org|operador\.teste/i);
    assert.match(printed, /without a password/);
    assert.match(printed, /\/esqueci-senha/);
    assert.equal(temps.length, 1);
    assert.equal(existsSync(temps[0] ?? dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grantAdmin reports a missing account, an existing admin and local runs', async () => {
  const deps = {
    values: new Map([
      ['CLOUDFLARE_ACCOUNT_ID', ACCOUNT],
      ['ADMIN_EMAIL', EMAIL],
    ]),
    render: () => undefined,
    now: () => NOW,
    uuid: sequence(),
  };
  await assert.rejects(
    grantAdmin([], { ...deps, run: fakeWrangler({ outcome: [] }).run, log: () => undefined }),
    (error) =>
      error instanceof RenderError &&
      /--create/.test(error.message) &&
      !/example/i.test(error.message),
  );

  /** @type {string[]} */
  const logs = [];
  await grantAdmin([], {
    ...deps,
    run: fakeWrangler({ outcome: [{ detail: '{"previousRole":"admin","created":false}' }] }).run,
    log: (line) => logs.push(line),
  });
  assert.match(logs.join('\n'), /already had the admin role/);

  const local = fakeWrangler({ outcome: [{ detail: '{"previousRole":"user","created":false}' }] });
  await grantAdmin(['--local', '--email', 'outra@example.net'], {
    ...deps,
    values: new Map(),
    run: local.run,
    log: () => undefined,
  });
  assert.ok(local.calls.every((args) => args[0] !== 'whoami'));
  assert.ok(local.calls.every((args) => args.includes('--local')));
});

test('grantAdmin stops before touching D1 on a wrong login or missing configuration', async () => {
  const wrangler = fakeWrangler({
    outcome: [],
    whoami: JSON.stringify({ accounts: [{ id: 'someone-else' }] }),
  });
  const base = { run: wrangler.run, render: () => undefined, log: () => undefined };
  await assert.rejects(
    grantAdmin([], {
      ...base,
      values: new Map([
        ['CLOUDFLARE_ACCOUNT_ID', ACCOUNT],
        ['ADMIN_EMAIL', EMAIL],
      ]),
    }),
    /not logged in/,
  );
  assert.deepEqual(wrangler.calls, [['whoami', '--json']]);
  await assert.rejects(grantAdmin([], { ...base, values: new Map() }), /ADMIN_EMAIL/);
  await assert.rejects(
    grantAdmin([], { ...base, values: new Map([['ADMIN_EMAIL', EMAIL]]) }),
    /CLOUDFLARE_ACCOUNT_ID/,
  );
  assert.equal(wrangler.calls.length, 1);
});
