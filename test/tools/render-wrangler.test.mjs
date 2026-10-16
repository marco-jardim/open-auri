import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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

test('invalid dotenv syntax never echoes its contents', (t) => {
  for (const line of ['fixture-private-value-456', 'OA_TEST_WORKER="fixture-private-value-456']) {
    const repo = fixture(t, line);
    const result = repo.runDotenv();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid .env syntax at line 1/);
    silent(result, ['fixture-private-value-456']);
  }
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
