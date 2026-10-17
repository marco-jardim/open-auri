import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  DEFAULT_TARGETS,
  INITIAL_JS_BUDGET,
  budgetForRoute,
  loadBudgetTargets,
  measureBudgets,
  parseArgs,
  parseBudgetTargets,
} from '../../web/scripts/check-budgets.mjs';

const script = fileURLToPath(new URL('../../web/scripts/check-budgets.mjs', import.meta.url));
const asset = (name) => `_app/immutable/${name}.hash.js`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'check-budgets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'web', '.svelte-kit', 'output');
  const client = join(output, 'client');
  const manifestPath = join(client, '.vite', 'manifest.json');
  const serverPath = join(output, 'server', 'manifest-full.js');
  const sources = new Map();
  const vite = {};
  const put = (file, source) => {
    const path = join(client, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    sources.set(file, source);
  };
  const chunk = (key, file, source, extra = {}) => {
    vite[key] = { file, ...extra };
    put(file, source);
  };
  chunk('start', asset('entry/start'), 'export const start = 1;', {
    imports: ['shared'],
    dynamicImports: ['runtime', 'deferred'],
  });
  chunk('app', asset('entry/app'), 'export const app = 1;', { imports: ['shared'] });
  chunk('runtime', asset('chunks/runtime'), 'export const runtime = 1;');
  chunk('shared', asset('chunks/shared'), 'export const shared = 1;', { imports: ['nested'] });
  chunk('nested', asset('chunks/nested'), 'export const nested = 1;', { imports: ['shared'] });
  chunk('deferred', asset('chunks/png-qr'), randomBytes(300_000));
  for (let i = 0; i <= 4; i++) {
    chunk(`node${i}`, asset(`nodes/${i}`), `export const node = ${i};`, {
      imports: ['shared'],
      dynamicImports: ['deferred'],
      assets: ['_app/immutable/assets/font.woff2'],
    });
  }
  chunk('font', '_app/immutable/assets/font.woff2', randomBytes(300_000));
  const saveVite = () => {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(vite));
  };
  const saveServer = (source) => {
    mkdirSync(dirname(serverPath), { recursive: true });
    writeFileSync(serverPath, source);
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  saveVite();
  saveServer(`function __memo(fn) { let value; return () => value ??= fn(); }
  export const manifest = {
    app_dir: '_app',
    client: { start: '${asset('entry/start')}', app: '${asset('entry/app')}',
      imports: ['${asset('chunks/runtime')}', '${asset('chunks/shared')}'] },
    nodes: [${[0, 1, 2, 3, 4].map((i) => `__memo(() => import('./nodes/${i}.js'))`).join(',')}],
    routes: [
      { id: '/', page: { layouts: [0], errors: [1], leaf: 2 } },
      { id: '/docs', page: { layouts: [0, undefined, 3], errors: [1], leaf: 4 } },
      { id: '/api', page: null }
    ]
  };`);
  return {
    root,
    output,
    client,
    vite,
    sources,
    put,
    saveVite,
    saveServer,
    serverPath,
    run: (args = ['--output', output]) =>
      spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' }),
  };
}

test('sums each static JS resource once per route, including Kit boot runtime and nested layouts', async (t) => {
  const repo = fixture(t);
  const rows = await measureBudgets(repo.output);
  assert.deepEqual(
    rows.map((row) => row.route),
    ['/', '/docs'],
  );
  const common = [
    'entry/start',
    'entry/app',
    'chunks/runtime',
    'chunks/shared',
    'chunks/nested',
    'nodes/0',
  ];
  for (const row of rows) {
    const expected = [...common, ...(row.route === '/' ? ['nodes/2'] : ['nodes/3', 'nodes/4'])]
      .map(asset)
      .sort();
    assert.deepEqual(row.files, expected);
    assert.equal(
      row.rawBytes,
      expected.reduce((sum, file) => sum + Buffer.byteLength(repo.sources.get(file)), 0),
    );
    assert.equal(
      row.gzipBytes,
      expected.reduce((sum, file) => sum + gzipSync(repo.sources.get(file)).length, 0),
    );
    assert.equal(row.budgetBytes, 250_000);
    assert.equal(row.overBudget, false);
  }
});

test('excludes fonts, deferred modules, unrelated routes and error-only nodes', async (t) => {
  const repo = fixture(t);
  repo.put(asset('nodes/1'), randomBytes(300_000));
  repo.put(asset('nodes/4'), randomBytes(300_000));
  const [home, docs] = await measureBudgets(repo.output);
  assert.equal(home.overBudget, false);
  assert.equal(docs.overBudget, true);
  assert.ok(home.files.every((file) => !/png-qr|woff2|nodes\/[134]\./.test(file)));
});

