import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectBundledPackages, generateNotices } from '../../tools/third-party-notices.mjs';

const script = fileURLToPath(new URL('../../tools/third-party-notices.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'third-party-notices-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  const pkg = (
    name,
    version = '1.0.0',
    files = { LICENSE: `Full license of ${name}\n` },
    extra = {},
    location = `node_modules/${name}`,
  ) => {
    put(`${location}/package.json`, JSON.stringify({ name, version, license: 'MIT', ...extra }));
    for (const [file, text] of Object.entries(files)) put(`${location}/${file}`, text);
    return join(root, location);
  };
  const map = (name, sources, extra = {}) =>
    put(`web/.svelte-kit/output/${name}.map`, JSON.stringify({ version: 3, sources, ...extra }));
  const run = (...args) =>
    spawnSync(process.execPath, [script, '--root', root, ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  return { root, put, pkg, map, run, output: join(root, 'web/static/third-party-licenses.txt') };
}

test('collects all client/server maps, scopes, Windows separators, sourceRoot and indexed maps', (t) => {
  const repo = fixture(t);
  for (const name of [
    'svelte',
    '@sveltejs/kit',
    'better-auth',
    '@better-fetch/fetch',
    'nanostores',
    'uqr',
    'zod',
  ]) {
    repo.pkg(name);
  }
  repo.pkg('build-only'); // Merely installed, not bundled: must not be listed.
  repo.map('client/chunks/a.js', [
    '../../../../../../node_modules/svelte/src/index.js',
    '../../../../../../node_modules/@sveltejs/kit/src/runtime/client.js',
    'C:\\project\\node_modules\\better-auth\\dist\\client.js',
    '/project/node_modules/@better-fetch/fetch/dist/index.js',
    '../../../../../../src/app.ts',
  ]);
  repo.map('server/chunks/b.js', ['nanostores/index.js', 'uqr/index.js'], {
    sourceRoot: '../../../../../node_modules',
  });
  repo.map('server/chunks/indexed.js', [], {
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: { sources: ['../../../../../../node_modules/zod/index.js'] },
      },
    ],
  });
  assert.deepEqual(
    collectBundledPackages(repo.root)
      .map((ref) => ref.name)
      .sort(),
    ['@better-fetch/fetch', '@sveltejs/kit', 'better-auth', 'nanostores', 'svelte', 'uqr', 'zod'],
  );
  const { text, count } = generateNotices({ root: repo.root });
  assert.equal(count, 7);
  assert.doesNotMatch(text, /build-only/);
  assert.equal(readFileSync(repo.output, 'utf8'), text);
});

test('reads metadata without package exports and writes complete, deterministic license and NOTICE texts', (t) => {
  const repo = fixture(t);
  repo.pkg(
    'zod',
    '4.0.0',
    { 'LICENCE.txt': '\uFEFFCopyright Z\r\nAll terms\r\n', NOTICE: 'Additional attribution\n' },
    { exports: { '.': './index.js' } },
  );
  repo.pkg(
    '@scope/a',
    '2.0.0',
    { 'COPYING-MIT': 'MIT terms\n', 'LICENSE-APACHE': 'Apache terms\n' },
    { license: '(MIT OR Apache-2.0)' },
  );
  const first = generateNotices({ root: repo.root, packages: ['zod', '@scope/a', 'zod'] });
  const second = generateNotices({ root: repo.root, packages: ['@scope/a', 'zod'] });
  assert.equal(first.text, second.text);
  assert.equal(first.count, 2);
  assert.ok(first.text.indexOf('Package: @scope/a') < first.text.indexOf('Package: zod'));
  assert.match(first.text, /Version: 2\.0\.0\nLicense: \(MIT OR Apache-2\.0\)/);
  assert.match(first.text, /--- COPYING-MIT ---\nMIT terms\n/);
  assert.match(first.text, /--- LICENSE-APACHE ---\nApache terms\n/);
  assert.match(first.text, /--- LICENCE.txt ---\nCopyright Z\nAll terms\n/);
  assert.match(first.text, /--- NOTICE ---\nAdditional attribution\n/);
  assert.ok(!first.text.includes(repo.root));
  assert.doesNotMatch(first.text, /\r|\uFEFF/);
  assert.doesNotMatch(first.text, /license text from SPDX template/);
});

test('preserves nested package versions and deduplicates repeated source references', (t) => {
  const repo = fixture(t);
  const parent = repo.pkg('parent');
  repo.pkg('shared', '1.0.0');
  repo.pkg('shared', '2.0.0', undefined, {}, 'node_modules/parent/node_modules/shared');
  repo.map('server/chunks/a.js', [
    `${parent}/node_modules/shared/index.js`,
    `${repo.root}/node_modules/shared/index.js`,
    `${parent}/node_modules/shared/other.js`,
  ]);
  const { text, count } = generateNotices({ root: repo.root });
  assert.equal(count, 2);
  assert.match(text, /Package: shared\nVersion: 1\.0\.0/);
  assert.match(text, /Package: shared\nVersion: 2\.0\.0/);
  assert.doesNotMatch(text, /Package: parent/);
});

test('includes generated Paraglide runtime and resvg WASM packages/aliases missing from JS sources', (t) => {
  const repo = fixture(t);
  repo.pkg('@inlang/paraglide-js');
  repo.pkg(
    '@cf-wasm/resvg',
    '0.4.0',
    { 'LICENSE.md': 'Full MPL-2.0 text\n' },
    {
      license: 'MPL-2.0',
      dependencies: {
        '@resvg/resvg-wasm': '2.6.2',
        '@resvg/resvg-wasm-legacy': 'npm:@resvg/resvg-wasm@2.4.1',
      },
    },
  );
  repo.pkg('@resvg/resvg-wasm', '2.6.2', {}, { license: 'MPL-2.0' });
  repo.pkg(
    '@resvg/resvg-wasm',
    '2.4.1',
    {},
    { license: 'MPL-2.0' },
    'node_modules/@resvg/resvg-wasm-legacy',
  );
  repo.map('server/og.js', [
    `${repo.root}/node_modules/@cf-wasm/resvg/dist/workerd.js`,
    '../../../../../src/lib/paraglide/runtime.js',
  ]);
  const { text, count } = generateNotices({ root: repo.root });
  assert.equal(count, 4);
  assert.match(text, /Package: @inlang\/paraglide-js/);
  assert.match(
    text,
    /Package: @resvg\/resvg-wasm\nVersion: 2\.4\.1\nLicense: MPL-2\.0\nInstalled as: @resvg\/resvg-wasm-legacy/,
  );
  assert.match(text, /MPL-2.0 text from @cf-wasm\/resvg/);
  assert.equal(text.match(/Full MPL-2.0 text/g).length, 3);
});

test('CLI supports map discovery and explicit package names without network or a build', (t) => {
  const repo = fixture(t);
  repo.pkg('uqr');
  let result = repo.run('uqr');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Wrote 1 package notices/);
  const explicit = readFileSync(repo.output, 'utf8');
  repo.map('client/entry.js', [`${repo.root}/node_modules/uqr/index.js`]);
  result = repo.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(repo.output, 'utf8'), explicit);
  for (const args of [['--root'], ['--unknown'], ['../escape']]) {
    const invalid = repo.run(...args);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage:|Invalid package name/);
  }
});

