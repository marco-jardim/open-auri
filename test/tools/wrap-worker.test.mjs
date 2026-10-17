// web/scripts/wrap-worker.mjs (#33): the post-build step that puts the canonical-host wrapper in
// front of the adapter's Worker entry.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ENTRY,
  INNER,
  MARKER,
  WORKER,
  wrapWorker,
  wrapperSource,
} from '../../web/scripts/wrap-worker.mjs';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const SCRIPT = join(WEB, 'scripts', 'wrap-worker.mjs');
/** What @sveltejs/adapter-cloudflare appends to .assetsignore (no trailing newline). */
const ADAPTER_IGNORE = '\n_worker.js\n_routes.json\n_headers\n_redirects';
const ADAPTER_WORKER =
  "import { server } from './../cloudflare-tmp/server.js';\nexport default { fetch() {} };\n";

/** A build directory like .svelte-kit/cloudflare plus a wrapper entry on the same drive. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wrap-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'cloudflare');
  mkdirSync(dir);
  mkdirSync(join(root, 'src'));
  const entry = join(root, 'src', 'entry.ts');
  writeFileSync(entry, 'export const withCanonicalHost = (handler) => handler;\n');
  writeFileSync(join(dir, WORKER), ADAPTER_WORKER);
  writeFileSync(join(dir, '.assetsignore'), ADAPTER_IGNORE);
  const read = (name) => readFileSync(join(dir, name), 'utf8');
  return { dir, entry, read };
}

test('renames the adapter entry, writes the wrapper and keeps the server code out of assets', (t) => {
  const { dir, entry, read } = fixture(t);
  assert.equal(wrapWorker(dir, entry), 'wrapped');
  assert.equal(read(INNER), ADAPTER_WORKER, 'adapter entry kept byte for byte, imports included');
  const wrapper = read(WORKER);
  assert.ok(wrapper.startsWith(MARKER));
  assert.deepEqual(wrapper.split('\n').slice(1), [
    'import sveltekit from "./_sveltekit.js";',
    'import { withCanonicalHost } from "../src/entry.ts";',
    'export * from "./_sveltekit.js";',
    'export default withCanonicalHost(sveltekit);',
    '',
  ]);
  const ignored = read('.assetsignore').split('\n').filter(Boolean);
  assert.deepEqual(ignored, ['_worker.js', '_routes.json', '_headers', '_redirects', INNER]);
});

test('is idempotent and re-wraps only a fresh adapter entry', (t) => {
  const { dir, entry, read } = fixture(t);
  wrapWorker(dir, entry);
  const wrapper = read(WORKER);
  assert.equal(wrapWorker(dir, entry), 'unchanged');
  assert.equal(read(WORKER), wrapper);
  assert.equal(read(INNER), ADAPTER_WORKER, 'the wrapper is never wrapped');
  // A new `vite build` writes a new adapter entry; the step wraps that one.
  const rebuilt = `${ADAPTER_WORKER}// rebuilt\n`;
  writeFileSync(join(dir, WORKER), rebuilt);
  assert.equal(wrapWorker(dir, entry), 'wrapped');
  assert.equal(read(INNER), rebuilt);
  assert.equal(read(WORKER), wrapper);
  const ignored = read('.assetsignore').split('\n').filter(Boolean);
  assert.equal(ignored.filter((line) => line === INNER).length, 1);
});

test('creates .assetsignore with both entries when the adapter wrote none', (t) => {
  const { dir, entry, read } = fixture(t);
  rmSync(join(dir, '.assetsignore'));
  wrapWorker(dir, entry);
  assert.equal(read('.assetsignore'), `${WORKER}\n${INNER}\n`);
});

test('fails without a built entry and leaves the directory untouched', (t) => {
  const { dir, entry } = fixture(t);
  rmSync(join(dir, WORKER));
  assert.throws(() => wrapWorker(dir, entry), /run vite build first/);
  assert.ok(!existsSync(join(dir, WORKER)));
  assert.ok(!existsSync(join(dir, INNER)));
  const result = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /run vite build first/);
  const usage = spawnSync(process.execPath, [SCRIPT, dir, 'extra'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage:/);
});

test('the real build wraps .svelte-kit/cloudflare with src/worker-entry/canonical-host.ts', () => {
  assert.equal(ENTRY, join(WEB, 'src', 'worker-entry', 'canonical-host.ts'));
  assert.match(readFileSync(ENTRY, 'utf8'), /export function withCanonicalHost\b/);
  assert.match(
    wrapperSource(join(WEB, '.svelte-kit', 'cloudflare')),
    /^import \{ withCanonicalHost \} from "\.\.\/\.\.\/src\/worker-entry\/canonical-host\.ts";$/m,
  );
  const { scripts } = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8'));
  assert.equal(scripts.build, 'vite build && node scripts/wrap-worker.mjs');
});