test('checks compressed bytes, not raw size, and passes at exactly the budget', async (t) => {
  const repo = fixture(t);
  repo.put(asset('nodes/2'), 'x'.repeat(400_000));
  const [home] = await measureBudgets(repo.output);
  assert.ok(home.rawBytes > INITIAL_JS_BUDGET);
  assert.equal(home.overBudget, false);
  assert.equal((await measureBudgets(repo.output, home.gzipBytes))[0].overBudget, false);
  assert.equal((await measureBudgets(repo.output, home.gzipBytes - 1))[0].overBudget, true);
});

test('resolves reindexed server nodes without importing their application modules', async (t) => {
  const repo = fixture(t);
  repo.saveServer(`function __memo(fn) { let value; return () => value ??= fn(); }
  export const manifest = {
    client: { start: '${asset('entry/start')}', imports: [], nodes: ['ignored.js'] },
    nodes: [__memo(() => import('./nodes/3.js')), __memo(() => import('./nodes/4.js'))],
    routes: [{ id: '/reindexed', page: { layouts: [0], leaf: 1 } }]
  };`);
  const [row] = await measureBudgets(repo.output);
  assert.ok(row.files.includes(asset('nodes/3')));
  assert.ok(row.files.includes(asset('nodes/4')));
  assert.ok(!row.files.includes(asset('nodes/0')));
});

test('CLI prints a table with route classes and fails only when a route exceeds its target', (t) => {
  const repo = fixture(t);
  const pass = repo.run();
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /Initial JavaScript per route/);
  assert.match(pass.stdout, /gzip kB/);
  assert.match(pass.stdout, /\/docs/);
  assert.match(pass.stdout, /curva/);
  assert.match(pass.stdout, /PASS/);
  assert.doesNotMatch(pass.stdout, /nodes\/0\.hash\.js/, 'chunk rows only with --by-chunk');
  repo.put(asset('nodes/2'), randomBytes(300_000));
  const fail = repo.run();
  assert.equal(fail.status, 1, fail.stderr);
  assert.match(fail.stdout, /FAIL/);
  assert.match(fail.stdout, /PASS/);
});

test('per-class targets come from the versioned JSON of spec §5.7', () => {
  const targets = loadBudgetTargets();
  assert.equal(loadBudgetTargets(DEFAULT_TARGETS).defaultBytes, INITIAL_JS_BUDGET);
  const expected = {
    '/offline': ['static', 250_000],
    '/privacidade': ['static', 250_000],
    '/termos': ['static', 250_000],
    '/verificar-email': ['auth', 250_000],
    '/esqueci-senha': ['auth', 250_000],
    '/redefinir-senha': ['auth', 250_000],
    '/entrar': ['auth', 250_000],
    '/criar-conta': ['auth', 250_000],
    '/conta': ['auth', 250_000],
    '/conta/encerrada': ['auth', 250_000],
    '/docs': ['docs', 250_000],
    '/teste-cego': ['instrument-light', 250_000],
    '/cabo': ['instrument-light', 250_000],
    '/biblioteca': ['instrument-light', 250_000],
    '/c/[id]': ['instrument-light', 250_000],
    '/u/[apelido]': ['instrument-light', 250_000],
    '/': ['curva', 250_000],
    '/soe-como-x': ['instrument-heavy', 250_000],
    '/comparar': ['instrument-heavy', 250_000],
    '/comunidade': ['instrument-heavy', 250_000],
  };
  for (const [route, [classId, budgetBytes]] of Object.entries(expected)) {
    const resolved = budgetForRoute(route, targets);
    assert.deepEqual([resolved.classId, resolved.budgetBytes], [classId, budgetBytes], route);
  }
  assert.equal(budgetForRoute('/', targets).goalBytes, 180_000);
  // Unlisted routes (admin) keep the global ceiling; prefixes never match by substring.
  assert.deepEqual(budgetForRoute('/admin', targets), {
    classId: null,
    budgetBytes: INITIAL_JS_BUDGET,
    goalBytes: undefined,
  });
  assert.equal(budgetForRoute('/contas', targets).classId, null);
  assert.equal(budgetForRoute('/docs/extra', targets).classId, null);
});