test('includes SSR externals, dynamic imports, re-exports and their production dependency closure', (t) => {
  const repo = fixture(t);
  repo.pkg('client-runtime');
  repo.pkg('server-runtime', '1.0.0', undefined, { dependencies: { transitive: '*' } });
  repo.pkg('transitive', '1.0.0', undefined, { dependencies: { 'server-runtime': '*' } });
  repo.pkg('dynamic');
  repo.pkg('@scope/reexport');
  repo.pkg('commonjs');
  repo.put('package.json', JSON.stringify({ name: 'open-auri', workspaces: ['web'] }));
  repo.put('web/package.json', JSON.stringify({ name: 'open-auri-web' }));
  repo.map('client/a.js', [`${repo.root}/node_modules/client-runtime/index.js`]);
  repo.put(
    'web/.svelte-kit/output/server/chunks/external.js',
    `
    import { runtime } from 'server-runtime/subpath';
    export { item } from '@scope/reexport';
    const dynamic = () => import('dynamic');
    const cjs = require('commonjs');
    import 'node:crypto';
    import 'fs/promises';
    import 'cloudflare:workers';
    import './local.js';
    import 'open-auri/dsp';
    import 'open-auri-web';
    // import('not-a-package')
    /** @type {import('not-types-either').Type} */
    const text = "import('not-code')";
  `,
  );
  const { text, count } = generateNotices({ root: repo.root });
  assert.equal(count, 6);
  for (const name of [
    'client-runtime',
    'server-runtime',
    'transitive',
    'dynamic',
    '@scope/reexport',
    'commonjs',
  ]) {
    assert.ok(text.includes(`Package: ${name}\n`));
  }
  assert.doesNotMatch(text, /not-a-package|not-types-either|not-code|Package: open-auri/);
});

