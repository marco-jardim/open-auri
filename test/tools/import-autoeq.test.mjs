import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, access, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GRID } from '../../src/dsp/grid.mjs';
import { normalize, parseMeasurement, toGrid } from '../../src/io/measurement.mjs';
import {
  buildDataset,
  createTreeReader,
  createGitReader,
  readGitBlobs,
  inferEntries,
  quantize,
  parseNameIndex,
  resolveRevision,
  importAutoEq,
  parseArgs,
  ENTRY_BYTES,
  MAX_PACK_BYTES,
} from '../../tools/import-autoeq.mjs';

const fixture = fileURLToPath(new URL('../fixtures/autoeq/', import.meta.url));
const sha = '7ae0f56d53074872b028649617a22bbb4232feb7';
const generatedAt = '2026-10-16T00:00:00.000Z';

async function temporary(t) {
  const directory = await mkdtemp(path.join(import.meta.dirname, '.autoeq-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function git(repository, args, input) {
  return execFileSync('git', ['--git-dir', repository, ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

test('infers both layouts, all types, case collisions and model slug collisions deterministically', () => {
  const paths = [
    'measurements/Rtings/data/in-ear/Acme Bud.csv',
    'measurements/rtings/over-ear/Acme Studio.csv',
    'measurements/Other/on-ear/A+B.csv',
    'measurements/Other/on-ear/A B.csv',
    'measurements/Other/data/earbud/Acme Open.csv',
    'targets/Harman in-ear 2019.csv',
    'results/ignored.csv',
    'measurements/Other/readme.csv',
  ];
  const entries = inferEntries(paths);
  assert.equal(entries.length, 6);
  assert.deepEqual(entries, inferEntries(paths.toReversed()));
  assert.equal(new Set(entries.map((entry) => entry.id.toLowerCase())).size, entries.length);
  const upper = entries.find((entry) => entry.source === 'Rtings');
  const lower = entries.find((entry) => entry.source === 'rtings');
  assert.notEqual(upper.sourceSlug, lower.sourceSlug);
  assert.equal(upper.type, 'iem');
  assert.equal(lower.type, 'over-ear');
  assert.equal(entries.find((entry) => entry.type === 'target').source, 'AutoEq targets');
  assert.ok(inferEntries(paths, ['Rtings']).some((entry) => entry.source === 'rtings'));
  assert.ok(!inferEntries(paths, ['Rtings']).some((entry) => entry.source === 'Rtings'));
});

test('reads canonical names and explicit multiword brands from name_index.tsv', () => {
  const names = parseNameIndex('file_name\tname\tbrand\r\nFoo.csv\tAcme Foo\tAcme Audio\r\n');
  assert.deepEqual(names.get('Foo'), { name: 'Acme Foo', brand: 'Acme Audio' });
  assert.deepEqual(parseNameIndex('name\tform\trig\nAcme Foo\tin-ear\t711').get('Acme Foo'), {
    name: 'Acme Foo',
    brand: 'Acme',
  });
  assert.equal(parseNameIndex('').size, 0);
});

test('little-endian quantization round trips within 0.01 dB and reports symmetric clamps', () => {
  const values = [-327.67, -12.3456, -0.0049, 0, 0.0051, 123.4567, 327.67];
  const result = quantize(values);
  assert.equal(result.clamps, 0);
  values.forEach((value, index) =>
    assert.ok(Math.abs(value - result.data.readInt16LE(index * 2) / 100) < 0.01),
  );
  const clamped = quantize([-400, 400]);
  assert.equal(clamped.clamps, 2);
  assert.equal(clamped.data.readInt16LE(0), -32767);
  assert.equal(clamped.data.readInt16LE(2), 32767);
  assert.throws(() => quantize([NaN]), /nonfinite/);
});

test('converts fixtures onto GRID, skips MeasurementError and keeps index/pack offsets consistent', async (t) => {
  const out = await temporary(t);
  const reports = [];
  const reader = createTreeReader(fixture);
  const { index, manifest } = await buildDataset({
    reader,
    out,
    sha,
    generatedAt,
    report: (message) => reports.push(message),
  });
  assert.equal(manifest.counts.measurements, 5);
  assert.equal(manifest.counts.targets, 2);
  assert.equal(manifest.counts.skipped, 1);
  assert.ok(manifest.counts.clampedValues > 0);
  assert.deepEqual(manifest.grid, { points: 481, minHz: 20, maxHz: 20000 });
  assert.equal(manifest.license, 'MIT (AutoEq)');
  assert.ok(reports.some((message) => /Broken.csv.*meas:coverage/.test(message)));
  assert.ok(reports.some((message) => /clamped/.test(message)));
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'index.json'), 'utf8')), index);
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')), manifest);
  const inferred = inferEntries(await reader.list());
  const occupied = new Set();
  for (const entry of index) {
    const source = inferred.find((item) => item.id === entry.id);
    const parsed = parseMeasurement(await readFile(path.join(fixture, source.path), 'utf8'));
    const expected = normalize(toGrid(parsed.frequencies, parsed.values), GRID);
    const pack = await readFile(path.join(out, entry.pack));
    assert.equal(entry.offset % ENTRY_BYTES, 0);
    assert.ok(entry.offset + ENTRY_BYTES <= pack.length);
    assert.ok(pack.length <= MAX_PACK_BYTES);
    assert.ok(!occupied.has(`${entry.pack}:${entry.offset}`));
    occupied.add(`${entry.pack}:${entry.offset}`);
    expected.forEach((value, point) => {
      const bounded = Math.max(-327.67, Math.min(327.67, value));
      assert.ok(Math.abs(pack.readInt16LE(entry.offset + point * 2) / 100 - bounded) < 0.01);
    });
    assert.equal(entry.type === 'target', entry.pack.startsWith('targets-'));
  }
  for (const file of (await readdir(out)).filter((file) => file.endsWith('.bin'))) {
    const pack = await readFile(path.join(out, file));
    assert.equal(pack.length, index.filter((entry) => entry.pack === file).length * ENTRY_BYTES);
  }
  const named = index.find((entry) => entry.name === 'Áudio Bud Reference');
  assert.equal(named.brand, 'Áudio Works');
  assert.equal(index.find((entry) => entry.name === 'Acme Studio').brand, 'Acme');
  for (const source of manifest.sources) {
    assert.equal(source.measurements, index.filter((entry) => entry.source === source.name).length);
    assert.match(source.attribution, /Jaakko Pasanen, MIT/);
    assert.ok(source.link.endsWith(encodeURIComponent(source.name)));
  }
});

test('splits source/type and target packs at the configurable byte limit, reproducibly', async (t) => {
  const out = await temporary(t);
  const options = {
    reader: createTreeReader(fixture),
    out,
    sha,
    generatedAt,
    maxPackBytes: ENTRY_BYTES,
    report: () => {},
  };
  const first = await buildDataset(options);
  assert.equal(first.manifest.counts.packs, first.index.length);
  assert.ok(first.index.every((entry) => entry.offset === 0));
  assert.ok(first.index.some((entry) => /-002.bin$/.test(entry.pack)));
  const before = new Map();
  for (const file of await readdir(out)) before.set(file, await readFile(path.join(out, file)));
  assert.deepEqual(await buildDataset(options), first);
  for (const file of await readdir(out))
    assert.deepEqual(await readFile(path.join(out, file)), before.get(file));
  await assert.rejects(buildDataset({ ...options, maxPackBytes: ENTRY_BYTES - 1 }), RangeError);
  await assert.rejects(buildDataset({ ...options, maxPackBytes: MAX_PACK_BYTES + 1 }), RangeError);
});

test('excludes exact source names and removes obsolete generated packs during regeneration', async (t) => {
  const out = await temporary(t);
  const options = { reader: createTreeReader(fixture), out, sha, generatedAt, report: () => {} };
  await buildDataset(options);
  await writeFile(path.join(out, 'unrelated.txt'), 'keep me');
  const { index, manifest } = await buildDataset({
    ...options,
    excluded: ['Fixture Lab', 'Fixture Lab', 'Unknown'],
  });
  assert.ok(!index.some((entry) => entry.source === 'Fixture Lab'));
  assert.deepEqual(manifest.excluded, ['Fixture Lab', 'Unknown']);
  assert.ok(!manifest.sources.some((source) => source.name === 'Fixture Lab'));
  assert.ok(!(await readdir(out)).some((file) => file.startsWith('measurements-fixture-lab')));
  assert.equal(await readFile(path.join(out, 'unrelated.txt'), 'utf8'), 'keep me');
});

test('resolves master with injected fetch, falls back to the newest complete cached SHA', async (t) => {
  const cache = await temporary(t);
  const reports = [];
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://api.github.com/repos/jaakkopasanen/AutoEq/commits/master');
    return new Response(
      JSON.stringify({ sha, commit: { committer: { date: '2025-07-20T00:00:00Z' } } }),
    );
  };
  assert.deepEqual(await resolveRevision({ cache, fetchImpl }), {
    sha,
    commitDate: '2025-07-20T00:00:00Z',
  });
  const oldSha = '1'.repeat(40);
  for (const [id, commitDate] of [
    [sha, '2025-07-20T00:00:00Z'],
    [oldSha, '2024-01-01T00:00:00Z'],
  ]) {
    await mkdir(path.join(cache, id));
    await writeFile(
      path.join(cache, id, 'autoeq-cache.json'),
      JSON.stringify({ sha: id, commitDate }),
    );
  }
  await mkdir(path.join(cache, 'f'.repeat(40))); // Interrupted fetch, no metadata.
  const offline = async () => {
    throw new Error('offline');
  };
  assert.equal(
    (
      await resolveRevision({
        cache,
        fetchImpl: offline,
        report: (message) => reports.push(message),
      })
    ).sha,
    sha,
  );
  assert.match(reports[0], /using cached SHA/);
  assert.equal(
    (
      await resolveRevision({
        cache,
        fetchImpl: async () => new Response('', { status: 503 }),
        report: () => {},
      })
    ).sha,
    sha,
  );
  assert.equal((await resolveRevision({ sha, cache, fetchImpl: offline })).sha, sha);
  await assert.rejects(
    resolveRevision({ cache: path.join(cache, 'empty'), fetchImpl: offline }),
    /no cached revision/,
  );
  await assert.rejects(resolveRevision({ sha: '--bad' }), /40-character/);
});

