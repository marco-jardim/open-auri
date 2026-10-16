import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
    force: false,
    operator: undefined,
    env: undefined,
    local: false,
  });
  assert.deepEqual(
    parseArgs(['--create', '--email', 'a@b.co', '--env', 'staging', '--operator', 'marcos']),
    {
      email: 'a@b.co',
      create: true,
      force: false,
      operator: 'marcos',
      env: 'staging',
      local: false,
    },
  );
  assert.equal(parseArgs(['--local']).local, true);
  assert.equal(parseArgs(['--force']).force, true);
  const bad = [
    ['--email'],
    ['--email', '--create'],
    ['--env', 'dev'],
    ['--create', '--create'],
    ['--force', '--force'],
    ['--force', 'yes'],
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
  assert.equal(statements.length, 4);
  assert.match(statements[0] ?? '', /^INSERT INTO "user" .* WHERE NOT EXISTS/);
  assert.match(
    statements[0] ?? '',
    /'operador\.teste@example\.org', 1, '2026-10-16T12:00:00\.000Z'/,
  );
  assert.match(
    statements[1] ?? '',
    /^INSERT INTO audit_log .*'o''p', 'operator', CASE WHEN "emailVerified" = 1 THEN 'user\.grant_admin' ELSE 'user\.grant_admin\.refused' END/,
  );
  assert.match(statements[1] ?? '', /json_object\('previousRole'/);
  assert.match(statements[1] ?? '', /'granted', CASE WHEN "emailVerified" = 1 THEN json\('true'\)/);
  assert.match(statements[1] ?? '', /'forced', json\('false'\)/);
  assert.match(
    statements[1] ?? '',
    /'sessionsRevoked', CASE WHEN .*SELECT COUNT\(\*\) FROM "session"/,
  );
  assert.match(statements[1] ?? '', new RegExp(`${NOW.getTime()} FROM "user"`));
  // Sessions go before the role changes, and only for a verified, not-yet-admin account.
  assert.equal(
    statements[2],
    'DELETE FROM "session" WHERE "userId" IN (SELECT id FROM "user" WHERE ' +
      'email = \'operador.teste@example.org\' AND "emailVerified" = 1 AND ' +
      "COALESCE(role, 'user') <> 'admin')",
  );
  assert.equal(
    statements[3],
    `UPDATE "user" SET role = 'admin', updatedAt = '2026-10-16T12:00:00.000Z' ` +
      'WHERE email = \'operador.teste@example.org\' AND "emailVerified" = 1',
  );

  const plain = grantSql({
    email: EMAIL,
    create: false,
    userId: USER_ID,
    auditId: AUDIT_ID,
    operator: undefined,
    now: NOW,
  });
  assert.equal(plain.trim().split(';\n').length, 3);
  assert.match(plain, /SELECT '11111111-2222-4333-8444-555555555555', NULL, 'operator'/);

  // --force drops the verified condition and records it.
  const forced = grantSql({
    email: EMAIL,
    create: false,
    force: true,
    userId: USER_ID,
    auditId: AUDIT_ID,
    operator: undefined,
    now: NOW,
  });
  assert.doesNotMatch(forced, /WHERE email = '[^']*' AND "emailVerified" = 1/);
  assert.match(forced, /'forced', json\('true'\)/);
  assert.match(forced, /CASE WHEN 1 THEN 'user\.grant_admin'/);
  assert.match(forced, /WHERE email = 'operador\.teste@example\.org' AND 1;\n$/);
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
    parseOutcome([
      {
        target_id: 'u',
        detail:
          '{"previousRole":"user","created":true,"emailVerified":true,"forced":false,' +
          '"granted":true,"sessionsRevoked":2}',
      },
    ]),
    {
      found: true,
      created: true,
      previousRole: 'user',
      emailVerified: true,
      forced: false,
      granted: true,
      sessionsRevoked: 2,
    },
  );
  // Strict: a detail without an explicit "granted": true means nothing was granted.
  assert.equal(parseOutcome([{ detail: '{"previousRole":"user"}' }]).found, true);
  assert.deepEqual(parseOutcome([{ detail: '{"previousRole":"user","sessionsRevoked":"x"}' }]), {
    found: true,
    created: false,
    previousRole: 'user',
    emailVerified: false,
    forced: false,
    granted: false,
    sessionsRevoked: 0,
  });
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

/** Audit detail as grantSql writes it (granted, verified, not forced unless overridden). */
function detailOf(overrides = {}) {
  return JSON.stringify({
    previousRole: 'user',
    created: false,
    emailVerified: true,
    forced: false,
    granted: true,
    sessionsRevoked: 0,
    ...overrides,
  });
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
      outcome: [
        {
          target_id: USER_ID,
          detail: detailOf({ created: true, sessionsRevoked: 0 }),
        },
      ],
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
      emailVerified: true,
      forced: false,
      granted: true,
      sessionsRevoked: 0,
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
    run: fakeWrangler({ outcome: [{ detail: detailOf({ previousRole: 'admin' }) }] }).run,
    log: (line) => logs.push(line),
  });
  assert.match(logs.join('\n'), /already had the admin role/);

  const local = fakeWrangler({ outcome: [{ detail: detailOf() }] });
  await grantAdmin(['--local', '--email', 'outra@example.net'], {
    ...deps,
    values: new Map(),
    run: local.run,
    log: () => undefined,
  });
  assert.ok(local.calls.every((args) => args[0] !== 'whoami'));
  assert.ok(local.calls.every((args) => args.includes('--local')));
});

