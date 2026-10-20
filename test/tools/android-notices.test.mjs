import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_SPDX,
  parseArgs,
  readBundledProjects,
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
const mitLicense = `MIT License

Copyright (c) 2026 Fixture Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const bsdLicense = (clauses) => `BSD ${clauses}-Clause License

Copyright (c) 2026 Fixture Authors

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
${clauses === 3 ? `3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.\n` : ''}
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;
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
sample[0].licenseText = mitLicense;

function fixture(t) {
  const directory = mkdtempSync(join(root, 'test/.android-notices-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, 'artifacts.json');
  const output = join(directory, 'notices.txt');
  const write = (name, text) => {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  };
  write(
    'apps/android/android/settings.gradle',
    `include ':app'
include ':capacitor-cordova-android-plugins'
project(':capacitor-cordova-android-plugins').projectDir = new File('./capacitor-cordova-android-plugins/')
apply from: 'capacitor.settings.gradle'
`,
  );
  write(
    'apps/android/android/capacitor.settings.gradle',
    `include ':capacitor-android'
project(':capacitor-android').projectDir = new File('../../../node_modules/@capacitor/android/capacitor')
`,
  );
  write(
    'apps/android/android/capacitor-cordova-android-plugins/src/main/AndroidManifest.xml',
    '<manifest><application></application></manifest>',
  );
  write(
    'node_modules/@capacitor/android/package.json',
    JSON.stringify({ name: '@capacitor/android', version: '1.2.3', license: 'MIT' }),
  );
  write('node_modules/@capacitor/android/LICENSE', mitLicense);
  mkdirSync(join(directory, 'node_modules/@capacitor/android/capacitor'), { recursive: true });
  const put = (report) => writeFileSync(input, JSON.stringify(report), 'utf8');
  put(sample);
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [script, '--input', input, '--output', output, '--project-root', directory, ...args],
      { cwd: root, encoding: 'utf8' },
    );
  return { directory, input, output, put, run, write, projects: () => readBundledProjects(directory) };
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
    licenseText: mitLicense,
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
  assert.equal(readFileSync(repo.output, 'utf8'), renderNotices(sample, repo.projects()));
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
  assert.deepEqual(parseArgs([]), {
    input: releaseReport,
    output: committedOutput,
    projectRoot: root,
    check: false,
  });
  const repo = fixture(t);
  for (const args of [
    ['--input'],
    ['--output'],
    ['--project-root'],
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

test('bundled projects come from Gradle settings and preserve complete npm license text', (t) => {
  const repo = fixture(t);
  repo.write('node_modules/@capacitor/android/LICENSE', `${mitLicense.replaceAll('\n', '\r\n')}\r\n`);
  const projects = repo.projects();
  assert.deepEqual(
    projects.map(({ project }) => project),
    [':capacitor-android', ':capacitor-cordova-android-plugins'],
  );
  assert.equal(projects[0].packageName, '@capacitor/android');
  assert.equal(projects[0].version, '1.2.3');
  assert.equal(projects[0].license, 'MIT');
  assert.equal(projects[0].licenseText, mitLicense);
  const text = renderNotices(sample, projects);
  assert.match(text, /Bundled project dependencies\n/);
  assert.ok(text.includes(`Full license text:\n${mitLicense}\n`));
  assert.match(text, /Generated empty Cordova container/);
  assert.equal(text, renderNotices(sample, projects.toReversed()));
  assert.doesNotMatch(text, /\r/);
});

test('MIT/BSD entries cannot silently become URL-only notices', (t) => {
  const repo = fixture(t);
  for (const license of ['MIT', 'BSD-2-Clause', 'BSD-3-Clause']) {
    const fullText = license === 'MIT' ? mitLicense : bsdLicense(license === 'BSD-2-Clause' ? 2 : 3);
    repo.write(
      'node_modules/@capacitor/android/package.json',
      JSON.stringify({ name: '@capacitor/android', version: '1.2.3', license }),
    );
    repo.write('node_modules/@capacitor/android/LICENSE', fullText);
    const text = renderNotices(sample, repo.projects());
    assert.ok(text.includes(`SPDX: ${license}\nFull license text:\n${fullText}\n`));
    assert.throws(
      () => renderNotices(sample, [{ ...repo.projects()[0], licenseText: undefined }]),
      /Missing license text/,
    );
    assert.throws(
      () => renderNotices([{
        ...sample[0], licenseText: undefined, spdxLicenses: [{ identifier: license }],
      }]),
      /Missing copyright-bearing MIT\/BSD license text/,
    );
  }
  rmSync(join(repo.directory, 'node_modules/@capacitor/android/LICENSE'));
  assert.throws(repo.projects, /Missing license text/);
});

test('canonical Apache-2.0 license is complete, at the end and emitted exactly once', () => {
  const text = renderNotices([sample[0], { ...sample[0], artifactId: 'second' }], [
    {
      project: ':apache-project',
      packageName: '@example/apache',
      version: '1.0.0',
      license: 'Apache-2.0',
    },
  ]);
  assert.equal(text.match(/TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/g).length, 1);
  assert.match(text, /Full Apache-2.0 text: see the canonical license at the end of this file/);
  for (const heading of [
    '1. Definitions.',
    '4. Redistribution.',
    '9. Accepting Warranty or Additional Liability.',
    'END OF TERMS AND CONDITIONS',
    'APPENDIX: How to apply the Apache License to your work.',
  ]) {
    assert.ok(text.includes(heading));
  }
  assert.ok(text.endsWith('limitations under the License.\n'));
});

test('new local projects and nonempty generated Cordova code fail closed', (t) => {
  const repo = fixture(t);
  const source = 'apps/android/android/capacitor-cordova-android-plugins/src/main/java/ThirdParty.java';
  repo.write(source, 'class ThirdParty {}');
  assert.throws(repo.projects, /Bundled Cordova code needs explicit package license attribution/);
  rmSync(join(repo.directory, source));
  repo.write(
    'apps/android/android/capacitor.settings.gradle',
    `include ':unattributed'\nproject(':unattributed').projectDir = new File('./unattributed')\n`,
  );
  assert.throws(repo.projects, /no backing npm package/);
  repo.write('apps/android/android/capacitor.settings.gradle', `include ':missing'\n`);
  assert.throws(repo.projects, /Missing Gradle projectDir/);
});

test('every real non-app Gradle project is listed in committed notices with the full Capacitor MIT license', () => {
  const text = readFileSync(committedOutput, 'utf8');
  const settings = ['settings.gradle', 'capacitor.settings.gradle']
    .map((name) => readFileSync(join(root, 'apps/android/android', name), 'utf8'))
    .join('\n');
  const expected = [...settings.matchAll(/^include ['"](:[^'"]+)['"]/gm)]
    .map((match) => match[1])
    .filter((name) => name !== ':app');
  // The generated Cordova project is absent before cap sync on a clean checkout.
  // Exercise its filesystem checks with fixtures above; CI checks the real tree after building.
  for (const project of expected) assert.ok(text.includes(`Gradle project: ${project}\n`));
  const license = readFileSync(join(root, 'node_modules/@capacitor/android/LICENSE'), 'utf8')
    .replaceAll('\r\n', '\n')
    .trim();
  assert.ok(text.includes(license));
  assert.ok(text.includes('Copyright (c) 2017-present Drifty Co.'));
  assert.doesNotMatch(text, /\u2014/);
});

test('CI checks notices against the actual report after building the release', () => {
  const android = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').split('\n  android:')[1];
  assert.match(
    android,
    /run: npm run build:android:release\n {6}- name: Check Android notices against the release report\n {8}run: npm run notices:android -- --check/,
  );
});