test('bare Git plumbing preserves Rtings/rtings blobs without any checkout, across read batches', async (t) => {
  const root = await temporary(t);
  const repository = path.join(root, 'bare.git');
  const run = (args, input) => git(repository, args, input);
  run(['init', '--bare']);
  const csv = 'frequency,raw\n20,3.1234\n1000,0\n20000,-1.2345\n';
  const blob = run(['hash-object', '-w', '--stdin'], csv);
  const typeTree = run(['mktree'], `100644 blob ${blob}\tAcme Bud.csv\n`);
  const sourceTree = run(['mktree'], `040000 tree ${typeTree}\tin-ear\n`);
  const sourcesTree = run(
    ['mktree'],
    `040000 tree ${sourceTree}\tRtings\n040000 tree ${sourceTree}\trtings\n`,
  );
  const tree = run(['mktree'], `040000 tree ${sourcesTree}\tmeasurements\n`);
  const revision = run([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit-tree',
    tree,
    '-m',
    'fixture',
  ]);
  const reader = createGitReader(repository, revision);
  const paths = await reader.list();
  assert.deepEqual(paths, [
    'measurements/Rtings/in-ear/Acme Bud.csv',
    'measurements/rtings/in-ear/Acme Bud.csv',
  ]);
  const blobs = [];
  for await (const item of readGitBlobs(
    repository,
    revision,
    Array.from({ length: 130 }, (_, i) => paths[i % 2]),
  ))
    blobs.push(item);
  assert.equal(blobs.length, 130);
  assert.ok(blobs.every((item) => item.data.toString('utf8') === csv));
  const { index, manifest } = await buildDataset({
    reader,
    out: path.join(root, 'out'),
    sha: revision,
  });
  assert.equal(index.length, 2);
  assert.equal(new Set(index.map((entry) => entry.pack.toLowerCase())).size, 2);
  assert.deepEqual(
    manifest.sources.map((source) => source.name),
    ['Rtings', 'rtings'],
  );
  await assert.rejects(access(path.join(repository, 'measurements')), /ENOENT/);
  await assert.rejects(async () => {
    for await (const item of readGitBlobs(repository, revision, ['missing.csv'])) void item;
  }, /Cannot read Git blob/);
  // A real, fully populated bare cache must not try to fetch blobs while offline.
  const cache = path.join(root, 'cache');
  await mkdir(cache);
  await rename(repository, path.join(cache, revision));
  await writeFile(
    path.join(cache, revision, 'autoeq-cache.json'),
    JSON.stringify({ sha: revision, commitDate: generatedAt }),
  );
  const cached = await importAutoEq({
    cache,
    out: path.join(root, 'offline-out'),
    fetchImpl: async () => {
      throw new Error('offline');
    },
    report: () => {},
  });
  assert.equal(cached.manifest.sha, revision);
  assert.deepEqual(cached.index, index);
});