test('grantAdmin refuses an unverified account unless --force, and revokes sessions on a grant', async () => {
  const deps = {
    values: new Map([
      ['CLOUDFLARE_ACCOUNT_ID', ACCOUNT],
      ['ADMIN_EMAIL', EMAIL],
    ]),
    render: () => undefined,
    now: () => NOW,
    uuid: sequence(),
  };
  const refused = fakeWrangler({
    outcome: [{ detail: detailOf({ emailVerified: false, granted: false }) }],
  });
  /** @type {string[]} */
  const refusedLogs = [];
  await assert.rejects(
    grantAdmin([], { ...deps, run: refused.run, log: (line) => refusedLogs.push(line) }),
    (error) =>
      error instanceof RenderError &&
      /not verified; nothing changed/.test(error.message) &&
      /--force/.test(error.message) &&
      !/example|operador/i.test(error.message),
  );
  assert.deepEqual(refusedLogs, []);
  assert.doesNotMatch(refused.files[0] ?? '', /'forced', json\('true'\)/);

  // Re-run on an account that is already admin, address unverified, no --force: "already admin",
  // not "not verified; nothing changed", with the pointer to the /conta 2FA section.
  /** @type {string[]} */
  const againLogs = [];
  const again = await grantAdmin([], {
    ...deps,
    run: fakeWrangler({
      outcome: [
        { detail: detailOf({ previousRole: 'admin', emailVerified: false, granted: false }) },
      ],
    }).run,
    log: (line) => againLogs.push(line),
  });
  assert.equal(again.previousRole, 'admin');
  assert.equal(again.granted, false);
  const againPrinted = againLogs.join('\n');
  assert.match(againPrinted, /already had the admin role/);
  assert.match(againPrinted, /\/conta#duas-etapas/);
  assert.doesNotMatch(againPrinted, /not verified|Granted|session\(s\) deleted|example|operador/i);

  // A verified account: granted, sessions revoked, guidance to reset the password.
  /** @type {string[]} */
  const logs = [];
  await grantAdmin([], {
    ...deps,
    run: fakeWrangler({ outcome: [{ detail: detailOf({ sessionsRevoked: 3 }) }] }).run,
    log: (line) => logs.push(line),
  });
  const printed = logs.join('\n');
  assert.match(printed, /Granted the admin role/);
  assert.match(printed, /3 session\(s\) deleted/);
  assert.match(printed, /\/esqueci-senha \("esqueci a senha"\)/);
  assert.doesNotMatch(printed, /NOT verified/);

  // --force: the SQL drops the verified condition and the run says so.
  const forced = fakeWrangler({
    outcome: [{ detail: detailOf({ emailVerified: false, forced: true, sessionsRevoked: 1 }) }],
  });
  /** @type {string[]} */
  const forcedLogs = [];
  const result = await grantAdmin(['--force'], {
    ...deps,
    run: forced.run,
    log: (line) => forcedLogs.push(line),
  });
  assert.equal(result.granted, true);
  assert.match(forced.files[0] ?? '', /'forced', json\('true'\)/);
  assert.match(forcedLogs.join('\n'), /--force: the e-mail address was NOT verified/);
  assert.doesNotMatch(forcedLogs.join('\n'), /example\.org|operador\.teste/i);
});

/** `node:sqlite` when available (unflagged from Node 22.13); the semantic test skips otherwise. */
async function openSqlite() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(':memory:');
  } catch {
    return null;
  }
}

