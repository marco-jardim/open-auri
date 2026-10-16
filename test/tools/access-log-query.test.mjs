import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  auditRequestSql,
  decryptLines,
  exportedCountSql,
  indexQuerySql,
  insertRequestSql,
  lineInWindow,
  objectInWindow,
  parseArgs,
  parseD1Rows,
  queryAccessLog,
  sqlString,
  toIndexRows,
} from '../../tools/access-log-query.mjs';
import { createAccessLogCrypto } from '../../workers/jobs/src/jobs/access-log-crypto.js';
import { RenderError } from '../../tools/render-wrangler.mjs';

const KEYRING = `k2:${'n'.repeat(40)},k1:${'o'.repeat(40)}`;
const ACCOUNT = 'fixture-account-0001';
const ID_A = '11111111-2222-3333-4444-555555555555';
const ID_B = '66666666-7777-8888-9999-000000000000';
const BASE_ARGS = [
  '--case',
  'Processo 0001234-56.2026.8.26.0100',
  '--from',
  '2026-10-16T13:30:00Z',
  '--to',
  '2026-10-16T14:15:00-00:00',
  '--operator',
  'operador',
];

test('parseArgs requires case, window, operator and output, with explicit offsets', () => {
  const parsed = parseArgs([...BASE_ARGS, '--out', 'x.ndjson']);
  assert.equal(parsed.caseRef, 'Processo 0001234-56.2026.8.26.0100');
  assert.equal(parsed.from.toISOString(), '2026-10-16T13:30:00.000Z');
  assert.equal(parsed.to.toISOString(), '2026-10-16T14:15:00.000Z');
  assert.equal(parsed.env, undefined);
  assert.equal(parseArgs([...BASE_ARGS, '--out', 'x', '--env', 'staging']).env, 'staging');

  const bad = [
    BASE_ARGS,
    [...BASE_ARGS, '--out'],
    [...BASE_ARGS, '--out', 'x', '--env', 'dev'],
    [...BASE_ARGS, '--out', 'x', '--extra', '1'],
    [...BASE_ARGS, '--out', 'x', '--case', 'twice'],
    ['--case', "x'); DROP TABLE t; --", ...BASE_ARGS.slice(2), '--out', 'x'],
    [...BASE_ARGS.slice(0, 3), '2026-10-16T13:30:00', ...BASE_ARGS.slice(4), '--out', 'x'],
    [...BASE_ARGS.slice(0, 5), '2026-10-16T13:00:00Z', ...BASE_ARGS.slice(6), '--out', 'x'],
  ];
  for (const args of bad) assert.throws(() => parseArgs(args), RenderError);
});

