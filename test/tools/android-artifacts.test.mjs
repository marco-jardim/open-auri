import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

import { MIN_WEBVIEW_VERSION, buildConfig } from '../../apps/android/capacitor.targets.mjs';
import {
  ANDROID_RELEASE_TAG,
  NOTICE_EN_US,
  NOTICE_PT_BR,
  createArtifacts,
  deriveVersionCode,
  getPreviousAndroidVersionCode,
  isTagPush,
  main,
  normalizeFingerprint,
  parseApkBadging,
  parseApkCertificate,
  parseHardwareValidated,
  readAabManifest,
  readZipEntry,
  sha256,
  verifyArtifactIdentity,
  verifyUploadCertificate,
  versionCodeForRun,
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
const identity = {
  applicationId: buildConfig({ OA_ANDROID_TARGET: 'prod' }, pkg.version).appId,
  versionCode: input.versionCode,
  versionName: pkg.version,
};

// Fixture writers for aapt2's protobuf XML (frameworks/base/tools/aapt2/Resources.proto) and ZIP.
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const AAB_MANIFEST = 'base/manifest/AndroidManifest.xml';
function varint(value) {
  let rest = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    const low = Number(rest & 0x7fn);
    rest >>= 7n;
    bytes.push(rest ? low | 0x80 : low);
  } while (rest);
  return Buffer.from(bytes);
}
const pb = (...fields) => Buffer.concat(fields);
/** Numbers are varint fields; strings and buffers are length-delimited fields. */
function field(number, value) {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return pb(varint(number * 8), varint(value));
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return pb(varint(number * 8 + 2), varint(bytes.length), bytes);
}
/** XmlAttribute: 1 namespace_uri, 2 name, 3 value, 4 source, 5 resource_id, 6 compiled_item. */
const xmlAttribute = (namespaceUri, name, value, compiled, resourceId) =>
  field(
    4,
    pb(
      ...(namespaceUri ? [field(1, namespaceUri)] : []),
      field(2, name),
      field(3, value),
      field(4, pb(field(1, 2))),
      ...(resourceId ? [field(5, resourceId)] : []),
      ...(compiled ? [field(6, compiled)] : []),
    ),
  );
/** Item.prim (7) -> Primitive.int_decimal_value (6); Item.str (2) -> String.value (1). */
const compiledInt = (value) => pb(field(7, pb(field(6, value))));
const compiledString = (value) => pb(field(2, pb(field(1, value))));
/** compiledCode/compiledName: null omits the compiled item (undefined would take the default). */
function protoManifest({
  applicationId = identity.applicationId,
  versionCode = String(identity.versionCode),
  versionName = identity.versionName,
  compiledCode = Number(versionCode),
  compiledName = versionName,
  rootName = 'manifest',
  omit = [],
  extra = [],
} = {}) {
  const attributes = {
    versionCode: xmlAttribute(
      ANDROID_NS,
      'versionCode',
      versionCode,
      compiledCode === null ? undefined : compiledInt(compiledCode),
      0x0101021b,
    ),
    versionName: xmlAttribute(
      ANDROID_NS,
      'versionName',
      versionName,
      compiledName === null ? undefined : compiledString(compiledName),
      0x0101021c,
    ),
    package: xmlAttribute('', 'package', applicationId),
  };
  return pb(
    // XmlNode.element (1) -> XmlElement: 1 namespace_declaration, 3 name, 4 attribute, 5 child.
    field(
      1,
      pb(
        field(1, pb(field(1, 'android'), field(2, ANDROID_NS))),
        field(3, rootName),
        ...Object.entries(attributes)
          .filter(([name]) => !omit.includes(name))
          .map(([, attribute]) => attribute),
        ...extra,
        field(5, pb(field(1, pb(field(3, 'application'))), field(3, pb(field(1, 4))))),
      ),
    ),
    field(3, pb(field(1, 1))),
  );
}
/** @param {[string, Buffer, number?][]} entries method 0 (stored) or 8 (deflate, default) */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content, method = 8] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = method === 8 ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(content), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const fakeAab = (manifest = protoManifest()) =>
  zip([
    ['BundleConfig.pb', Buffer.from('config'), 0],
    [AAB_MANIFEST, manifest],
    ['base/dex/classes.dex', Buffer.from('dex')],
  ]);