test('fails closed for absent/empty/malformed maps and maps with no packages', (t) => {
  const repo = fixture(t);
  assert.throws(() => generateNotices({ root: repo.root }), /Build first/);
  mkdirSync(join(repo.root, 'web/.svelte-kit/output'), { recursive: true });
  assert.throws(() => generateNotices({ root: repo.root }), /no .map files/);
  const file = repo.map('client/a.js', []);
  assert.throws(() => generateNotices({ root: repo.root }), /No bundled npm packages/);
  for (const invalid of ['{', 'null', '{}', '{"sources":[1]}']) {
    writeFileSync(file, invalid);
    assert.throws(() => generateNotices({ root: repo.root }));
  }
});

test('missing packages, metadata or unknown license text fail without overwriting existing notices', (t) => {
  const repo = fixture(t);
  repo.put('web/static/third-party-licenses.txt', 'keep existing notices\n');
  repo.pkg('no-license', '1.0.0', {}, { license: 'LicenseRef-Unknown' });
  repo.pkg('empty-license', '1.0.0', { LICENSE: ' \n' });
  repo.pkg('no-id', '1.0.0', undefined, { license: null });
  repo.pkg('no-name', '1.0.0', undefined, { name: '' });
  repo.pkg('no-version', '', undefined);
  for (const name of ['missing', 'no-license', 'empty-license', 'no-id', 'no-name', 'no-version']) {
    assert.throws(
      () => generateNotices({ root: repo.root, packages: [name] }),
      /Package not installed|Missing|Empty/,
    );
    assert.equal(readFileSync(repo.output, 'utf8'), 'keep existing notices\n');
  }
  const result = repo.run('no-license');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing LICENSE\/LICENCE\/COPYING/);
});

test('uses the MPL template without a matching donor, never an unrelated local license', (t) => {
  const repo = fixture(t);
  repo.pkg('@resvg/resvg-wasm', '2.6.2', {}, { license: 'MPL-2.0' });
  const absent = generateNotices({ root: repo.root, packages: ['@resvg/resvg-wasm'] });
  assert.match(absent.text, /license text from SPDX template; package ships no license file/);
  repo.pkg('@cf-wasm/resvg', '0.4.0', { LICENSE: 'Different terms\n' });
  const mismatch = generateNotices({ root: repo.root, packages: ['@resvg/resvg-wasm'] });
  assert.equal(mismatch.text, absent.text);
  assert.doesNotMatch(mismatch.text, /Different terms/);
  assert.throws(() => generateNotices({ root: repo.root, packages: [] }), /No packages selected/);
});

