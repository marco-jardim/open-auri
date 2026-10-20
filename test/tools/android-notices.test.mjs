import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_SPDX,
  parseArgs,
  renderNotices,
  validateArtifacts,
} from '../../tools/android-notices.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'tools/android-notices.mjs');
const releaseReport = join(
  root,
  'apps/android/android/app/build/reports/licensee/androidRelease/artifacts.json',
);
const committedOutput = join(root, 'web/static/third-party-licenses-android.txt');
const sample = JSON.parse(`[
  {
    "groupId": "org.example", "artifactId": "native", "version": "2.0.0",
    "name": "Example native library",
    "spdxLicenses": [
      { "identifier": "MIT", "name": "MIT License", "url": "https://opensource.org/licenses/MIT" },
      { "identifier": "Apache-2.0", "name": "Apache License 2.0", "url": "https://www.apache.org/licenses/LICENSE-2.0" }
    ],
    "unknownLicenses": [{ "name": "Additional notice", "url": "https://example.test/notice" }],
    "scm": { "url": "https://example.test/native" }
  }
]`);

function fixture(t) {
  const directory = mkdtempSync(join(root, 'test/.android-notices-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, 'artifacts.json');
  const output = join(directory, 'notices.txt');
  const put = (report) => writeFileSync(input, JSON.stringify(report), 'utf8');
  put(sample);
  const run = (...args) =>
    spawnSync(process.execPath, [script, '--input', input, '--output', output, ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  return { input, output, put, run };
}

test('renders Licensee sample JSON with coordinates, project, SCM, SPDX identifiers and URLs', () => {
  const before = JSON.stringify(sample);
  const text = renderNotices(sample);
  assert.match(
    text,
    /^Third-party licenses for the open-auri Android app \(native dependencies\)\n/,
  );
  assert.match(text, /Repository: https:\/\/github.com\/marco-jardim\/open-auri\n/);
  assert.match(text, /Generated from the Licensee androidRelease artifacts.json report/);
  assert.match(text, /Coordinates: org.example:native:2.0.0\nVersion: 2.0.0\n/);
  assert.match(text, /Project: Example native library\nSCM: https:\/\/example.test\/native\n/);
  assert.match(
    text,
    /SPDX: Apache-2.0 \(Apache License 2.0\)\nLicense URL: https:\/\/www.apache.org\/licenses\/LICENSE-2.0\n/,
  );
  assert.match(
    text,
    /SPDX: MIT \(MIT License\)\nLicense URL: https:\/\/opensource.org\/licenses\/MIT\n/,
  );
  assert.match(
    text,
    /Other reported license: Additional notice \(https:\/\/example.test\/notice\)\n/,
  );
  assert.ok(text.endsWith('\n'));
  assert.doesNotMatch(text, /\r/);
  assert.equal(JSON.stringify(sample), before, 'rendering must not mutate the report');
});

test('accepts every allowed SPDX identifier and uses its SPDX URL when the report omits a URL', () => {
  for (const identifier of ALLOWED_SPDX) {
    const text = renderNotices([{ ...sample[0], spdxLicenses: [{ identifier }] }]);
    assert.ok(text.includes(`SPDX: ${identifier}\n`));
    assert.ok(text.includes(`License URL: https://spdx.org/licenses/${identifier}.html\n`));
  }
});

test('rejects every disallowed SPDX even when another license on the artifact is allowed', () => {
  for (const identifier of ['GPL-3.0-only', 'ISC', 'MIT OR Apache-2.0', 'mit', 'Unknown-1.0']) {
    assert.throws(
      () =>
        renderNotices([{ ...sample[0], spdxLicenses: [{ identifier: 'MIT' }, { identifier }] }]),
      (error) => {
        assert.match(error.message, /Disallowed SPDX license/);
        assert.ok(error.message.includes(identifier));
        assert.ok(error.message.includes('org.example:native:2.0.0'));
        return true;
      },
    );
  }
});

test('rejects artifacts without an SPDX license, including unknown-only and omitted arrays', () => {
  const bare = { ...sample[0] };
  delete bare.spdxLicenses;
  delete bare.unknownLicenses;
  for (const artifact of [
    bare,
    { ...bare, spdxLicenses: [] },
    { ...bare, spdxLicenses: [], unknownLicenses: [] },
    { ...bare, unknownLicenses: [{ name: 'Unknown', url: 'https://example.test/license' }] },
  ]) {
    assert.throws(() => renderNotices([artifact]), /No SPDX license: org.example:native:2.0.0/);
  }
});

test('omitted optional arrays and metadata behave like empty arrays; accepts SCM strings', () => {
  const minimal = {
    groupId: 'org.example',
    artifactId: 'minimal',
    version: '1.0',
    spdxLicenses: [{ identifier: 'MIT' }],
  };
  assert.equal(renderNotices([minimal]), renderNotices([{ ...minimal, unknownLicenses: [] }]));
  assert.deepEqual(validateArtifacts([minimal])[0].unknownLicenses, []);
  assert.doesNotMatch(renderNotices([minimal]), /undefined|null|Project:|SCM:/);
  assert.match(
    renderNotices([{ ...minimal, scm: 'https://example.test/source' }]),
    /SCM: https:\/\/example.test\/source\n/,
  );
});

test('sorts by full coordinates and license text deterministically, independent of input order', () => {
  const report = [
    { ...sample[0], groupId: 'z.example' },
    { ...sample[0], artifactId: 'z-native' },
    { ...sample[0], version: '10.0.0' },
    ...sample,
  ];
  const text = renderNotices(report);
  const reversed = report.toReversed().map((artifact) => ({
    ...artifact,
    spdxLicenses: artifact.spdxLicenses.toReversed(),
  }));
  assert.equal(text, renderNotices(reversed));
  assert.deepEqual(
    [...text.matchAll(/^Coordinates: (.+)$/gm)].map((match) => match[1]),
    [
      'org.example:native:10.0.0',
      'org.example:native:2.0.0',
      'org.example:z-native:2.0.0',
      'z.example:native:2.0.0',
    ],
  );
  assert.ok(text.indexOf('SPDX: Apache-2.0') < text.indexOf('SPDX: MIT'));
});

test('rejects malformed reports instead of silently omitting native dependencies', () => {
  for (const invalid of [
    null,
    {},
    [],
    [null],
    [{ ...sample[0], groupId: '' }],
    [{ ...sample[0], version: 1 }],
    [{ ...sample[0], spdxLicenses: null }],
    [{ ...sample[0], spdxLicenses: [{}] }],
    [{ ...sample[0], unknownLicenses: {} }],
  ]) {
    assert.throws(() => renderNotices(invalid));
  }
});

test('CLI generates notices and --check detects drift or missing output without writing', (t) => {
  const repo = fixture(t);
  const missing = repo.run('--check');
  assert.equal(missing.status, 1);
  assert.equal(existsSync(repo.output), false);
  const generated = repo.run();
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(readFileSync(repo.output, 'utf8'), renderNotices(sample));
  const checked = repo.run('--check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /up to date/);
  writeFileSync(repo.output, 'stale notices\n');
  const stale = repo.run('--check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Android notices drift/);
  assert.equal(readFileSync(repo.output, 'utf8'), 'stale notices\n');
});

test('CLI fails with exit 1 for bad licenses or JSON and preserves existing output', (t) => {
  const repo = fixture(t);
  writeFileSync(repo.output, 'keep existing notices\n');
  for (const report of [
    [{ ...sample[0], spdxLicenses: [{ identifier: 'GPL-3.0-only' }] }],
    [{ ...sample[0], spdxLicenses: [] }],
  ]) {
    repo.put(report);
    for (const args of [[], ['--check']]) {
      const result = repo.run(...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Disallowed SPDX license|No SPDX license/);
      assert.equal(readFileSync(repo.output, 'utf8'), 'keep existing notices\n');
    }
  }
  writeFileSync(repo.input, '{ invalid JSON');
  assert.equal(repo.run().status, 1);
  assert.equal(readFileSync(repo.output, 'utf8'), 'keep existing notices\n');
});

test('CLI defaults point at the release report and static notices; rejects invalid arguments', (t) => {
  assert.deepEqual(parseArgs([]), { input: releaseReport, output: committedOutput, check: false });
  const repo = fixture(t);
  for (const args of [
    ['--input'],
    ['--output'],
    ['--input', '--check'],
    ['--unknown'],
    ['extra'],
  ]) {
    const result = repo.run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: node tools\/android-notices.mjs/);
  }
});

test('SPDX allow list exactly matches the Android Gradle Licensee policy', () => {
  const gradle = readFileSync(join(root, 'apps/android/android/app/build.gradle'), 'utf8');
  const block = gradle.match(/\blicensee\s*\{([\s\S]*?)^\}/m)?.[1];
  assert.ok(block, 'Gradle must configure Licensee');
  const allowed = [...block.matchAll(/\ballow\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map(
    (match) => match[2],
  );
  assert.deepEqual(allowed.sort(), [...ALLOWED_SPDX].sort());
});

test('footer links both native Android and web notices with both locale messages', () => {
  const footer = readFileSync(join(root, 'web/src/lib/components/chrome/Footer.svelte'), 'utf8');
  assert.match(
    footer,
    /href="\/third-party-licenses-android\.txt">\{m\.chrome_android_licenses_link\(\)\}/,
  );
  assert.match(
    footer,
    /href="\/third-party-licenses\.txt">\{m\.chrome_third_party_licenses_link\(\)\}/,
  );
  const expected = {
    'pt-BR': ['Licenças do app Android', 'Licenças de terceiros'],
    'en-US': ['Android app licenses', 'Third-party licenses'],
  };
  for (const [locale, labels] of Object.entries(expected)) {
    const staged = join(root, `web/messages/_staging/T3.3.${locale}.json`);
    const messages = JSON.parse(
      readFileSync(existsSync(staged) ? staged : join(root, `web/messages/${locale}.json`), 'utf8'),
    );
    assert.equal(messages.chrome_android_licenses_link, labels[0]);
    assert.equal(messages.chrome_third_party_licenses_link, labels[1]);
  }
});

test(
  'committed native notices match the real release report when available',
  {
    skip: !existsSync(releaseReport),
  },
  () => {
    const result = spawnSync(process.execPath, [script, '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  },
);