test('cat-file handles stdin/stdout backpressure across batches', { timeout: 30000 }, async (t) => {
  const root = await temporary(t);
  const repository = path.join(root, 'bare.git');
  git(repository, ['init', '--bare']);
  const data = 'blob content\n'.repeat(4096);
  const blob = git(repository, ['hash-object', '-w', '--stdin'], data);
  // Git paths need not fit the host filesystem: no checkout is involved. These
  // requests exceed stdin's high-water mark while stdout also exceeds pipe capacity.
  const name = `${'long-name-'.repeat(256)}.csv`;
  const tree = git(repository, ['mktree'], `100644 blob ${blob}\t${name}\n`);
  const paths = Array(130).fill(name);
  const reports = [];
  let count = 0;
  for await (const item of readGitBlobs(repository, tree, paths, (message) =>
    reports.push(message),
  )) {
    assert.equal(item.path, name);
    assert.equal(item.data.toString('utf8'), data);
    count++;
  }
  assert.equal(count, paths.length);
  assert.ok(reports.some((message) => /read 128\/130 Git blobs/.test(message)));
  assert.ok(reports.some((message) => /read 130\/130 Git blobs/.test(message)));
  assert.ok(reports.every((message) => !message.includes(data)));
});

test('cat-file retains stderr when Git exits early', { timeout: 30000 }, async (t) => {
  const root = await temporary(t);
  const paths = Array(128).fill(`measurements/${'long-name-'.repeat(256)}.csv`);
  await assert.rejects(
    async () => {
      for await (const item of readGitBlobs(root, sha, paths, () => {})) void item;
    },
    (error) => {
      assert.match(error.message, /git cat-file/);
      assert.match(error.message, /not a git repository/i);
      return true;
    },
  );
});