test('SQL builders quote every value', () => {
  assert.equal(sqlString("O'Brien"), "'O''Brien'");
  const insert = insertRequestSql({
    id: ID_A,
    caseRef: 'Ofício nº 12/2026',
    from: new Date('2026-10-16T13:30:00Z'),
    to: new Date('2026-10-16T14:15:00Z'),
    requestedAt: new Date('2026-10-20T10:00:00Z'),
    operator: 'operador',
  });
  assert.match(insert, /^INSERT INTO access_log_requests \(id, case_ref, window_from/);
  assert.match(insert, /'Ofício nº 12\/2026'/);
  assert.equal(
    indexQuerySql(new Date('2026-10-16T13:30:00Z'), new Date('2026-10-17T01:00:00Z')),
    'SELECT object_key, day, hour FROM access_log_objects ' +
      "WHERE day >= '2026-10-16' AND day <= '2026-10-17' ORDER BY day, hour, object_key",
  );
  assert.equal(
    exportedCountSql(ID_A, 3),
    `UPDATE access_log_requests SET exported_count = 3 WHERE id = '${ID_A}'`,
  );
  assert.throws(() => exportedCountSql(ID_A, -1), RenderError);
});

test('auditRequestSql mirrors the request into audit_log without the case reference', () => {
  const sql = auditRequestSql({
    id: ID_A,
    from: new Date('2026-10-16T13:30:00Z'),
    to: new Date('2026-10-16T14:15:00Z'),
    requestedAt: new Date('2026-10-20T10:00:00Z'),
    operator: "o'perador",
  });
  assert.equal(
    sql,
    'INSERT INTO audit_log (id, actor_id, actor_kind, action, target_kind, target_id, detail, created_at) ' +
      `VALUES ('${ID_A}', 'o''perador', 'operator', 'access_log.query', 'access_log_request', '${ID_A}', ` +
      `'{"requestId":"${ID_A}","windowFrom":"2026-10-16T13:30:00.000Z","windowTo":"2026-10-16T14:15:00.000Z"}', ` +
      `${Date.parse('2026-10-20T10:00:00Z')})`,
  );
  assert.doesNotMatch(sql, /Processo|Ofício/);
  assert.throws(
    () =>
      auditRequestSql({
        id: ID_A,
        from: new Date('2026-10-16T13:30:00Z'),
        to: new Date('2026-10-16T14:15:00Z'),
        requestedAt: new Date(Number.NaN),
        operator: 'x',
      }),
    RenderError,
  );
});

test('parseD1Rows and toIndexRows accept Wrangler JSON and reject anything else', () => {
  const stdout = `noise\n${JSON.stringify([{ results: [{ object_key: 'k', day: 'd', hour: 1 }], success: true }])}`;
  assert.deepEqual(parseD1Rows(stdout), [{ object_key: 'k', day: 'd', hour: 1 }]);
  assert.throws(() => parseD1Rows('no json'), RenderError);
  assert.throws(() => parseD1Rows('[{"nope":1}]'), RenderError);
  const key = `access-log/2026/10/16/13-${ID_A}.ndjson.enc`;
  assert.deepEqual(toIndexRows([{ object_key: key, day: '2026-10-16', hour: 13 }]), [
    { object_key: key, day: '2026-10-16', hour: 13 },
  ]);
  assert.throws(() => toIndexRows([{ object_key: '../x', day: '2026-10-16', hour: 1 }]));
  assert.throws(() => toIndexRows([{ object_key: key, day: '2026-10-16', hour: 24 }]));
});

test('window selection: hours and S6 days intersecting the inclusive window', () => {
  const from = new Date('2026-10-16T13:30:00Z');
  const to = new Date('2026-10-16T14:15:00Z');
  const row = (/** @type {number | null} */ hour) => ({ object_key: 'k', day: '2026-10-16', hour });
  assert.equal(objectInWindow(row(12), from, to), false);
  assert.equal(objectInWindow(row(13), from, to), true);
  assert.equal(objectInWindow(row(14), from, to), true);
  assert.equal(objectInWindow(row(15), from, to), false);
  assert.equal(objectInWindow(row(null), from, to), true);

  assert.equal(lineInWindow({ ts: '2026-10-16T13:29:59.999Z' }, from, to), false);
  assert.equal(lineInWindow({ ts: '2026-10-16T13:30:00.000Z' }, from, to), true);
  assert.equal(lineInWindow({ ts: '2026-10-16T14:15:00.000Z' }, from, to), true);
  assert.equal(lineInWindow({ ts: '2026-10-16' }, from, to), true);
  assert.equal(lineInWindow({ ts: '2026-10-15' }, from, to), false);
  assert.equal(lineInWindow({ nots: 1 }, from, to), false);
});

/**
 * @param {string} key
 * @param {object[]} lines
 */
async function sealed(key, lines) {
  const cipher = createAccessLogCrypto(KEYRING);
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  return cipher.sealObject(key, new TextEncoder().encode(text));
}

test('decryptLines filters the window and rejects tampered objects', async () => {
  const cipher = createAccessLogCrypto(KEYRING);
  const key = `access-log/2026/10/16/13-${ID_A}.ndjson.enc`;
  const data = await sealed(key, [
    { ts: '2026-10-16T13:10:00.000Z', ip: '203.0.113.1' },
    { ts: '2026-10-16T13:40:00.000Z', ip: '203.0.113.2' },
  ]);
  const from = new Date('2026-10-16T13:30:00Z');
  const to = new Date('2026-10-16T14:15:00Z');
  const kept = await decryptLines(cipher, key, data, from, to);
  assert.deepEqual(
    kept.map((line) => JSON.parse(line).ip),
    ['203.0.113.2'],
  );
  const tampered = new Uint8Array(data);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
  await assert.rejects(decryptLines(cipher, key, tampered, from, to));
  await assert.rejects(decryptLines(cipher, key.replace('/13-', '/12-'), data, from, to));
});

test('queryAccessLog records the request, decrypts only the window and never prints records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alq-test-'));
  const out = join(dir, 'export.ndjson');
  const keyA = `access-log/2026/10/16/13-${ID_A}.ndjson.enc`;
  const keyB = `access-log/2026/10/16/s6-${ID_B}.ndjson.enc`;
  const keyOutside = `access-log/2026/10/16/09-${ID_A}.ndjson.enc`;
  const objects = new Map([
    [
      keyA,
      await sealed(keyA, [
        { ts: '2026-10-16T13:10:00.000Z', ip: '203.0.113.1', route_group: '/' },
        { ts: '2026-10-16T13:45:00.000Z', ip: '203.0.113.2', route_group: '/' },
      ]),
    ],
    [keyB, await sealed(keyB, [{ ts: '2026-10-16', ip: '198.51.100.7', route_group: 's6' }])],
  ]);
  /** @type {string[][]} */
  const calls = [];
  /** @type {string[]} */
  const logs = [];
  /** @type {string[]} */
  const tempDirs = [];
  /** @type {import('../../tools/access-log-query.mjs').WranglerRunner} */
  const run = async (args, { env }) => {
    calls.push(args);
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
    if (args[0] === 'whoami') {
      return { code: 0, stdout: JSON.stringify({ accounts: [{ id: ACCOUNT }] }) };
    }
    if (args[0] === 'd1') {
      const sql = args[args.length - 1] ?? '';
      const results = sql.startsWith('SELECT')
        ? [
            { object_key: keyOutside, day: '2026-10-16', hour: 9 },
            { object_key: keyA, day: '2026-10-16', hour: 13 },
            { object_key: keyB, day: '2026-10-16', hour: null },
          ]
        : [];
      return { code: 0, stdout: JSON.stringify([{ results, success: true }]) };
    }
    if (args[0] === 'r2') {
      const [, , , path = '', , , file = ''] = args;
      const data = objects.get(path.slice('open-auri-media-fixture/'.length));
      assert.ok(data, 'only objects inside the window are downloaded');
      writeFileSync(file, data);
      return { code: 0, stdout: '' };
    }
    return { code: 1, stdout: '' };
  };

  try {
    const result = await queryAccessLog([...BASE_ARGS, '--out', out], {
      values: new Map([
        ['CLOUDFLARE_ACCOUNT_ID', ACCOUNT],
        ['ACCESS_LOG_KEY', KEYRING],
        ['R2_BUCKET', 'open-auri-media-fixture'],
      ]),
      run,
      render: () => undefined,
      log: (line) => logs.push(line),
      now: () => new Date('2026-10-20T10:00:00Z'),
      uuid: () => ID_A,
      tempDir: () => {
        const created = mkdtempSync(join(dir, 'tmp-'));
        tempDirs.push(created);
        return created;
      },
    });
    assert.deepEqual(
      { objects: result.objects, records: result.records },
      {
        objects: 2,
        records: 2,
      },
    );

    const exported = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(exported.map((line) => line.ip).sort(), ['198.51.100.7', '203.0.113.2']);
    if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600);

    const sqls = calls.filter((args) => args[0] === 'd1').map((args) => args[args.length - 1]);
    assert.match(sqls[0] ?? '', /^INSERT INTO access_log_requests/);
    assert.match(sqls[0] ?? '', /'2026-10-16T13:30:00.000Z', '2026-10-16T14:15:00.000Z'/);
    // The audit mirror travels in the same command as the request row.
    assert.match(sqls[0] ?? '', /; INSERT INTO audit_log .*'operator', 'access_log\.query'/);
    assert.match(sqls[1] ?? '', /^SELECT object_key/);
    assert.equal(sqls[2], `UPDATE access_log_requests SET exported_count = 2 WHERE id = '${ID_A}'`);
    for (const args of calls.filter((a) => a[0] === 'd1')) assert.ok(args.includes('--remote'));
    assert.equal(calls.filter((args) => args[0] === 'r2').length, 2);

    const printed = logs.join('\n');
    assert.doesNotMatch(printed, /203\.0\.113|198\.51\.100/);
    assert.match(printed, /exported 2 record/);
    // The private temporary directory holding the encrypted downloads was created and removed.
    assert.equal(tempDirs.length, 1);
    assert.equal(existsSync(tempDirs[0] ?? dir), false);

    await assert.rejects(
      queryAccessLog([...BASE_ARGS, '--out', out], {
        values: new Map([
          ['CLOUDFLARE_ACCOUNT_ID', ACCOUNT],
          ['ACCESS_LOG_KEY', KEYRING],
          ['R2_BUCKET', 'b'],
        ]),
        run,
        render: () => undefined,
        log: () => undefined,
      }),
      /Refusing to overwrite/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryAccessLog stops before recording when the login or configuration is wrong', async () => {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../../tools/access-log-query.mjs').WranglerRunner} */
  const run = async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ accounts: [{ id: 'someone-else' }] }) };
  };
  const out = join(tmpdir(), `alq-never-${process.pid}.ndjson`);
  const deps = { run, render: () => undefined, log: () => undefined };
  await assert.rejects(
    queryAccessLog([...BASE_ARGS, '--out', out], {
      ...deps,
      values: new Map([
        ['CLOUDFLARE_ACCOUNT_ID', ACCOUNT],
        ['ACCESS_LOG_KEY', KEYRING],
        ['R2_BUCKET', 'b'],
      ]),
    }),
    /not logged in/,
  );
  assert.deepEqual(calls, [['whoami', '--json']]);
  await assert.rejects(
    queryAccessLog([...BASE_ARGS, '--out', out], {
      ...deps,
      values: new Map([['CLOUDFLARE_ACCOUNT_ID', ACCOUNT]]),
    }),
    /Missing environment variables: ACCESS_LOG_KEY, R2_BUCKET/,
  );
  await assert.rejects(
    queryAccessLog([...BASE_ARGS, '--out', out], {
      ...deps,
      values: new Map([
        ['CLOUDFLARE_ACCOUNT_ID', ACCOUNT],
        ['ACCESS_LOG_KEY', 'short'],
        ['R2_BUCKET', 'b'],
      ]),
    }),
    /not a valid keyring/,
  );
  assert.equal(existsSync(out), false);
});
