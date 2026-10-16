import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { GRID } from '../src/dsp/grid.mjs';
import { MeasurementError, parseMeasurement, toGrid, normalize } from '../src/io/measurement.mjs';

export const REPOSITORY = 'https://github.com/jaakkopasanen/AutoEq';
export const DEFAULT_CACHE = path.join(tmpdir(), 'Claude', 'autoeq');
export const ENTRY_BYTES = GRID.length * 2;
export const MAX_PACK_BYTES = 5 * 1024 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const TYPES = new Map([
  ['in-ear', 'iem'],
  ['over-ear', 'over-ear'],
  ['on-ear', 'on-ear'],
  ['earbud', 'earbud'],
]);

/** @typedef {{path: string, name: string, source: string, type: string, sourceSlug: string, id: string}} InferredEntry */
/** @typedef {{id: string, name: string, brand: string, source: string, type: string, pack: string, offset: number}} IndexEntry */
/** @typedef {{list: () => Promise<string[]>, read: (paths: string[]) => AsyncIterable<{path: string, data: Buffer}>}} TreeReader */

/** Locale-independent ordering, including on case-insensitive hosts. @param {string} a @param {string} b */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
/** @param {string} text */
function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}
/** @param {string} text */
function slug(text) {
  return (
    text
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'entry'
  );
}

/** Infer paths without touching the filesystem: Rtings and rtings remain distinct on Windows.
 * @param {readonly string[]} paths
 * @param {readonly string[]} [excluded]
 * @returns {InferredEntry[]}
 */
export function inferEntries(paths, excluded = []) {
  const exclusions = new Set(excluded);
  /** @type {InferredEntry[]} */
  const entries = [];
  for (const file of [...new Set(paths)].sort(compare)) {
    const match =
      /^measurements\/([^/]+)\/(?:data\/)?(in-ear|over-ear|on-ear|earbud)\/([^/]+)\.csv$/i.exec(
        file,
      );
    const target = /^targets\/([^/]+)\.csv$/i.exec(file);
    if (match && !exclusions.has(match[1])) {
      entries.push({
        path: file,
        source: match[1],
        type: TYPES.get(match[2].toLowerCase()) ?? '',
        name: match[3],
        sourceSlug: '',
        id: '',
      });
    } else if (target && !exclusions.has('AutoEq targets')) {
      entries.push({
        path: file,
        source: 'AutoEq targets',
        type: 'target',
        name: target[1],
        sourceSlug: 'targets',
        id: '',
      });
    }
  }
  const sources = [
    ...new Set(entries.filter((entry) => entry.type !== 'target').map((entry) => entry.source)),
  ];
  const sourceSlugs = new Map(sources.map((source) => [source, slug(source)]));
  for (const source of sources) {
    if (sources.filter((other) => slug(other) === slug(source)).length > 1) {
      sourceSlugs.set(source, `${slug(source)}-${hash(source)}`);
    }
  }
  for (const entry of entries) {
    if (entry.type !== 'target') entry.sourceSlug = sourceSlugs.get(entry.source) ?? '';
    entry.id = `${entry.type === 'target' ? 'targets' : `measurements/${entry.sourceSlug}/${entry.type}`}/${slug(entry.name)}`;
  }
  const ids = new Map();
  for (const entry of entries) ids.set(entry.id, (ids.get(entry.id) ?? 0) + 1);
  for (const entry of entries) if (ids.get(entry.id) > 1) entry.id += `-${hash(entry.path)}`;
  return entries;
}

/** @param {string} text @returns {Map<string, {name: string, brand: string}>} */
export function parseNameIndex(text) {
  const rows = text
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split('\t'));
  const headers = rows[0].map((value) => value.trim().toLowerCase().replace(/[ -]/g, '_'));
  const nameColumn =
    headers.indexOf('name') >= 0 ? headers.indexOf('name') : headers.indexOf('model');
  /** @type {Map<string, {name: string, brand: string}>} */
  const result = new Map();
  if (nameColumn < 0) return result;
  const brandColumn = headers.findIndex((value) => ['brand', 'manufacturer'].includes(value));
  const aliasColumns = headers.flatMap((value, index) =>
    ['name', 'model', 'file', 'file_name', 'filename', 'source_name', 'original_name'].includes(
      value,
    )
      ? [index]
      : [],
  );
  for (const row of rows.slice(1)) {
    const name = row[nameColumn]?.trim();
    if (!name) continue;
    const brand = row[brandColumn]?.trim() || name.split(/\s+/)[0];
    for (const column of aliasColumns) {
      const alias = row[column]
        ?.trim()
        .split('/')
        .pop()
        ?.replace(/\.csv$/i, '');
      if (alias && !result.has(alias)) result.set(alias, { name, brand });
    }
  }
  return result;
}