const badging = ({
  name = identity.applicationId,
  versionCode = String(identity.versionCode),
  versionName = identity.versionName,
} = {}) =>
  `package: name='${name}' versionCode='${versionCode}' versionName='${versionName}' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'\n` +
  "minSdkVersion:'26'\ntargetSdkVersion:'36'\napplication-label:'open-auri'\n";

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

test('AAB certificate must match the configured upload key and differ from the app key', () => {
  const upload = 'cd'.repeat(32);
  verifyUploadCertificate(upload, upload.match(/../g).join(':').toUpperCase(), fingerprint);
  assert.throws(
    () => verifyUploadCertificate(upload, 'ef'.repeat(32), fingerprint),
    /expected upload certificate/,
  );
  assert.throws(() => verifyUploadCertificate(fingerprint, fingerprint, fingerprint), /distinct/);
  for (const invalid of ['', 'bad', `${upload}\n${upload}`]) {
    assert.throws(() => verifyUploadCertificate(invalid, upload, fingerprint), /Malformed/);
    assert.throws(() => verifyUploadCertificate(upload, invalid, fingerprint), /Malformed/);
  }
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

test('n2: only a tag push is strict; PR, branch and tag-ref dispatch dry runs warn instead', () => {
  assert.equal(isTagPush('push', 'tag'), true);
  for (const [eventName, refType] of [
    ['workflow_dispatch', 'tag'],
    ['workflow_dispatch', 'branch'],
    ['pull_request', 'branch'],
    ['push', 'branch'],
    [undefined, 'tag'],
    [undefined, undefined],
  ]) {
    assert.equal(isTagPush(eventName, refType), false, `${eventName}/${refType}`);
  }
  for (const previous of [10000, 20000]) {
    // A dry run of an already published tag (dispatch from refs/tags/android-v1.0.0) succeeds.
    for (const [eventName, refType] of [
      ['workflow_dispatch', 'tag'],
      ['workflow_dispatch', 'branch'],
      ['pull_request', 'branch'],
    ]) {
      const warnings = [];
      assert.equal(
        versionCodeForRun('1.0.0', previous, isTagPush(eventName, refType), (warning) =>
          warnings.push(warning),
        ),
        10000,
      );
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^::warning::.*10000.*maximum/);
    }
    assert.throws(
      () => versionCodeForRun('1.0.0', previous, isTagPush('push', 'tag')),
      /greater than/,
    );
  }
  for (const publishing of [true, false]) {
    assert.equal(
      versionCodeForRun('1.0.1', 10000, publishing, () => assert.fail('Unexpected warning')),
      10001,
    );
    for (const previous of [-1, 1.5, NaN, 2100000001]) {
      assert.throws(() => versionCodeForRun('1.0.0', previous, publishing), /baseline is invalid/);
    }
    assert.throws(() => versionCodeForRun('invalid', 0, publishing), /Version must/);
  }
  // The old ref-type string must not silently pick a mode.
  for (const invalid of ['tag', 'branch', undefined, 1]) {
    assert.throws(() => versionCodeForRun('1.0.1', 0, invalid), /publishing must be a boolean/);
  }
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

test('existing Android tags keep the floor even if their releases were deleted', () => {
  const read = () => ({ versionCode: 10001 });
  const tags = ['web-v9.0.0', 'android-v1.0.2', 'android-v2.0.0', 'android-v1.1.0'];
  assert.equal(getPreviousAndroidVersionCode([androidRelease(1)], read, tags), 20000);
  assert.equal(
    getPreviousAndroidVersionCode([], () => assert.fail('No releases to read'), tags),
    20000,
  );
  assert.equal(
    getPreviousAndroidVersionCode([androidRelease(1)], () => ({ versionCode: 30000 }), tags),
    30000,
  );
  assert.throws(
    () => deriveVersionCode('1.9.9', getPreviousAndroidVersionCode([], read, tags)),
    /greater than/,
  );
  // Tags with the release shape that cannot be encoded still fail closed.
  for (const tag of ['android-v1.100.0', 'android-v01.0.0']) {
    assert.throws(() => getPreviousAndroidVersionCode([], read, [tag], () => {}));
  }
});

test('n3: malformed android-v* tags are skipped with a warning instead of breaking every run', () => {
  const malformed = [
    'android-v1.0.1-rc1',
    'android-vbad',
    'android-v1.0',
    'android-v1.0.0.1',
    'android-v1.0.0-beta',
  ];
  const warnings = [];
  const unexpectedRead = () => assert.fail('No releases to read');
  assert.equal(
    getPreviousAndroidVersionCode(
      [],
      unexpectedRead,
      [...malformed, 'web-v9.0.0', 'android-v1.0.1', 'android-v1.0.0'],
      (warning) => warnings.push(warning),
    ),
    10001,
  );
  assert.equal(warnings.length, malformed.length);
  for (const [index, tag] of malformed.entries()) {
    assert.match(warnings[index], /^::warning::Ignoring malformed Android tag /);
    assert.ok(warnings[index].includes(JSON.stringify(tag)));
  }
  assert.equal(
    getPreviousAndroidVersionCode([], unexpectedRead, malformed, () => {}),
    0,
  );
  for (const tag of malformed) assert.equal(ANDROID_RELEASE_TAG.test(tag), false, tag);
  assert.equal(ANDROID_RELEASE_TAG.test('android-v1.0.2'), true);
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

test('n5: APK identity comes from exactly one aapt2 badging package line', () => {
  assert.deepEqual(parseApkBadging(badging()), identity);
  assert.deepEqual(parseApkBadging(badging().replaceAll('\n', '\r\n')), identity);
  assert.throws(() => parseApkBadging(''), /exactly one package line/);
  assert.throws(() => parseApkBadging(`${badging()}${badging()}`), /exactly one package line/);
  assert.throws(() => parseApkBadging(` ${badging()}`), /exactly one package line/);
  for (const [override, message] of [
    [{ versionCode: '' }, /malformed versionCode/],
    [{ versionCode: '0' }, /malformed versionCode/],
    [{ versionCode: '0x2711' }, /malformed versionCode/],
    [{ versionCode: '2100000001' }, /malformed versionCode/],
    [{ versionName: '' }, /no versionName/],
    [{ name: '' }, /malformed applicationId/],
    [{ name: 'openauri' }, /malformed applicationId/],
  ]) {
    assert.throws(() => parseApkBadging(badging(override)), message);
  }
});

test('APK and AAB identities reject android:versionCodeMajor, including zero and compiled-only values', () => {
  for (const major of [0, 1]) {
    assert.throws(
      () =>
        parseApkBadging(
          badging().replace(
            ' platformBuildVersionName=',
            ` versionCodeMajor='${major}' platformBuildVersionName=`,
          ),
        ),
      /APK manifest must not declare android:versionCodeMajor/,
    );
    for (const value of [String(major), '']) {
      assert.throws(
        () =>
          readAabManifest(
            fakeAab(
              protoManifest({
                extra: [xmlAttribute(ANDROID_NS, 'versionCodeMajor', value, compiledInt(major))],
              }),
            ),
          ),
        /AAB manifest must not declare android:versionCodeMajor/,
      );
    }
  }
});

test('AAB manifest ZIP entries are capped at 1 MiB even when the declared size lies', () => {
  const limit = 1024 * 1024;
  for (const method of [0, 8]) {
    const content = Buffer.alloc(limit);
    assert.deepEqual(readZipEntry(zip([[AAB_MANIFEST, content, method]]), AAB_MANIFEST), content);
    assert.throws(
      () => readZipEntry(zip([[AAB_MANIFEST, Buffer.alloc(limit + 1), method]]), AAB_MANIFEST),
      /exceeds 1 MiB/,
    );
  }
  const forged = zip([[AAB_MANIFEST, Buffer.alloc(limit + 1)]]);
  const directory = forged.readUInt32LE(forged.length - 22 + 16);
  forged.writeUInt32LE(1, 22);
  forged.writeUInt32LE(1, directory + 24);
  // This fails during inflation, not only the size/CRC check after allocating the output.
  assert.throws(() => readZipEntry(forged, AAB_MANIFEST), /Corrupt ZIP archive/);
});

test('n5: AAB identity is read offline from the protobuf base manifest, stored or deflated', () => {
  assert.deepEqual(readAabManifest(fakeAab()), identity);
  assert.deepEqual(readAabManifest(zip([[AAB_MANIFEST, protoManifest(), 0]])), identity);
  assert.deepEqual(readZipEntry(fakeAab(), AAB_MANIFEST), protoManifest());
  assert.deepEqual(readZipEntry(fakeAab(), 'BundleConfig.pb'), Buffer.from('config'));
  // Raw value only, compiled value only, and unrelated compiled attributes all read the same.
  assert.deepEqual(
    readAabManifest(fakeAab(protoManifest({ compiledCode: null, compiledName: null }))),
    identity,
  );
  assert.deepEqual(
    readAabManifest(
      fakeAab(protoManifest({ versionCode: '', compiledCode: identity.versionCode })),
    ),
    identity,
  );
  assert.deepEqual(
    readAabManifest(
      fakeAab(
        protoManifest({
          extra: [
            xmlAttribute(ANDROID_NS, 'compileSdkVersion', '36', compiledInt(36), 0x01010572),
            xmlAttribute('', 'platformBuildVersionCode', '36', compiledInt(36)),
          ],
        }),
      ),
    ),
    identity,
  );
});

test('n5: ambiguous, inconsistent or unreadable AAB manifests fail closed', () => {
  for (const [manifest, message] of [
    [protoManifest({ compiledCode: 1 }), /versionCode differs from its compiled value/],
    [protoManifest({ compiledName: '9.9.9' }), /versionName differs from its compiled value/],
    [protoManifest({ versionCode: '1' }), null],
    [protoManifest({ versionCode: 'abc', compiledCode: null }), /malformed versionCode/],
    [protoManifest({ versionCode: '0' }), /malformed versionCode/],
    [protoManifest({ versionName: '', compiledName: null }), /no versionName/],
    [protoManifest({ applicationId: '' }), /malformed applicationId/],
    [protoManifest({ omit: ['package'] }), /exactly one package/],
    [protoManifest({ omit: ['versionCode'] }), /exactly one android:versionCode/],
    [protoManifest({ omit: ['versionName'] }), /exactly one android:versionName/],
    [
      protoManifest({ extra: [xmlAttribute(ANDROID_NS, 'versionCode', '1', compiledInt(1))] }),
      /exactly one android:versionCode/,
    ],
    // An attribute without the Android namespace is not android:versionCode.
    [
      protoManifest({
        omit: ['versionCode'],
        extra: [xmlAttribute('', 'versionCode', String(identity.versionCode))],
      }),
      /exactly one android:versionCode/,
    ],
    [protoManifest({ rootName: 'application' }), /root must be <manifest>/],
    [pb(field(2, 'text')), /single XML element/],
    [pb(protoManifest(), protoManifest()), /single XML element/],
    [pb(varint(1 * 8 + 3)), /wire type 3/],
    [protoManifest().subarray(0, protoManifest().length - 3), /Truncated protobuf/],
  ]) {
    if (message) assert.throws(() => readAabManifest(fakeAab(manifest)), message);
    else assert.equal(readAabManifest(fakeAab(manifest)).versionCode, 1);
  }
  const stored = zip([[AAB_MANIFEST, protoManifest(), 0]]);
  const corrupted = Buffer.from(stored);
  corrupted[30 + AAB_MANIFEST.length] ^= 1;
  assert.throws(() => readAabManifest(corrupted), /size\/CRC-32 check/);
  assert.throws(
    () => readAabManifest(zip([[AAB_MANIFEST, protoManifest(), 12]])),
    /Unsupported ZIP compression method 12/,
  );
  assert.throws(
    () =>
      readAabManifest(
        zip([
          [AAB_MANIFEST, protoManifest()],
          [AAB_MANIFEST, protoManifest({ versionCode: '1' })],
        ]),
      ),
    /exactly one base\/manifest\/AndroidManifest\.xml/,
  );
  assert.throws(
    () => readAabManifest(zip([['AndroidManifest.xml', protoManifest()]])),
    /exactly one base\/manifest\/AndroidManifest\.xml/,
  );
  for (const bytes of [Buffer.alloc(0), Buffer.from('not a zip archive'), input.apk]) {
    assert.throws(() => readAabManifest(bytes), /Not a ZIP archive/);
  }
  assert.throws(() => readAabManifest(stored.subarray(0, stored.length - 30)), /Not a ZIP/);
});

test('n5: every identity field of both artifacts must match the release manifest', () => {
  verifyArtifactIdentity({ apk: identity, aab: { ...identity } }, identity);
  for (const label of ['APK', 'AAB']) {
    for (const [key, value] of [
      ['applicationId', 'com.openauri.app.debug'],
      ['versionCode', 1],
      ['versionCode', String(identity.versionCode)],
      ['versionName', `${identity.versionName}-debug`],
    ]) {
      const wrong = { ...identity, [key]: value };
      assert.throws(
        () =>
          verifyArtifactIdentity(
            { apk: label === 'APK' ? wrong : identity, aab: label === 'AAB' ? wrong : identity },
            identity,
          ),
        new RegExp(`^Error: ${label} ${key} .* does not match the release manifest`),
      );
    }
  }
});

test('CLI writes the three outputs using repository metadata and a verified APK certificate', (t) => {
  const dir = mkdtempSync(join(root, 'node_modules/.android-artifacts-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const apk = join(dir, input.apkName);
  const aab = join(dir, input.aabName);
  const aabBytes = fakeAab();
  writeFileSync(apk, input.apk);
  writeFileSync(aab, aabBytes);
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
  let badged = false;
  const apkIdentity = (path) => {
    assert.equal(path, apk);
    badged = true;
    return identity;
  };
  assert.equal(
    main(
      argv,
      (path) => {
        assert.equal(path, apk);
        inspected = true;
        return fingerprint;
      },
      apkIdentity,
    ),
    0,
  );
  assert.ok(inspected);
  assert.ok(badged);
  const hardwareValidated = parseHardwareValidated(
    readFileSync(join(root, 'web/src/lib/cable/android-status.ts'), 'utf8'),
  );
  for (const [name, content] of Object.entries(
    createArtifacts({ ...input, aab: aabBytes }, { ...metadata, hardwareValidated }),
  )) {
    assert.equal(readFileSync(join(dir, 'out', name), 'utf8'), content);
  }
  assert.equal(
    main(argv, () => 'cd'.repeat(32), apkIdentity),
    1,
  );
  assert.equal(
    main(
      argv,
      () => {
        throw new Error('apksigner verification failed');
      },
      apkIdentity,
    ),
    1,
  );
  assert.equal(main([...argv, '--version', pkg.version]), 1);
  assert.equal(main([]), 1);
});

test('n5: CLI fails closed and writes nothing when the APK or AAB identity differs', (t) => {
  const dir = mkdtempSync(join(root, 'node_modules/.android-artifacts-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const apk = join(dir, input.apkName);
  const aab = join(dir, input.aabName);
  writeFileSync(apk, input.apk);
  const out = join(dir, 'out');
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
    out,
  ];
  const run = (apkIdentity, aabBytes) => {
    writeFileSync(aab, aabBytes);
    return main(
      argv,
      () => fingerprint,
      () => apkIdentity,
    );
  };
  // Local Gradle builds default to versionCode 1; such an artifact must never be published.
  for (const apkIdentity of [
    { ...identity, versionCode: 1 },
    { ...identity, versionName: '0.0.1' },
    { ...identity, applicationId: 'com.openauri.app.debug' },
  ]) {
    assert.equal(run(apkIdentity, fakeAab()), 1);
  }
  for (const manifest of [
    protoManifest({ versionCode: '1' }),
    protoManifest({ versionName: '0.0.1' }),
    protoManifest({ applicationId: 'com.openauri.app.debug' }),
  ]) {
    assert.equal(run(identity, fakeAab(manifest)), 1);
  }
  assert.equal(run(identity, Buffer.from('unsigned bytes, not an AAB')), 1);
  assert.equal(
    main(
      argv,
      () => fingerprint,
      () => {
        throw new Error('aapt2 dump badging failed');
      },
    ),
    1,
  );
  assert.equal(existsSync(out), false);
  assert.equal(run(identity, fakeAab()), 0);
  assert.equal(existsSync(join(out, 'release-manifest.json')), true);
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
  assert.match(build, /run: npm run build:android:release -- --no-build-cache\n/);
  assert.doesNotMatch(build, /actions\/cache@|setup-gradle|~\/\.gradle|restore-keys:/);
  assert.match(build, /fetch-depth: 0/);
  assert.ok(build.includes("['tag', '--list', 'android-v*']"));
  // n2: strictness, tag exclusion and tag/version equality are keyed on the tag push event.
  assert.equal(
    build.split(
      'const publishing = isTagPush(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF_TYPE);',
    ).length - 1,
    2,
  );
  assert.ok(build.includes('!(publishing && tag === process.env.GITHUB_REF_NAME)'));
  assert.ok(
    build.includes('if (publishing && process.env.GITHUB_REF_NAME !== `android-v${version}`)'),
  );
  assert.ok(!build.includes("GITHUB_REF_TYPE === 'tag'"));
  assert.ok(build.includes("], { encoding: 'utf8' })), tags)"));
  assert.ok(build.includes('versionCodeForRun(version, previous.versionCode, publishing)'));
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
  // Releases 1.0.0 and 1.0.1 had to be renamed by hand.
  assert.match(publish, /--title "open-auri Android \$VERSION"/);
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
  assert.match(
    signingScript(publish),
    /verifyUploadCertificate\(process\.env\.AAB_CERT, process\.env\.ANDROID_UPLOAD_CERT_SHA256/,
  );
  // n5: the CLI reads the APK identity with the pinned build-tools aapt2 in both jobs.
  assert.ok(
    signingScript(publish).includes('export AAPT2="$ANDROID_HOME/build-tools/36.1.0/aapt2"'),
  );
  for (const job of [publish, dryRun]) assert.match(job, /run: sdkmanager "build-tools;36\.1\.0"/);
  assert.match(
    publish,
    /ANDROID_UPLOAD_CERT_SHA256: \$\{\{ vars\.ANDROID_UPLOAD_CERT_SHA256 \|\| secrets\.ANDROID_UPLOAD_CERT_SHA256 \}\}/,
  );
  assert.ok(dryRun.includes('echo "ANDROID_${ROLE}_CERT_SHA256=$FINGERPRINT" >> "$GITHUB_ENV"'));
  for (const job of [publish, dryRun]) {
    assert.match(job, /- name: Delete signing material\n {8}if: always\(\)/);
    assert.ok(!job.includes('set -x'));
  }
  assert.ok(!workflow.includes('\u2014'));
});

test('all release jobs pin checkout and setup-node with version comments', () => {
  const workflow = readFileSync(join(root, '.github/workflows/android-release.yml'), 'utf8');
  for (const [action, sha] of [
    ['checkout', '11d5960a326750d5838078e36cf38b85af677262'],
    ['setup-node', '49933ea5288caeca8642d1e84afbd3f7d6820020'],
  ]) {
    const uses = workflow.split('\n').filter((line) => line.includes(`uses: actions/${action}@`));
    assert.equal(uses.length, 3);
    for (const line of uses) assert.ok(line.endsWith(`actions/${action}@${sha} # v4.4.0`));
  }
});

test('release PR paths cover every release build/config input and tooling regression tests', () => {
  const workflow = readFileSync(join(root, '.github/workflows/android-release.yml'), 'utf8');
  const paths = workflow.split('  pull_request:\n')[1].split('  workflow_dispatch:')[0];
  for (const path of [
    'tools/android-artifacts.mjs',
    'tools/verify-capacitor-config.mjs',
    'tools/run-gradle.mjs',
    'apps/android/package.json',
    'apps/android/capacitor.targets.mjs',
    'apps/android/capacitor.config.ts',
    'package.json',
    'package-lock.json',
    'apps/android/android/**',
    // n4: bundled web assets and the hardwareValidated source of release-manifest.json.
    'apps/android/www/**',
    'web/src/lib/cable/android-status.ts',
    'tools/android-notices.mjs',
    'test/android-release/dryrun.mjs',
  ]) {
    assert.ok(paths.includes(`      - ${path}\n`), `Missing release PR path: ${path}`);
  }
});
