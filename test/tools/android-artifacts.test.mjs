import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MIN_WEBVIEW_VERSION } from '../../apps/android/capacitor.targets.mjs';
import {
  NOTICE_EN_US,
  NOTICE_PT_BR,
  createArtifacts,
  deriveVersionCode,
  getPreviousAndroidVersionCode,
  main,
  normalizeFingerprint,
  parseApkCertificate,
  parseHardwareValidated,
  sha256,
} from '../../tools/android-artifacts.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'apps/android/package.json'), 'utf8'));
const fingerprint = 'ab'.repeat(32);
const metadata = {
  version: pkg.version,
  capacitorVersion: pkg.dependencies['@capacitor/android'],
  minWebViewVersion: MIN_WEBVIEW_VERSION,
  hardwareValidated: false,
};
const input = {
  apk: Buffer.from('abc'),
  aab: Buffer.from(''),
  apkName: 'open-auri.apk',
  aabName: 'open-auri.aab',
  expectedAppCertSha256: fingerprint,
  actualAppCertSha256: fingerprint,
  commit: '1234567890abcdef1234567890abcdef12345678',
  repoUrl: 'https://github.com/marco-jardim/open-auri',
  version: pkg.version,
  versionCode: deriveVersionCode(pkg.version),
};

test('hashes use SHA-256 and sums have sorted sha256sum-compatible filenames', () => {
  assert.equal(
    sha256(input.apk),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    sha256(input.aab),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  const files = createArtifacts(input, metadata);
  assert.equal(
    files['SHA256SUMS.txt'],
    `${sha256(input.aab)}  open-auri.aab\n${sha256(input.apk)}  open-auri.apk\n`,
  );
});

test('manifest contains every release field and the immutable AGPL source URL', () => {
  const files = createArtifacts(input, metadata);
  assert.deepEqual(JSON.parse(files['release-manifest.json']), {
    version: pkg.version,
    versionCode: deriveVersionCode(pkg.version),
    commit: input.commit,
    sourceUrl: `${input.repoUrl}/tree/${input.commit}`,
    apkSha256: sha256(input.apk),
    aabSha256: sha256(input.aab),
    apkCertSha256: fingerprint,
    capacitorVersion: pkg.dependencies['@capacitor/android'],
    minWebViewVersion: MIN_WEBVIEW_VERSION,
    hardwareValidated: false,
  });
});

test('G.5 notices match the plan verbatim and start unvalidated release notes', () => {
  const plan = readFileSync(join(root, 'docs/plans/2026-10-18-android-capacitor-plano.md'), 'utf8');
  const section = plan
    .split('**G.5 Notas da release, README e ficha da Play**')[1]
    .split('**G.6')[0];
  assert.equal(NOTICE_PT_BR, section.match(/- pt-BR: "([^"]+)"/)[1]);
  assert.equal(NOTICE_EN_US, section.match(/- en-US: "([^"]+)"/)[1]);
  const notes = createArtifacts(input, metadata)['RELEASE_NOTES.md'];
  assert.ok(notes.startsWith(`${NOTICE_PT_BR}\n\n${NOTICE_EN_US}\n\n`));
  assert.ok(
    notes.includes(
      'Download the APK, AAB and SHA256SUMS.txt into the same directory, then run:\n\n' +
        'Baixe o APK, o AAB e o SHA256SUMS.txt no mesmo diretório e execute:',
    ),
  );
  assert.match(notes, /sha256sum -c SHA256SUMS\.txt/);
  assert.ok(
    notes.includes(
      'If you downloaded only one artifact, check its checksum with:\n\n' +
        'Se você baixou apenas um artefato, verifique sua soma de verificação com:',
    ),
  );
  assert.match(notes, /sha256sum -c --ignore-missing SHA256SUMS\.txt/);
  assert.match(notes, /apksigner verify --verbose --print-certs open-auri\.apk/);
  assert.ok(
    notes.includes('Expected app certificate SHA-256:\n\nSHA-256 esperado do certificado do app:'),
  );
  assert.ok(notes.includes(fingerprint.match(/../g).join(':').toUpperCase()));
  assert.ok(
    notes.includes(
      'The GitHub APK uses the app signing key; the AAB uses a different upload key for Play.\n\n' +
        'O APK do GitHub usa a chave de assinatura do app; o AAB usa uma chave de upload diferente para a Play.',
    ),
  );
  assert.ok(notes.includes(`AGPL-3.0-only): ${input.repoUrl}/tree/${input.commit}`));
  assert.ok(!notes.includes('\u2014'));
});

test('validated release omits both notices and updates the manifest', () => {
  const files = createArtifacts(input, { ...metadata, hardwareValidated: true });
  assert.ok(files['RELEASE_NOTES.md'].startsWith(`# Android ${pkg.version}\n`));
  assert.ok(!files['RELEASE_NOTES.md'].includes(NOTICE_PT_BR));
  assert.ok(!files['RELEASE_NOTES.md'].includes(NOTICE_EN_US));
  assert.equal(JSON.parse(files['release-manifest.json']).hardwareValidated, true);
});

test('version mismatch fails even when the versionCode is otherwise valid', () => {
  assert.throws(
    () => createArtifacts({ ...input, version: '2.0.0' }, metadata),
    /Version mismatch/,
  );
});

test('fingerprints accept exactly 32 bytes, with optional colons and case normalization', () => {
  assert.equal(normalizeFingerprint(fingerprint.match(/../g).join(':').toUpperCase()), fingerprint);
  for (const value of [
    '',
    'ab',
    'g'.repeat(64),
    'ab:'.repeat(32),
    `${fingerprint}:`,
    'a:b'.repeat(32),
    'ab '.repeat(32),
  ]) {
    assert.throws(() => normalizeFingerprint(value), /Malformed/);
    assert.throws(
      () => createArtifacts({ ...input, expectedAppCertSha256: value }, metadata),
      /Malformed/,
    );
  }
});

test('a valid but different actual APK certificate is rejected', () => {
  assert.throws(
    () => createArtifacts({ ...input, actualAppCertSha256: 'cd'.repeat(32) }, metadata),
    /APK certificate does not match/,
  );
});

test('apksigner output requires one signer and a well-formed certificate digest', () => {
  const line = `Signer #1 certificate SHA-256 digest: ${fingerprint}\n`;
  assert.equal(
    parseApkCertificate(`Verifies\n${line}Signer #1 certificate SHA-1 digest: abc\n`),
    fingerprint,
  );
  assert.throws(() => parseApkCertificate('DOES NOT VERIFY'), /exactly one/);
  assert.throws(() => parseApkCertificate(`${line}${line.replace('#1', '#2')}`), /exactly one/);
  assert.throws(
    () => parseApkCertificate('Signer #1 certificate SHA-256 digest: bad\n'),
    /Malformed/,
  );
});

test('hardware flag is read from the real exported boolean, and fails closed if missing or ambiguous', () => {
  for (const flag of [true, false]) {
    assert.equal(
      parseHardwareValidated(`export const ANDROID_WRITE_VALIDATED: boolean = ${flag};`),
      flag,
    );
  }
  const status = readFileSync(join(root, 'web/src/lib/cable/android-status.ts'), 'utf8');
  assert.equal(typeof parseHardwareValidated(status), 'boolean');
  assert.throws(
    () => parseHardwareValidated('// ANDROID_WRITE_VALIDATED = false;'),
    /Cannot parse/,
  );
  assert.throws(
    () => parseHardwareValidated('export const ANDROID_WRITE_VALIDATED = maybe;'),
    /Cannot parse/,
  );
  assert.throws(
    () =>
      parseHardwareValidated(
        'export const ANDROID_WRITE_VALIDATED = false;\nexport const ANDROID_WRITE_VALIDATED = true;',
      ),
    /Cannot parse/,
  );
});

test('deterministic versionCode is monotonic, bounded and collision-free within its supported range', () => {
  assert.equal(deriveVersionCode('1.0.0'), 10000);
  assert.equal(deriveVersionCode('1.2.3', 10202), 10203);
  for (const version of [
    '0.0.0',
    '1.100.0',
    '1.0.100',
    '01.0.0',
    '1.0',
    '1.0.0-rc.1',
    '210001.0.0',
  ]) {
    assert.throws(() => deriveVersionCode(version));
  }
  for (const previous of [10000, 10001, -1, 1.5, NaN, 2100000001]) {
    assert.throws(() => deriveVersionCode('1.0.0', previous), /greater than/);
  }
  assert.throws(() => createArtifacts({ ...input, versionCode: 1 }, metadata), /versionCode/);
});

const androidRelease = (id, extra = {}) => ({
  tag_name: `android-v1.0.${id}`,
  draft: false,
  assets: [{ id, name: 'release-manifest.json' }],
  ...extra,
});

test('previous versionCode is the maximum across all published Android releases, not the latest release', () => {
  const reads = [];
  const releases = [
    { tag_name: 'web-v9.0.0', draft: false, assets: [] },
    androidRelease(1),
    androidRelease(2, { prerelease: true }),
    androidRelease(3),
    androidRelease(4, { draft: true, assets: [] }),
  ];
  const previous = getPreviousAndroidVersionCode(releases, (id) => {
    reads.push(id);
    return { versionCode: { 1: 10001, 2: 20000, 3: 10003 }[id] };
  });
  assert.equal(previous, 20000);
  assert.deepEqual(reads, [1, 2, 3]);
  assert.throws(() => deriveVersionCode('1.0.4', previous), /greater than/);
});

test('previous versionCode is zero only when no published Android releases exist', () => {
  const unexpectedRead = () => {
    throw new Error('Should not download a manifest');
  };
  assert.equal(getPreviousAndroidVersionCode([], unexpectedRead), 0);
  assert.equal(
    getPreviousAndroidVersionCode(
      [
        { tag_name: 'v9.0.0', draft: false, assets: [] },
        androidRelease(1, { draft: true, assets: [] }),
      ],
      unexpectedRead,
    ),
    0,
  );
});

test('any published Android release without exactly one manifest fails with its tag', () => {
  for (const assets of [
    [],
    [{ id: 2, name: 'app.apk' }],
    [
      { id: 2, name: 'release-manifest.json' },
      { id: 3, name: 'release-manifest.json' },
    ],
  ]) {
    assert.throws(
      () =>
        getPreviousAndroidVersionCode([androidRelease(1), androidRelease(2, { assets })], () => ({
          versionCode: 10001,
        })),
      /android-v1\.0\.2.*exactly one release-manifest\.json/,
    );
  }
});

test('invalid published Android manifests and download failures cannot reset the baseline', () => {
  for (const manifest of [
    null,
    {},
    { versionCode: '10000' },
    { versionCode: 0 },
    { versionCode: -1 },
    { versionCode: 1.5 },
    { versionCode: 2100000001 },
  ]) {
    assert.throws(
      () => getPreviousAndroidVersionCode([androidRelease(1)], () => manifest),
      /android-v1\.0\.1.*invalid manifest versionCode/,
    );
  }
  assert.throws(
    () =>
      getPreviousAndroidVersionCode([androidRelease(1)], () => {
        throw new Error('Manifest download failed');
      }),
    /Manifest download failed/,
  );
  assert.throws(
    () => getPreviousAndroidVersionCode([androidRelease(1)], () => JSON.parse('bad')),
    SyntaxError,
  );
  assert.throws(
    () => getPreviousAndroidVersionCode([androidRelease(0)], () => ({ versionCode: 10000 })),
    /invalid manifest asset ID/,
  );
});

test('same inputs yield byte-identical outputs, independently of paths, timezone or clock', () => {
  const first = createArtifacts(input, metadata);
  assert.deepEqual(
    createArtifacts(
      { ...input, apk: Buffer.from(input.apk), aab: Buffer.from(input.aab) },
      { ...metadata },
    ),
    first,
  );
  for (const content of Object.values(first)) assert.ok(content.endsWith('\n'));
  assert.deepEqual(
    createArtifacts({ ...input, repoUrl: `${input.repoUrl}.git/` }, metadata),
    first,
  );
});

test('unsafe artifact filenames, source URLs and incomplete commits are rejected', () => {
  for (const apkName of ['../app.apk', 'app\n.apk', 'app apk', 'app\\file.apk', input.aabName]) {
    assert.throws(() => createArtifacts({ ...input, apkName }, metadata), /filename/);
  }
  for (const repoUrl of [
    'http://github.com/a/b',
    'https://user:pass@github.com/a/b',
    `${input.repoUrl}?x=1`,
  ]) {
    assert.throws(() => createArtifacts({ ...input, repoUrl }, metadata), /Repository URL/);
  }
  assert.throws(
    () => createArtifacts({ ...input, commit: '1234567' }, metadata),
    /full Git commit SHA/,
  );
});

test('CLI writes the three outputs using repository metadata and a verified APK certificate', (t) => {
  const dir = mkdtempSync(join(root, 'node_modules/.android-artifacts-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const apk = join(dir, input.apkName);
  const aab = join(dir, input.aabName);
  writeFileSync(apk, input.apk);
  writeFileSync(aab, input.aab);
  const argv = [
    '--apk',
    apk,
    '--aab',
    aab,
    '--expected-app-cert-sha256',
    fingerprint,
    '--commit',
    input.commit,
    '--repo-url',
    input.repoUrl,
    '--version',
    pkg.version,
    '--version-code',
    String(input.versionCode),
    '--out-dir',
    join(dir, 'out'),
  ];
  let inspected = false;
  assert.equal(
    main(argv, (path) => {
      assert.equal(path, apk);
      inspected = true;
      return fingerprint;
    }),
    0,
  );
  assert.ok(inspected);
  const hardwareValidated = parseHardwareValidated(
    readFileSync(join(root, 'web/src/lib/cable/android-status.ts'), 'utf8'),
  );
  for (const [name, content] of Object.entries(
    createArtifacts(input, { ...metadata, hardwareValidated }),
  )) {
    assert.equal(readFileSync(join(dir, 'out', name), 'utf8'), content);
  }
  assert.equal(
    main(argv, () => 'cd'.repeat(32)),
    1,
  );
  assert.equal(
    main(argv, () => {
      throw new Error('apksigner verification failed');
    }),
    1,
  );
  assert.equal(main([...argv, '--version', pkg.version]), 1);
  assert.equal(main([]), 1);
});

test('workflow isolates secrets, restricts publishing to tags and shares identical real/dry signing', () => {
  const workflow = readFileSync(join(root, '.github/workflows/android-release.yml'), 'utf8');
  const build = workflow.split('\n  build:')[1].split('\n  sign-and-publish:')[0];
  const publish = workflow.split('\n  sign-and-publish:')[1].split('\n  dry-run:')[0];
  const dryRun = workflow.split('\n  dry-run:')[1];
  assert.match(workflow, /permissions: \{\}/);
  assert.match(publish, /environment: android-release/);
  assert.match(
    publish,
    /if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/android-v'\)/,
  );
  assert.match(
    dryRun,
    /if: github.event_name == 'pull_request' \|\| \(github.event_name == 'workflow_dispatch' && inputs.dry_run\)/,
  );
  assert.doesNotMatch(dryRun, /environment:/);
  for (const job of [build, dryRun]) {
    assert.ok(!job.includes('secrets.'));
    assert.ok(!job.includes('environment:'));
    assert.ok(!job.includes('contents: write'));
    assert.ok(!job.includes('gh release create'));
  }
  assert.match(build, /workflow_dispatch' && !inputs.dry_run/);
  assert.match(build, /ORG_GRADLE_PROJECT_versionCode/);
  assert.match(build, /'--paginate', '--slurp', `\$\{repo\}\/releases\?per_page=100`/);
  assert.match(build, /getPreviousAndroidVersionCode\(pages\.flat\(\)/);
  assert.ok(!build.includes('/releases/latest'));
  assert.ok(!workflow.includes('SOURCE_DATE_EPOCH'));
  assert.match(build, /run: npm run build:android:release\n/);
  assert.ok(!build.includes('gradle/actions/setup-gradle'));
  for (const role of ['APP', 'UPLOAD']) {
    for (const suffix of ['KEYSTORE_B64', 'KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) {
      assert.ok(publish.includes(`secrets.ANDROID_${role}_${suffix}`));
    }
  }
  const decode = publish
    .split('- name: Decode protected keystores')[1]
    .split('- name: Sign and verify both artifacts')[0];
  assert.match(decode, /for ROLE in APP UPLOAD; do/);
  assert.match(decode, /for SUFFIX in KEYSTORE_B64 KEYSTORE_PASSWORD KEY_ALIAS KEY_PASSWORD; do/);
  assert.ok(decode.includes('[[ -z "${!SECRET:-}" ]]'));
  assert.ok(decode.includes('Missing required keystore secret: $SECRET'));
  assert.ok(decode.includes('Keystore secret $SECRET is not valid base64'));
  assert.ok(decode.includes('[[ ! -s "$KEYSTORE" ]]'));
  assert.ok(decode.includes('Decoded keystore is empty: $SECRET'));
  assert.match(publish, /gh release create "\$GITHUB_REF_NAME"/);
  assert.match(publish, /--notes-file "\$OUT\/RELEASE_NOTES\.md" --verify-tag/);
  const signingScript = (job) =>
    job
      .split('- name: Sign and verify both artifacts')[1]
      .split('        run: |\n')[1]
      .split('\n      - name:')[0]
      .trim();
  assert.equal(signingScript(publish), signingScript(dryRun));
  assert.match(
    signingScript(publish),
    /--v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true/,
  );
  assert.match(signingScript(publish), /--ks-pass env:ANDROID_APP_KEYSTORE_PASSWORD/);
  assert.match(signingScript(publish), /-storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD/);
  assert.match(signingScript(publish), /"\$AAB_CERT" == "\$EXPECTED"/);
  for (const job of [publish, dryRun]) {
    assert.match(job, /- name: Delete signing material\n {8}if: always\(\)/);
    assert.ok(!job.includes('set -x'));
  }
  assert.ok(!workflow.includes('\u2014'));
});