test('measures each route against its class target and lists labelled chunks', async (t) => {
  const repo = fixture(t);
  repo.vite.shared.name = 'shared-lib';
  repo.vite.node2.src = 'src/routes/+page.svelte';
  repo.saveVite();
  const targets = parseBudgetTargets({
    version: 1,
    defaultBytes: 250_000,
    classes: [{ id: 'docs', targetBytes: 1, routes: ['/docs'] }],
  });
  const [home, docs] = await measureBudgets(repo.output, targets);
  assert.equal(home.classId, null);
  assert.equal(home.budgetBytes, 250_000);
  assert.equal(home.overBudget, false);
  assert.equal(docs.classId, 'docs');
  assert.equal(docs.budgetBytes, 1);
  assert.equal(docs.overBudget, true);
  for (const row of [home, docs]) {
    assert.deepEqual(row.chunks.map((chunk) => chunk.file).sort(), row.files);
    assert.equal(
      row.chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
      row.gzipBytes,
    );
    for (let i = 1; i < row.chunks.length; i++) {
      assert.ok(row.chunks[i - 1].gzipBytes >= row.chunks[i].gzipBytes, 'largest first');
    }
  }
  const label = (row, name) => row.chunks.find((chunk) => chunk.file === asset(name))?.name;
  assert.equal(label(home, 'chunks/shared'), 'shared-lib');
  assert.equal(label(home, 'nodes/2'), 'src/routes/+page.svelte');
  assert.equal(label(home, 'chunks/nested'), 'nested', 'falls back to the manifest key');
});

test('CLI --by-chunk prints a chunk table per route and --targets overrides the JSON', (t) => {
  const repo = fixture(t);
  repo.vite.shared.name = 'shared-lib';
  repo.saveVite();
  const byChunk = repo.run(['--output', repo.output, '--by-chunk']);
  assert.equal(byChunk.status, 0, byChunk.stderr);
  assert.match(byChunk.stdout, /\n\/docs \(docs\): \d+\.\d{2} kB gzip/);
  assert.match(byChunk.stdout, /\n\/ \(curva\): \d+\.\d{2} kB gzip/);
  assert.match(byChunk.stdout, /shared-lib/);
  assert.match(byChunk.stdout, /nodes\/4\.hash\.js/);
  const strict = join(repo.root, 'strict.json');
  writeFileSync(
    strict,
    JSON.stringify({
      version: 1,
      defaultBytes: 250_000,
      classes: [{ id: 'docs', targetBytes: 1, routes: ['/docs'] }],
    }),
  );
  const fail = repo.run(['--targets', strict, '--output', repo.output]);
  assert.equal(fail.status, 1, fail.stderr);
  assert.match(fail.stdout, /FAIL/);
  writeFileSync(strict, '{"version":2}');
  const invalid = repo.run(['--output', repo.output, '--targets', strict]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid budget targets version/);
});

test('rejects malformed targets and arguments', () => {
  const valid = { version: 1, defaultBytes: 10, classes: [] };
  assert.deepEqual(parseBudgetTargets(valid), { defaultBytes: 10, classes: [] });
  const cls = (extra) => ({ id: 'a', targetBytes: 5, routes: ['/a'], ...extra });
  for (const bad of [
    null,
    [],
    { ...valid, version: 2 },
    { ...valid, defaultBytes: -1 },
    { ...valid, defaultBytes: 1.5 },
    { ...valid, classes: {} },
    { ...valid, classes: [cls({ id: 'Bad Id' })] },
    { ...valid, classes: [cls(), cls({ routes: ['/b'] })] },
    { ...valid, classes: [cls(), cls({ id: 'b' })] },
    { ...valid, classes: [cls({ routes: ['a'] })] },
    { ...valid, classes: [cls({ routes: '/a' })] },
    { ...valid, classes: [cls({ targetBytes: -5 })] },
    { ...valid, classes: [cls({ goalBytes: 6 })] },
  ]) {
    assert.throws(() => parseBudgetTargets(bad), /Invalid|Goal above/);
  }
  assert.throws(() => budgetForRoute('/', -1), /Invalid JS budget/);
  assert.deepEqual(parseArgs([]), {
    output: parseArgs([]).output,
    targets: DEFAULT_TARGETS,
    byChunk: false,
  });
  assert.deepEqual(parseArgs(['--by-chunk', '--output', 'out', '--targets', 't.json']), {
    output: 'out',
    targets: 't.json',
    byChunk: true,
  });
  for (const args of [
    ['--targets'],
    ['--output', '--by-chunk'],
    ['extra'],
    ['--by-chunk', '--x'],
  ]) {
    assert.throws(() => parseArgs(args), /Usage:/);
  }
});