test('a failed initial fetch reports the Git command and remote stderr', async (t) => {
  const root = await temporary(t);
  const cache = path.join(root, 'cache');
  const repository = path.join(cache, sha);
  await mkdir(repository, { recursive: true });
  git(repository, ['init', '--bare']);
  git(repository, ['remote', 'add', 'origin', path.join(root, 'absent.git')]);
  await assert.rejects(
    importAutoEq({ sha, cache, out: path.join(root, 'out'), report: () => {} }),
    (error) => {
      assert.match(error.message, /git fetch --filter=blob:none --depth=1/);
      assert.match(error.message, /could not read from remote repository/i);
      return true;
    },
  );
});

test('partial bare caches fetch lazily and work offline', { timeout: 30000 }, async (t) => {
  const root = await temporary(t);
  const remote = path.join(root, 'origin.git');
  const run = (args, input) => git(remote, args, input);
  run(['init', '--bare']);
  run(['config', 'uploadpack.allowFilter', 'true']);
  run(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const csv = 'frequency,raw\n20,3\n1000,0\n20000,-1\n';
  const blob = run(['hash-object', '-w', '--stdin'], csv);
  const names = run(['hash-object', '-w', '--stdin'], 'name\tbrand\nAcme Bud\tAcme Audio\n');
  const ignored = run(['hash-object', '-w', '--stdin'], 'do not download results');
  const typeTree = run(['mktree'], `100644 blob ${blob}\tAcme Bud.csv\n`);
  const sourceTree = run(
    ['mktree'],
    `040000 tree ${typeTree}\tin-ear\n100644 blob ${names}\tname_index.tsv\n`,
  );
  const sourcesTree = run(
    ['mktree'],
    `040000 tree ${sourceTree}\tRtings\n040000 tree ${sourceTree}\trtings\n`,
  );
  const resultsTree = run(['mktree'], `100644 blob ${ignored}\tignored.csv\n`);
  const tree = run(
    ['mktree'],
    `040000 tree ${sourcesTree}\tmeasurements\n040000 tree ${resultsTree}\tresults\n`,
  );
  const revision = run([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit-tree',
    tree,
    '-m',
    'partial clone fixture',
  ]);
  const cache = path.join(root, 'cache');
  const repository = path.join(cache, revision);
  await mkdir(repository, { recursive: true });
  git(repository, ['init', '--bare']);
  git(repository, ['remote', 'add', 'origin', pathToFileURL(remote).href]);
  git(repository, ['fetch', '--filter=blob:none', '--depth=1', 'origin', revision]);
  const missing = () => git(repository, ['rev-list', '--objects', '--missing=print', revision]);
  assert.ok(missing().includes(`?${blob}`));
  assert.ok(missing().includes(`?${names}`));

  // A failed lazy fetch can emit a "missing" protocol header as well as stderr.
  // The parser must not discard the remote's diagnostic in favor of that header.
  git(repository, ['remote', 'set-url', 'origin', path.join(root, 'absent.git')]);
  await assert.rejects(
    async () => {
      for await (const item of readGitBlobs(
        repository,
        revision,
        ['measurements/Rtings/in-ear/Acme Bud.csv'],
        () => {},
      ))
        void item;
    },
    (error) => {
      assert.match(error.message, /git cat-file/);
      assert.match(error.message, /could not read from remote repository/i);
      return true;
    },
  );
  git(repository, ['remote', 'set-url', 'origin', pathToFileURL(remote).href]);
  git(repository, ['config', 'remote.origin.promisor', 'false']);
  const reports = [];
  const options = {
    sha: revision,
    cache,
    out: path.join(root, 'out'),
    fetchImpl: async () => {
      throw new Error('must not call GitHub');
    },
    report: (message) => reports.push(message),
  };
  const imported = await importAutoEq(options);
  assert.equal(imported.index.length, 2);
  assert.ok(imported.index.every((entry) => entry.brand === 'Acme Audio'));
  assert.equal(git(repository, ['config', 'remote.origin.promisor']), 'true');
  assert.equal(git(repository, ['config', 'extensions.partialClone']), 'origin');
  assert.equal(git(repository, ['config', 'remote.origin.partialclonefilter']), 'blob:none');
  assert.ok(!missing().includes(`?${blob}`));
  assert.ok(!missing().includes(`?${names}`));
  assert.ok(missing().includes(`?${ignored}`));
  assert.ok(reports.some((message) => /read 2\/2 Git blobs/.test(message)));
  await assert.rejects(access(path.join(repository, 'measurements')), /ENOENT/);

  // Exercise the importer's initial shallow filtered fetch too, not just a cache
  // whose commit and trees were already populated by this test.
  const freshCache = path.join(root, 'fresh-cache');
  const freshRepository = path.join(freshCache, revision);
  await mkdir(freshRepository, { recursive: true });
  git(freshRepository, ['init', '--bare']);
  git(freshRepository, ['remote', 'add', 'origin', pathToFileURL(remote).href]);
  const fresh = await importAutoEq({
    ...options,
    cache: freshCache,
    out: path.join(root, 'fresh-out'),
  });
  assert.deepEqual(fresh.index, imported.index);
  assert.ok(
    git(freshRepository, ['rev-list', '--objects', '--missing=print', revision]).includes(
      `?${ignored}`,
    ),
  );

  await rename(remote, path.join(root, 'unavailable-origin.git'));
  const offline = await importAutoEq({ ...options, out: path.join(root, 'offline-out') });
  assert.deepEqual(offline.index, imported.index);
});

test('from-tree import and CLI fixture run never call the network', async (t) => {
  const out = await temporary(t);
  const result = await importAutoEq({
    fromTree: fixture,
    out,
    fetchImpl: async () => {
      throw new Error('must not fetch');
    },
    report: () => {},
  });
  assert.equal(result.manifest.sha, 'from-tree');
  assert.equal(result.manifest.commitDate, null);
  const script = fileURLToPath(new URL('../../tools/import-autoeq.mjs', import.meta.url));
  const output = execFileSync(
    process.execPath,
    [script, '--from-tree', fixture, '--out', out, '--exclude-source', 'Fixture Lab'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  assert.match(output, /AutoEq from-tree/);
  assert.equal(
    JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')).counts.measurements,
    2,
  );
  assert.deepEqual(
    parseArgs([
      '--sha',
      sha,
      '--cache',
      'cache',
      '--out',
      'out',
      '--exclude-source',
      'Rtings',
      '--exclude-source',
      'rtings',
      '--from-tree',
      fixture,
    ]),
    { sha, cache: 'cache', out: 'out', excluded: ['Rtings', 'rtings'], fromTree: fixture },
  );
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--out']), /Missing value/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
});
