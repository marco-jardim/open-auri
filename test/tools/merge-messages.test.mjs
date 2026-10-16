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

const locales = ['pt-BR', 'en-US'];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'merge-messages-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const web = join(root, 'web');
  mkdirSync(join(web, 'scripts'), { recursive: true });
  mkdirSync(join(web, 'messages', '_staging'), { recursive: true });
  const script = join(web, 'scripts', 'merge-messages.mjs');
  copyFileSync(new URL('../../web/scripts/merge-messages.mjs', import.meta.url), script);
  const target = (locale) => join(web, 'messages', `${locale}.json`);
  const staging = (locale) => join(web, 'messages', '_staging', `T2.1.${locale}.json`);
  for (const locale of locales) {
    writeFileSync(target(locale), JSON.stringify({ app_title: 'open-auri' }));
    writeFileSync(staging(locale), JSON.stringify({ z_last: 'Z', a_first: 'A' }));
  }
  return {
    target,
    staging,
    run: (args = ['T2.1', '--no-compile']) =>
      spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' }),
  };
}

test('merges both locales with sorted keys, tabs and a newline, then removes staging', (t) => {
  const repo = fixture(t);
  writeFileSync(repo.staging('pt-BR'), JSON.stringify({ z_last: 'Última', a_first: 'Primeira' }));
  const result = repo.run();
  assert.equal(result.status, 0, result.stderr);
  for (const locale of locales) {
    const source = readFileSync(repo.target(locale), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(source)), ['a_first', 'app_title', 'z_last']);
    assert.equal(source, JSON.stringify(JSON.parse(source), null, '\t') + '\n');
    assert.ok(!existsSync(repo.staging(locale)));
  }
  assert.equal(JSON.parse(readFileSync(repo.target('pt-BR'), 'utf8')).z_last, 'Última');
});

test('rejects a key already present in either locale before changing any file', (t) => {
  for (const locale of locales) {
    const repo = fixture(t);
    writeFileSync(
      repo.target(locale),
      JSON.stringify({ app_title: 'open-auri', z_last: 'existing' }),
    );
    const before = locales.map((tag) => readFileSync(repo.target(tag), 'utf8'));
    const result = repo.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already present: z_last/);
    assert.deepEqual(
      locales.map((tag) => readFileSync(repo.target(tag), 'utf8')),
      before,
    );
    for (const tag of locales) assert.ok(existsSync(repo.staging(tag)));
  }
});

test('rejects mismatched staging keys in either direction without writes', (t) => {
  for (const locale of locales) {
    const repo = fixture(t);
    writeFileSync(repo.staging(locale), JSON.stringify({ only_here: 'value' }));
    const before = locales.map((tag) => readFileSync(repo.target(tag), 'utf8'));
    const result = repo.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /keys must match/);
    assert.deepEqual(
      locales.map((tag) => readFileSync(repo.target(tag), 'utf8')),
      before,
    );
    for (const tag of locales) assert.ok(existsSync(repo.staging(tag)));
  }
});

test('rejects invalid JSON, non-object JSON and non-string values in staging or targets', (t) => {
  for (const source of ['{bad', 'null', '[]', '{"a": 1}', '{"a": {}}', '{"a": false}']) {
    for (const kind of ['target', 'staging']) {
      const repo = fixture(t);
      writeFileSync(repo[kind]('en-US'), source);
      const before = locales.map((tag) => readFileSync(repo.target(tag), 'utf8'));
      const result = repo.run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /valid JSON|JSON object|Non-string/);
      assert.deepEqual(
        locales.map((tag) => readFileSync(repo.target(tag), 'utf8')),
        before,
      );
      for (const tag of locales) assert.ok(existsSync(repo.staging(tag)));
    }
  }
});

test('fails on missing staging files and rejects path traversal or unexpected arguments', (t) => {
  const repo = fixture(t);
  rmSync(repo.staging('en-US'));
  assert.equal(repo.run().status, 1);
  assert.ok(existsSync(repo.staging('pt-BR')));
  for (const args of [[], ['../escape', '--no-compile'], ['T2.1', '--unexpected']]) {
    const result = repo.run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});