test('targets can tighten the 250 kB ceiling but never raise it', () => {
  const valid = { version: 1, defaultBytes: INITIAL_JS_BUDGET, classes: [] };
  const cls = (extra) => ({ id: 'a', targetBytes: INITIAL_JS_BUDGET, routes: ['/a'], ...extra });
  // Exactly at the ceiling is allowed, for the default, a target and a goal.
  assert.deepEqual(
    parseBudgetTargets({ ...valid, classes: [cls({ goalBytes: INITIAL_JS_BUDGET })] }),
    {
      defaultBytes: INITIAL_JS_BUDGET,
      classes: [
        { id: 'a', targetBytes: INITIAL_JS_BUDGET, goalBytes: INITIAL_JS_BUDGET, routes: ['/a'] },
      ],
    },
  );
  const above = INITIAL_JS_BUDGET + 1;
  for (const [bad, field] of [
    [{ ...valid, defaultBytes: above }, /Invalid default budget: above the 250 kB ceiling/],
    [{ ...valid, defaultBytes: 1_000_000 }, /Invalid default budget/],
    [{ ...valid, classes: [cls({ targetBytes: above })] }, /Invalid target of a: above/],
    // Both above: the target is refused first.
    [{ ...valid, classes: [cls({ targetBytes: above, goalBytes: above })] }, /Invalid target of a/],
    [{ ...valid, classes: [cls({ goalBytes: above })] }, /Invalid goal of a: above/],
  ]) {
    assert.throws(() => parseBudgetTargets(bad), field);
  }
});

test('the CLI refuses a targets file that raises the ceiling', (t) => {
  const repo = fixture(t);
  const loose = join(repo.root, 'loose.json');
  writeFileSync(
    loose,
    JSON.stringify({
      version: 1,
      defaultBytes: 250_000,
      classes: [{ id: 'docs', targetBytes: 400_000, routes: ['/docs'] }],
    }),
  );
  const result = repo.run(['--output', repo.output, '--targets', loose]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid target of docs: above the 250 kB ceiling/);
  assert.doesNotMatch(result.stdout, /PASS/);
});

test('fails closed for missing builds, manifests, chunks and static dependencies', async (t) => {
  const absent = fixture(t);
  rmSync(join(absent.client, '.vite', 'manifest.json'));
  await assert.rejects(measureBudgets(absent.output), /ENOENT/);
  const noServer = fixture(t);
  rmSync(noServer.serverPath);
  await assert.rejects(measureBudgets(noServer.output), /ENOENT/);
  const noChunk = fixture(t);
  rmSync(join(noChunk.client, asset('nodes/2')));
  await assert.rejects(measureBudgets(noChunk.output), /ENOENT/);
  const badGraph = fixture(t);
  badGraph.vite.node2.imports = ['missing'];
  badGraph.saveVite();
  await assert.rejects(measureBudgets(badGraph.output), /Missing static import/);
});

test('rejects malformed Vite JSON, invalid manifest graphs and incomplete client builds', async (t) => {
  for (const source of ['{bad', '[]', 'null', '{"bad":{}}']) {
    const repo = fixture(t);
    writeFileSync(join(repo.client, '.vite', 'manifest.json'), source);
    await assert.rejects(measureBudgets(repo.output));
  }
  for (const source of [
    'export const manifest = { client: null };',
    'export const manifest = { client: { start: "missing", imports: [] }, nodes: [], routes: [] };',
  ]) {
    const repo = fixture(t);
    repo.saveServer(source);
    await assert.rejects(measureBudgets(repo.output), /Invalid|No page routes/);
  }
});

test('rejects escaped client paths, missing route entries and invalid CLI arguments', async (t) => {
  const escaped = fixture(t);
  escaped.vite.node2.file = '../outside.js';
  escaped.vite.node2.imports = ['escaped'];
  escaped.vite.escaped = { file: '../outside.js' };
  escaped.saveVite();
  await assert.rejects(measureBudgets(escaped.output), /Missing or ambiguous client route node/);
  const escapedDependency = fixture(t);
  escapedDependency.vite.nested.file = '../outside.js';
  escapedDependency.saveVite();
  await assert.rejects(measureBudgets(escapedDependency.output), /escapes build output/);
  const repo = fixture(t);
  for (const args of [['--unknown'], ['--output']]) {
    const result = repo.run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  await assert.rejects(measureBudgets(repo.output, -1), /Invalid JS budget/);
});