/** Quantized bytes are explicitly little-endian, not host-endian.
 * @param {readonly number[]} values
 */
export function quantize(values) {
  const data = Buffer.alloc(values.length * 2);
  let clamps = 0;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) throw new TypeError('Cannot quantize a nonfinite value.');
    if (Math.abs(value) > 327.67) clamps++;
    data.writeInt16LE(Math.round(Math.max(-327.67, Math.min(327.67, value)) * 100), index * 2);
  });
  return { data, clamps };
}

/** @param {string} directory @returns {TreeReader} */
export function createTreeReader(directory) {
  return {
    async list() {
      /** @type {string[]} */
      const paths = [];
      /** @param {string} relative */
      async function walk(relative) {
        let children;
        try {
          children = await readdir(path.join(directory, relative), { withFileTypes: true });
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return;
          throw error;
        }
        for (const child of children) {
          const file = `${relative}/${child.name}`;
          if (child.isDirectory()) await walk(file);
          else if (child.isFile()) paths.push(file);
        }
      }
      await walk('measurements');
      await walk('targets');
      return paths.sort(compare);
    },
    async *read(paths) {
      for (const file of paths)
        yield { path: file, data: await readFile(path.join(directory, file)) };
    },
  };
}

/** Keep Git's diagnostic even when a closed stdin also produces EPIPE/EOF on Windows.
 * @param {string} command @param {string} stderr @param {Error} [error]
 */
function gitFailure(command, stderr, error) {
  const details = [stderr.trim(), error?.message].filter(Boolean).join('\n');
  return new Error(`${command} failed${details ? `: ${details}` : '.'}`, { cause: error });
}

/** @param {string} directory @param {string[]} args @returns {Promise<string>} */
async function git(directory, args) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    /** @type {Error | undefined} */
    let processError;
    const child = spawn('git', ['--git-dir', path.resolve(directory), ...args], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8').on('data', (data) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 64 * 1024 * 1024) {
        processError ??= new Error('Git stdout exceeded 64 MiB.');
        child.kill();
      } else stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-65536);
    });
    child.on('error', (error) => {
      processError = error;
    });
    child.on('close', (code) => {
      if (processError || code !== 0)
        reject(gitFailure(`git ${args.join(' ')} (exit ${code})`, stderr, processError));
      else resolve(stdout);
    });
  });
}

/** Stream the length-delimited cat-file protocol. No CSV, including differently cased
 * paths, is ever checked out. Requests are bounded to keep stdin and memory small.
 * @param {string} directory @param {string} sha @param {string[]} paths
 * @param {(message: string) => void} [report]
 */
export async function* readGitBlobs(directory, sha, paths, report = console.warn) {
  if (paths.length)
    report(`AutoEq: reading 0/${paths.length} Git blobs (missing objects are fetched lazily).`);
  for (let start = 0; start < paths.length; start += 128) {
    const batch = paths.slice(start, start + 128);
    if (batch.some((file) => /[\r\n\0]/.test(file)))
      throw new Error('Unsupported newline in Git path.');
    const child = spawn('git', ['--git-dir', path.resolve(directory), 'cat-file', '--batch'], {
      cwd: directory,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    /** @type {Error | undefined} */
    let processError;
    child.stderr.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-65536);
    });
    child.stdin.on('error', (error) => {
      processError = error;
    });
    const completion = new Promise((resolve) => {
      child.on('error', (error) => {
        processError = error;
      });
      child.on('close', resolve);
    });
    // Feed and consume concurrently: pipeline waits for drain, ends stdin, and observes
    // errors/early close without rejecting before Git's stderr has been collected.
    const input = pipeline(
      Readable.from(batch.map((file) => `${sha}:${file}\n`)),
      child.stdin,
    ).catch((error) => {
      processError ??= error;
    });
    let pending = Buffer.alloc(0);
    let size = -1;
    let index = 0;
    try {
      try {
        for await (const chunk of child.stdout) {
          pending = Buffer.concat([pending, chunk]);
          while (true) {
            if (size < 0) {
              const end = pending.indexOf(10);
              if (end < 0) break;
              const header = pending.subarray(0, end).toString('utf8');
              const match = /^[a-f0-9]+ blob (\d+)$/.exec(header);
              if (!match) throw new Error(`Cannot read Git blob ${batch[index]}: ${header}`);
              size = Number(match[1]);
              pending = pending.subarray(end + 1);
            }
            if (pending.length < size + 1) break;
            if (index >= batch.length || pending[size] !== 10)
              throw new Error('Invalid git cat-file framing.');
            yield { path: batch[index++], data: pending.subarray(0, size) };
            pending = pending.subarray(size + 1);
            size = -1;
          }
        }
      } catch (error) {
        if (child.exitCode === null) child.kill();
        await completion;
        throw gitFailure('git cat-file', stderr, /** @type {Error} */ (error));
      }
      await input;
      const code = await completion;
      if (processError || code !== 0)
        throw gitFailure(`git cat-file (exit ${code})`, stderr, processError);
      if (index !== batch.length || pending.length || size !== -1)
        throw gitFailure('git cat-file', stderr, new Error('Truncated git cat-file output.'));
      report(`AutoEq: read ${start + batch.length}/${paths.length} Git blobs.`);
    } finally {
      child.stdin.destroy();
      if (child.exitCode === null) child.kill();
      await input;
      await completion;
    }
  }
}