test('grantSql against the real schema: refuses unverified, revokes sessions, audits', async (t) => {
  const db = await openSqlite();
  if (!db) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const migrations = fileURLToPath(new URL('../../web/migrations/', import.meta.url));
  db.exec(readFileSync(join(migrations, '0001_auth.sql'), 'utf8'));
  db.exec(readFileSync(join(migrations, '0003_admin.sql'), 'utf8'));
  const iso = NOW.toISOString();
  const addUser = (/** @type {string} */ id, /** @type {string} */ email, verified = 1) =>
    db
      .prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) ' +
          "VALUES (?, 'n', ?, ?, ?, ?, 'user')",
      )
      .run(id, email, verified, iso, iso);
  const addSession = (/** @type {string} */ id, /** @type {string} */ userId) =>
    db
      .prepare(
        'INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, iso, `token-${id}`, iso, iso, userId);
  const role = (/** @type {string} */ id) =>
    /** @type {{ role: string }} */ (db.prepare('SELECT role FROM "user" WHERE id = ?').get(id))
      .role;
  const sessions = (/** @type {string} */ userId) =>
    /** @type {{ n: number }} */ (
      db.prepare('SELECT COUNT(*) AS n FROM "session" WHERE userId = ?').get(userId)
    ).n;
  const audit = (/** @type {string} */ id) => {
    const row = /** @type {{ action: string, detail: string }} */ (
      db.prepare('SELECT action, detail FROM audit_log WHERE id = ?').get(id)
    );
    return { action: row.action, detail: JSON.parse(row.detail) };
  };
  let ids = 0;
  const auditId = () => `11111111-2222-4333-8444-${String(++ids).padStart(12, '0')}`;
  const run = (/** @type {string} */ email, force = false) => {
    const id = auditId();
    db.exec(
      grantSql({
        email,
        create: false,
        force,
        userId: USER_ID,
        auditId: id,
        operator: 'op',
        now: NOW,
      }),
    );
    return id;
  };

  addUser('unverified', 'squatter@example.org', 0);
  addSession('s1', 'unverified');
  const refused = run('squatter@example.org');
  assert.equal(role('unverified'), 'user');
  assert.equal(sessions('unverified'), 1);
  assert.deepEqual(audit(refused), {
    action: 'user.grant_admin.refused',
    detail: {
      previousRole: 'user',
      created: false,
      emailVerified: false,
      forced: false,
      granted: false,
      sessionsRevoked: 0,
    },
  });

  const forced = run('squatter@example.org', true);
  assert.equal(role('unverified'), 'admin');
  assert.equal(sessions('unverified'), 0);
  assert.equal(audit(forced).action, 'user.grant_admin');
  assert.deepEqual(audit(forced).detail, {
    previousRole: 'user',
    created: false,
    emailVerified: false,
    forced: true,
    granted: true,
    sessionsRevoked: 1,
  });

  addUser('verified', 'owner@example.org');
  addUser('other', 'other@example.org');
  addSession('s2', 'verified');
  addSession('s3', 'verified');
  addSession('s4', 'other');
  const granted = run('owner@example.org');
  assert.equal(role('verified'), 'admin');
  assert.equal(sessions('verified'), 0);
  assert.equal(sessions('other'), 1);
  assert.equal(audit(granted).detail.sessionsRevoked, 2);

  // Already admin: sessions are left alone (nothing new is granted).
  addSession('s5', 'verified');
  const again = run('owner@example.org');
  assert.equal(sessions('verified'), 1);
  assert.deepEqual(
    [audit(again).detail.previousRole, audit(again).detail.sessionsRevoked],
    ['admin', 0],
  );
  db.close();
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