test('uses complete SPDX templates for known ids, with metadata attribution and provenance', (t) => {
  const repo = fixture(t);
  const packages = [
    ['@better-auth/utils', 'MIT', { author: 'Bereket Engida' }],
    ['isc-package', 'ISC', { author: { name: 'Ada' }, contributors: ['Zoe', { name: 'Ada' }] }],
    ['bsd-two', 'BSD-2-Clause', { contributors: [{ name: 'Bea' }, 'Alex'] }],
    ['bsd-three', 'BSD-3-Clause', {}],
    ['zero-bsd', '0BSD', { author: { email: 'no-name@example.test' }, contributors: [null, ''] }],
    ['apache-package', 'Apache-2.0', {}],
    ['mpl-package', 'MPL-2.0', {}],
  ];
  for (const [name, license, extra] of packages) {
    repo.pkg(name, '1.0.0', {}, { license, ...extra });
  }
  // A published NOTICE must still be included when LICENSE is absent.
  repo.put('node_modules/apache-package/NOTICE', 'Additional Apache attribution\n');
  const names = packages.map(([name]) => name);
  const first = generateNotices({ root: repo.root, packages: names });
  const second = generateNotices({ root: repo.root, packages: [...names].reverse() });
  assert.equal(first.text, second.text);
  assert.equal(first.count, 7);
  assert.equal(
    first.text.match(/\(license text from SPDX template; package ships no license file\)/g).length,
    7,
  );
  assert.match(first.text, /Copyright \(c\) Bereket Engida contributors/);
  assert.match(first.text, /Copyright \(c\) Ada, Zoe contributors/);
  assert.match(first.text, /Copyright \(c\) Alex, Bea contributors/);
  assert.match(first.text, /Copyright \(c\) the bsd-three authors/);
  assert.match(first.text, /Copyright \(c\) the zero-bsd authors/);
  assert.match(
    first.text,
    /OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE\./,
  );
  assert.match(first.text, /PERFORMANCE OF THIS SOFTWARE\./);
  assert.match(first.text, /Neither the name of the copyright holder/);
  assert.match(first.text, /POSSIBILITY OF SUCH DAMAGE\./);
  assert.match(first.text, /9\. Accepting Warranty or Additional Liability/);
  assert.match(first.text, /limitations under the License\./);
  assert.match(first.text, /Exhibit B - "Incompatible With Secondary Licenses" Notice/);
  assert.match(first.text, /defined by the Mozilla Public License, v\. 2\.0\./);
  assert.match(first.text, /--- NOTICE ---\nAdditional Apache attribution\n/);
  assert.doesNotMatch(first.text, /\{\{copyright\}\}/);
  const cli = repo.run('@better-auth/utils');
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(readFileSync(repo.output, 'utf8'), /Copyright \(c\) Bereket Engida contributors/);
});

test('does not guess SPDX expressions, unknown identifiers or inherited object properties', (t) => {
  const repo = fixture(t);
  repo.put('web/static/third-party-licenses.txt', 'keep existing notices\n');
  for (const license of ['Unknown-1.0', 'MIT OR ISC', 'toString', 'constructor']) {
    repo.pkg('unknown', '1.0.0', {}, { license });
    assert.throws(
      () => generateNotices({ root: repo.root, packages: ['unknown'] }),
      /Missing LICENSE\/LICENCE\/COPYING/,
    );
    assert.equal(readFileSync(repo.output, 'utf8'), 'keep existing notices\n');
  }
  repo.pkg('missing-id', '1.0.0', {}, { license: null });
  assert.throws(
    () => generateNotices({ root: repo.root, packages: ['missing-id'] }),
    /Missing package license/,
  );
  assert.equal(readFileSync(repo.output, 'utf8'), 'keep existing notices\n');
});