/** @param {string} directory @param {string} sha @param {(message: string) => void} [report] @returns {TreeReader} */
export function createGitReader(directory, sha, report = console.warn) {
  return {
    async list() {
      const text = await git(directory, [
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        sha,
        '--',
        'measurements',
        'targets',
      ]);
      return text.split('\0').filter(Boolean).sort(compare);
    },
    read: (paths) => readGitBlobs(directory, sha, paths, report),
  };
}

/** @param {string} cache */
async function newestCached(cache) {
  /** @type {{sha: string, commitDate: string, time: number}[]} */
  const cached = [];
  let directories;
  try {
    directories = await readdir(cache, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
    throw error;
  }
  for (const directory of directories) {
    if (!directory.isDirectory() || !SHA_PATTERN.test(directory.name)) continue;
    try {
      const file = path.join(cache, directory.name, 'autoeq-cache.json');
      const metadata = JSON.parse(await readFile(file, 'utf8'));
      if (metadata.sha === directory.name && Number.isFinite(Date.parse(metadata.commitDate))) {
        cached.push({
          sha: metadata.sha,
          commitDate: metadata.commitDate,
          time: (await stat(file)).mtimeMs,
        });
      }
    } catch {
      /* Ignore incomplete caches, including interrupted fetches. */
    }
  }
  cached.sort(
    (a, b) =>
      Date.parse(b.commitDate) - Date.parse(a.commitDate) ||
      b.time - a.time ||
      compare(a.sha, b.sha),
  );
  return cached[0];
}

/** @param {{sha?: string, cache?: string, fetchImpl?: typeof fetch, report?: (message: string) => void}} [options] */
export async function resolveRevision({
  sha,
  cache = DEFAULT_CACHE,
  fetchImpl = globalThis.fetch,
  report = console.warn,
} = {}) {
  if (sha) {
    if (!SHA_PATTERN.test(sha)) throw new Error('--sha must be a full 40-character commit SHA.');
    return { sha: sha.toLowerCase(), commitDate: undefined };
  }
  try {
    const response = await fetchImpl(
      'https://api.github.com/repos/jaakkopasanen/AutoEq/commits/master',
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'open-auri-autoeq-import' },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const commit = await response.json();
    if (
      !SHA_PATTERN.test(commit.sha) ||
      !Number.isFinite(Date.parse(commit.commit?.committer?.date))
    ) {
      throw new Error('Invalid GitHub commit response.');
    }
    return {
      sha: commit.sha.toLowerCase(),
      commitDate: /** @type {string} */ (commit.commit.committer.date),
    };
  } catch (error) {
    const cached = await newestCached(cache);
    if (!cached)
      throw new Error(
        `Cannot resolve AutoEq master and no cached revision is available: ${error}`,
        { cause: error },
      );
    report(`AutoEq: network unavailable; using cached SHA ${cached.sha} (${error}).`);
    return { sha: cached.sha, commitDate: cached.commitDate };
  }
}

/** Initialize a bare partial clone. In particular, never use checkout or worktree.
 * @param {string} cache @param {string} sha
 */
async function prepareGitCache(cache, sha) {
  const directory = path.resolve(cache, sha);
  await mkdir(directory, { recursive: true });
  try {
    await stat(path.join(directory, 'HEAD'));
  } catch {
    await git(directory, ['init', '--bare']);
  }
  try {
    await git(directory, ['remote', 'get-url', 'origin']);
  } catch {
    await git(directory, ['remote', 'add', 'origin', `${REPOSITORY}.git`]);
  }
  try {
    await git(directory, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    await git(directory, ['fetch', '--filter=blob:none', '--depth=1', 'origin', sha]);
  }
  // Also repair older/incomplete caches: cat-file must be able to fetch missing blobs
  // from origin. Never disable this remote for a batch-check or fetch blob OIDs ourselves.
  await git(directory, ['config', 'core.repositoryformatversion', '1']);
  await git(directory, ['config', 'extensions.partialClone', 'origin']);
  await git(directory, ['config', 'remote.origin.promisor', 'true']);
  await git(directory, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
  const commitDate = (await git(directory, ['show', '-s', '--format=%cI', sha])).trim();
  await writeFile(
    path.join(directory, 'autoeq-cache.json'),
    `${JSON.stringify({ sha, commitDate })}\n`,
  );
  return { directory, commitDate };
}

/** Convert an abstract tree, so tests need neither a network nor a case-sensitive disk.
 * offset is a byte offset into the little-endian pack, always a multiple of 962.
 * @param {{reader: TreeReader, out: string, sha: string, commitDate?: string | null, excluded?: string[], maxPackBytes?: number, generatedAt?: string, report?: (message: string) => void}} options
 */
export async function buildDataset({
  reader,
  out,
  sha,
  commitDate = null,
  excluded = [],
  maxPackBytes = MAX_PACK_BYTES,
  generatedAt = new Date().toISOString(),
  report = console.warn,
}) {
  if (
    !Number.isInteger(maxPackBytes) ||
    maxPackBytes < ENTRY_BYTES ||
    maxPackBytes > MAX_PACK_BYTES
  ) {
    throw new RangeError(`Pack limit must be between ${ENTRY_BYTES} and ${MAX_PACK_BYTES} bytes.`);
  }
  const paths = await reader.list();
  const entries = inferEntries(paths, excluded);
  const sources = [
    ...new Set(entries.filter((entry) => entry.type !== 'target').map((entry) => entry.source)),
  ].sort(compare);
  const namePaths = paths
    .filter((file) => sources.some((source) => file === `measurements/${source}/name_index.tsv`))
    .sort(compare);
  /** @type {Map<string, Map<string, {name: string, brand: string}>>} */
  const names = new Map();
  for await (const blob of reader.read(namePaths))
    names.set(blob.path.split('/')[1], parseNameIndex(blob.data.toString('utf8')));
  await mkdir(out, { recursive: true });
  // Only remove files owned by this pipeline, not unrelated files in a custom --out.
  for (const file of await readdir(out)) {
    if (/^(?:measurements-.+|targets)-\d+\.bin$/.test(file)) await rm(path.join(out, file));
  }
  const metadata = new Map(entries.map((entry) => [entry.path, entry]));
  /** @type {IndexEntry[]} */
  const index = [];
  const counts = { measurements: 0, targets: 0, skipped: 0, clampedValues: 0, packs: 0 };
  /** @type {Map<string, {number: number, parts: Buffer[], bytes: number}>} */
  const packs = new Map();
  /** @param {string} key @param {{number: number, parts: Buffer[], bytes: number}} pack */
  async function flush(key, pack) {
    if (!pack.bytes) return;
    await writeFile(
      path.join(out, `${key}-${String(pack.number).padStart(3, '0')}.bin`),
      Buffer.concat(pack.parts),
    );
    counts.packs++;
    pack.number++;
    pack.parts = [];
    pack.bytes = 0;
  }
  for await (const blob of reader.read(entries.map((entry) => entry.path))) {
    const entry = metadata.get(blob.path);
    if (!entry) throw new Error(`Unexpected blob: ${blob.path}`);
    let result;
    try {
      const measurement = parseMeasurement(blob.data.toString('utf8'), { format: 'autoeq-csv' });
      result = quantize(normalize(toGrid(measurement.frequencies, measurement.values), GRID));
    } catch (error) {
      if (!(error instanceof MeasurementError)) throw error;
      counts.skipped++;
      report(`AutoEq: skipped ${blob.path}: ${error.code}: ${error.message}`);
      continue;
    }
    counts.clampedValues += result.clamps;
    if (result.clamps)
      report(`AutoEq: clamped ${result.clamps} values to ±327.67 dB: ${blob.path}`);
    const key =
      entry.type === 'target' ? 'targets' : `measurements-${entry.sourceSlug}-${entry.type}`;
    let pack = packs.get(key);
    if (!pack) {
      pack = { number: 1, parts: [], bytes: 0 };
      packs.set(key, pack);
    }
    if (pack.bytes + ENTRY_BYTES > maxPackBytes) await flush(key, pack);
    const named = names.get(entry.source)?.get(entry.name);
    const name = named?.name ?? entry.name;
    index.push({
      id: entry.id,
      name,
      brand: entry.type === 'target' ? 'AutoEq' : (named?.brand ?? name.split(/\s+/)[0]),
      source: entry.source,
      type: entry.type,
      pack: `${key}-${String(pack.number).padStart(3, '0')}.bin`,
      offset: pack.bytes,
    });
    pack.parts.push(result.data);
    pack.bytes += result.data.length;
    if (entry.type === 'target') counts.targets++;
    else counts.measurements++;
  }
  for (const [key, pack] of packs) await flush(key, pack);
  index.sort((a, b) => compare(a.id, b.id));
  const manifest = {
    sha,
    commitDate,
    generatedAt,
    grid: { points: GRID.length, minHz: GRID[0], maxHz: GRID[GRID.length - 1] },
    counts,
    sources: sources.map((source) => ({
      name: source,
      measurements: index.filter((entry) => entry.source === source && entry.type !== 'target')
        .length,
      attribution: `Medições: ${source}. Distribuição: AutoEq, Copyright (c) 2018-2022 Jaakko Pasanen, MIT.`,
      link: `${REPOSITORY}/tree/${sha}/measurements/${encodeURIComponent(source)}`,
    })),
    license: 'MIT (AutoEq)',
    excluded: [...new Set(excluded)].sort(compare),
  };
  await writeFile(path.join(out, 'index.json'), `${JSON.stringify(index)}\n`);
  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, index };
}

/** @param {{sha?: string, out?: string, cache?: string, excluded?: string[], fromTree?: string, fetchImpl?: typeof fetch, report?: (message: string) => void}} [options] */
export async function importAutoEq({
  sha,
  out = 'web/static/data/autoeq',
  cache = DEFAULT_CACHE,
  excluded = [],
  fromTree,
  fetchImpl,
  report = console.warn,
} = {}) {
  if (fromTree) {
    if (sha && !SHA_PATTERN.test(sha))
      throw new Error('--sha must be a full 40-character commit SHA.');
    return buildDataset({
      reader: createTreeReader(fromTree),
      out,
      sha: sha ?? 'from-tree',
      excluded,
      report,
    });
  }
  const revision = await resolveRevision({ sha, cache, fetchImpl, report });
  report(`AutoEq: preparing Git cache for ${revision.sha}.`);
  const prepared = await prepareGitCache(cache, revision.sha);
  return buildDataset({
    reader: createGitReader(prepared.directory, revision.sha, report),
    out,
    sha: revision.sha,
    commitDate: prepared.commitDate,
    excluded,
    report,
  });
}

export const USAGE =
  'node tools/import-autoeq.mjs [--sha <sha>] [--out web/static/data/autoeq] [--cache <dir>] [--exclude-source <name>]... [--from-tree <dir>]';

/** @param {string[]} args */
export function parseArgs(args) {
  /** @type {{sha?: string, out?: string, cache?: string, excluded: string[], fromTree?: string, help?: boolean}} */
  const options = { excluded: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (!['--sha', '--out', '--cache', '--exclude-source', '--from-tree'].includes(flag))
      throw new Error(`Unknown option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--exclude-source') options.excluded.push(value);
    else if (flag === '--from-tree') options.fromTree = value;
    else if (flag === '--sha') options.sha = value;
    else if (flag === '--out') options.out = value;
    else options.cache = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(USAGE);
    else {
      const { manifest } = await importAutoEq(options);
      console.log(
        `AutoEq ${manifest.sha}: ${JSON.stringify(manifest.counts)} -> ${options.out ?? 'web/static/data/autoeq'}`,
      );
    }
  } catch (error) {
    console.error(
      `AutoEq import failed: ${error instanceof Error ? error.message : error}\n${USAGE}`,
    );
    process.exitCode = 1;
  }
}
