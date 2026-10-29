#!/usr/bin/env node
// Release metadata has no timestamps or machine-specific paths: identical inputs yield identical files.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';

import { MIN_WEBVIEW_VERSION, buildConfig } from '../apps/android/capacitor.targets.mjs';

export const NOTICE_PT_BR =
  'Aviso: testamos a gravação num Kuba Auri com Galaxy A70 (Android 11), não em outros fabricantes. Prévia, gravação e restauração do Padrão Auri confirmadas pelo som; bytes na ponte nativa iguais aos do site no computador. Validação completa pendente. Som estranho? Grave Neutro; se não resolver, pelo site no computador (Chrome ou Edge). Relate: https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml';
export const NOTICE_EN_US =
  'Notice: writing tested on a Kuba Auri with Galaxy A70 (Android 11), not other manufacturers. Preview, writing and Padrão Auri restoration confirmed acoustically; native bridge bytes match the desktop site. Full validation pending. Sound off? Write Neutral; if unresolved, use the desktop site (Chrome or Edge). Report: https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml';

/** @param {string} value */
export function normalizeFingerprint(value) {
  const fingerprint = value.trim();
  if (!/^(?:[\da-f]{64}|[\da-f]{2}(?::[\da-f]{2}){31})$/i.test(fingerprint)) {
    throw new Error('Malformed SHA-256 certificate fingerprint');
  }
  return fingerprint.replaceAll(':', '').toLowerCase();
}

/** @param {string} output output of a successful apksigner verify --print-certs */
export function parseApkCertificate(output) {
  const matches = [...output.matchAll(/^Signer #\d+ certificate SHA-256 digest: (\S+)\s*$/gm)];
  if (matches.length !== 1) throw new Error('APK must have exactly one signing certificate');
  return normalizeFingerprint(matches[0][1]);
}

/** @param {string} actual @param {string} expected @param {string} appCertificate */
export function verifyUploadCertificate(actual, expected, appCertificate) {
  const upload = normalizeFingerprint(actual);
  if (upload !== normalizeFingerprint(expected)) {
    throw new Error('AAB certificate does not match the expected upload certificate');
  }
  if (upload === normalizeFingerprint(appCertificate)) {
    throw new Error('AAB upload certificate must be distinct from the app certificate');
  }
}

/** @param {string} source android-status.ts, not a guessed or environment-controlled flag */
export function parseHardwareValidated(source) {
  const matches = [
    ...source.matchAll(
      /^export const ANDROID_WRITE_VALIDATED(?:\s*:\s*boolean)?\s*=\s*(true|false)\s*;/gm,
    ),
  ];
  if (matches.length !== 1) throw new Error('Cannot parse ANDROID_WRITE_VALIDATED');
  return matches[0][1] === 'true';
}

/** Shape of a release tag. Other android-v* tags (such as android-v1.0.1-rc1) never set the floor. */
export const ANDROID_RELEASE_TAG = /^android-v\d+\.\d+\.\d+$/;

/**
 * Only a push of an android-v* tag publishes. Pull requests and workflow_dispatch dry runs,
 * including a dispatch started from a tag ref (GITHUB_REF_TYPE=tag), are not publishing runs.
 * @param {string | undefined} eventName GITHUB_EVENT_NAME
 * @param {string | undefined} refType GITHUB_REF_TYPE
 */
export function isTagPush(eventName, refType) {
  return eventName === 'push' && refType === 'tag';
}

/**
 * Read every published Android manifest, ignoring other releases and drafts.
 * Malformed android-v* tags are skipped with a warning, so a stray tag cannot block every run;
 * the tag being released is checked separately against apps/android/package.json.
 * @param {{ tag_name: string, draft: boolean, assets: { id: number, name: string }[] }[]} releases
 * @param {(assetId: number) => unknown} readManifest
 * @param {string[]} [tags] existing tags, excluding only the tag triggering this release
 * @param {(message: string) => void} [warn]
 */
export function getPreviousAndroidVersionCode(
  releases,
  readManifest,
  tags = [],
  warn = console.warn,
) {
  let previous = 0;
  for (const tag of tags) {
    if (!tag.startsWith('android-v')) continue;
    if (!ANDROID_RELEASE_TAG.test(tag)) {
      warn(
        `::warning::Ignoring malformed Android tag ${JSON.stringify(tag)} for the versionCode floor (expected android-v<major>.<minor>.<patch>)`,
      );
      continue;
    }
    previous = Math.max(previous, deriveVersionCode(tag.slice('android-v'.length)));
  }
  for (const release of releases) {
    if (release.draft || !release.tag_name.startsWith('android-v')) continue;
    const assets = release.assets.filter((asset) => asset.name === 'release-manifest.json');
    if (assets.length !== 1) {
      throw new Error(
        `Published Android release "${release.tag_name}" must have exactly one release-manifest.json`,
      );
    }
    if (!Number.isSafeInteger(assets[0].id) || assets[0].id < 1) {
      throw new Error(
        `Published Android release "${release.tag_name}" has an invalid manifest asset ID`,
      );
    }
    const manifest = readManifest(assets[0].id);
    const code =
      typeof manifest === 'object' && manifest !== null && 'versionCode' in manifest
        ? manifest.versionCode
        : undefined;
    if (typeof code !== 'number' || !Number.isSafeInteger(code) || code < 1 || code > 2100000000) {
      throw new Error(
        `Published Android release "${release.tag_name}" has an invalid manifest versionCode`,
      );
    }
    previous = Math.max(previous, code);
  }
  return previous;
}

/**
 * Deterministic, ordered x.y.z encoding. Minor and patch are limited to 0..99 to avoid collisions.
 * The workflow passes the maximum published Android versionCode; repeat/downgrade releases fail closed.
 * @param {string} version
 * @param {number} previous
 */
export function deriveVersionCode(version, previous = 0) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Version must be x.y.z');
  }
  const [major, minor, patch] = version.split('.').map(Number);
  const code = major * 10000 + minor * 100 + patch;
  if (minor > 99 || patch > 99 || !Number.isSafeInteger(code) || code < 1 || code > 2100000000) {
    throw new Error('Version cannot be encoded as a positive Android versionCode');
  }
  if (!Number.isInteger(previous) || previous < 0 || previous > 2100000000 || code <= previous) {
    throw new Error('versionCode must be greater than the previous release versionCode');
  }
  return code;
}

/**
 * Only publishing tag pushes must advance the floor; PR/dispatch dry runs can rebuild a released
 * version, also when a dispatch starts from a tag ref.
 * @param {string} version
 * @param {number} previous
 * @param {boolean} publishing isTagPush(GITHUB_EVENT_NAME, GITHUB_REF_TYPE)
 * @param {(message: string) => void} [warn]
 */
export function versionCodeForRun(version, previous, publishing, warn = console.warn) {
  if (typeof publishing !== 'boolean') {
    throw new Error('publishing must be a boolean from isTagPush');
  }
  if (!Number.isInteger(previous) || previous < 0 || previous > 2100000000) {
    throw new Error('Previous Android versionCode baseline is invalid');
  }
  const code = deriveVersionCode(version, publishing ? previous : 0);
  if (!publishing && code <= previous) {
    warn(
      `::warning::Dry-run versionCode ${code} is not above the published/tag maximum ${previous}`,
    );
  }
  return code;
}

/** @param {Uint8Array} bytes */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @typedef {{ version: string, capacitorVersion: string, minWebViewVersion: number,
 *   hardwareValidated: boolean }} ReleaseMetadata
 * @typedef {{ apk: Uint8Array, aab: Uint8Array, apkName: string, aabName: string,
 *   expectedAppCertSha256: string, actualAppCertSha256: string, commit: string,
 *   repoUrl: string, version: string, versionCode: number }} ReleaseInputs
 */

/**
 * Pure artifact renderer. The CLI obtains actualAppCertSha256 from apksigner, never from the caller.
 * @param {ReleaseInputs} input
 * @param {ReleaseMetadata} metadata
 */
export function createArtifacts(input, metadata) {
  if (input.version !== metadata.version)
    throw new Error('Version mismatch with apps/android/package.json');
  if (input.versionCode !== deriveVersionCode(input.version)) {
    throw new Error('versionCode does not match the deterministic version encoding');
  }
  const expected = normalizeFingerprint(input.expectedAppCertSha256);
  const actual = normalizeFingerprint(input.actualAppCertSha256);
  if (actual !== expected)
    throw new Error('APK certificate does not match the expected app certificate');
  if (!/^[\da-f]{40}$/i.test(input.commit)) throw new Error('Commit must be a full Git commit SHA');
  const repo = new URL(input.repoUrl);
  if (
    repo.protocol !== 'https:' ||
    repo.username ||
    repo.password ||
    repo.search ||
    repo.hash ||
    !/^\/[\w.-]+\/[\w.-]+\/?$/.test(repo.pathname)
  ) {
    throw new Error('Repository URL must be a bare HTTPS repository URL');
  }
  for (const name of [input.apkName, input.aabName]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('Unsafe artifact filename');
  }
  if (input.apkName === input.aabName) throw new Error('Artifact filenames must differ');
  const sourceUrl = `${repo.href.replace(/\/$/, '').replace(/\.git$/, '')}/tree/${input.commit}`;
  const manifest = {
    version: input.version,
    versionCode: input.versionCode,
    commit: input.commit,
    sourceUrl,
    apkSha256: sha256(input.apk),
    aabSha256: sha256(input.aab),
    apkCertSha256: actual,
    capacitorVersion: metadata.capacitorVersion,
    minWebViewVersion: metadata.minWebViewVersion,
    hardwareValidated: metadata.hardwareValidated,
  };
  const sums = [
    [input.apkName, manifest.apkSha256],
    [input.aabName, manifest.aabSha256],
  ]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, hash]) => `${hash}  ${name}\n`)
    .join('');
  const notice = metadata.hardwareValidated ? '' : `${NOTICE_PT_BR}\n\n${NOTICE_EN_US}\n\n`;
  const notes =
    `${notice}# Android ${input.version}\n\n` +
    `Version code: ${input.versionCode}\n\n` +
    '## Verify / Verificar\n\n' +
    'Download the APK, AAB and SHA256SUMS.txt into the same directory, then run:\n\n' +
    'Baixe o APK, o AAB e o SHA256SUMS.txt no mesmo diretório e execute:\n\n' +
    '```sh\nsha256sum -c SHA256SUMS.txt\n' +
    `apksigner verify --verbose --print-certs ${input.apkName}\n` +
    '```\n\nIf you downloaded only one artifact, check its checksum with:\n\n' +
    'Se você baixou apenas um artefato, verifique sua soma de verificação com:\n\n' +
    '```sh\nsha256sum -c --ignore-missing SHA256SUMS.txt\n```\n\n' +
    'Expected app certificate SHA-256:\n\n' +
    'SHA-256 esperado do certificado do app:\n\n' +
    `\`${actual.match(/../g)?.join(':').toUpperCase()}\`\n\n` +
    'The GitHub APK uses the app signing key; the AAB uses a different upload key for Play.\n\n' +
    'O APK do GitHub usa a chave de assinatura do app; o AAB usa uma chave de upload diferente para a Play.\n\n' +
    `Source / Código-fonte (AGPL-3.0-only): ${sourceUrl}\n`;
  return {
    'SHA256SUMS.txt': sums,
    'release-manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'RELEASE_NOTES.md': notes,
  };
}

/**
 * @typedef {{ applicationId: string, versionCode: number, versionName: string }} ArtifactIdentity
 */

/**
 * @param {string} applicationId @param {string} versionCode @param {string} versionName
 * @param {string} source
 * @returns {ArtifactIdentity}
 */
function artifactIdentity(applicationId, versionCode, versionName, source) {
  if (!/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(applicationId)) {
    throw new Error(`${source} manifest has a malformed applicationId`);
  }
  if (!/^[1-9]\d*$/.test(versionCode) || Number(versionCode) > 2100000000) {
    throw new Error(`${source} manifest has a malformed versionCode`);
  }
  if (!versionName) throw new Error(`${source} manifest has no versionName`);
  return { applicationId, versionCode: Number(versionCode), versionName };
}

/** @param {string} output output of `aapt2 dump badging <apk>` */
export function parseApkBadging(output) {
  if (/^package:.*\bversionCodeMajor\s*=/m.test(output)) {
    throw new Error('APK manifest must not declare android:versionCodeMajor');
  }
  const matches = [
    ...output.matchAll(/^package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'/gm),
  ];
  if (matches.length !== 1) {
    throw new Error('aapt2 badging must report exactly one package line');
  }
  return artifactIdentity(matches[0][1], matches[0][2], matches[0][3], 'APK');
}

/**
 * Read one entry through the ZIP central directory. Only what AGP/bundletool and jarsigner write
 * is accepted: no ZIP64, multi-disk, encryption or other compression; duplicate names, size or
 * CRC-32 mismatches fail closed.
 * @param {Uint8Array} bytes
 * @param {string} name
 */
export function readZipEntry(bytes, name) {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wanted = Buffer.from(name, 'utf8');
  const corrupt = () => new Error(`Corrupt ZIP archive while reading ${name}`);
  let eocd = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    // End of central directory record whose comment length reaches exactly the end of the file.
    if (zip.readUInt32LE(at) === 0x06054b50 && at + 22 + zip.readUInt16LE(at + 20) === zip.length) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error(`Not a ZIP archive: cannot read ${name}`);
  const entries = zip.readUInt16LE(eocd + 10);
  const size = zip.readUInt32LE(eocd + 12);
  const start = zip.readUInt32LE(eocd + 16);
  if (
    zip.readUInt16LE(eocd + 4) !== 0 ||
    zip.readUInt16LE(eocd + 6) !== 0 ||
    zip.readUInt16LE(eocd + 8) !== entries ||
    entries === 0xffff ||
    size === 0xffffffff ||
    start === 0xffffffff
  ) {
    throw new Error('Multi-disk and ZIP64 archives are not supported');
  }
  if (start + size > eocd) throw corrupt();
  /** @type {number[]} */
  const found = [];
  let at = start;
  for (let index = 0; index < entries; index++) {
    if (at + 46 > start + size || zip.readUInt32LE(at) !== 0x02014b50) throw corrupt();
    const nameLength = zip.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (next > start + size) throw corrupt();
    if (zip.subarray(at + 46, at + 46 + nameLength).equals(wanted)) found.push(at);
    at = next;
  }
  if (at !== start + size) throw corrupt();
  if (found.length !== 1) throw new Error(`ZIP archive must contain exactly one ${name}`);
  const entry = found[0];
  const method = zip.readUInt16LE(entry + 10);
  const crc = zip.readUInt32LE(entry + 16);
  const compressedSize = zip.readUInt32LE(entry + 20);
  const uncompressedSize = zip.readUInt32LE(entry + 24);
  const maxEntrySize = 1024 * 1024;
  if (uncompressedSize > maxEntrySize) throw new Error(`ZIP entry ${name} exceeds 1 MiB`);
  const local = zip.readUInt32LE(entry + 42);
  if (zip.readUInt16LE(entry + 8) & 1) throw new Error(`Encrypted ZIP entry: ${name}`);
  if ([compressedSize, uncompressedSize, local].includes(0xffffffff)) {
    throw new Error('Multi-disk and ZIP64 archives are not supported');
  }
  if (local + 30 > start || zip.readUInt32LE(local) !== 0x04034b50) throw corrupt();
  const localNameLength = zip.readUInt16LE(local + 26);
  if (!zip.subarray(local + 30, local + 30 + localNameLength).equals(wanted)) throw corrupt();
  const data = local + 30 + localNameLength + zip.readUInt16LE(local + 28);
  if (data + compressedSize > start) throw corrupt();
  const raw = zip.subarray(data, data + compressedSize);
  if (method !== 0 && method !== 8) {
    throw new Error(`Unsupported ZIP compression method ${method}: ${name}`);
  }
  let content = raw;
  if (method === 8) {
    try {
      content = inflateRawSync(raw, { maxOutputLength: maxEntrySize });
    } catch {
      throw corrupt();
    }
  }
  if (content.length !== uncompressedSize || crc32(content) !== crc) {
    throw new Error(`ZIP entry ${name} fails its size/CRC-32 check`);
  }
  return content;
}

/**
 * Minimal protobuf decoder for the aapt2 XML messages. Groups are rejected.
 * @param {Uint8Array} bytes
 * @returns {{ field: number, wire: number, value: bigint | Uint8Array }[]}
 */
function protoFields(bytes) {
  /** @type {{ field: number, wire: number, value: bigint | Uint8Array }[]} */
  const fields = [];
  let at = 0;
  const varint = () => {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (at >= bytes.length) throw new Error('Truncated protobuf in the AAB manifest');
      const byte = bytes[at++];
      result |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return result;
    }
    throw new Error('Malformed protobuf varint in the AAB manifest');
  };
  while (at < bytes.length) {
    const key = varint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field < 1 || field > 536870911) {
      throw new Error('Malformed protobuf field in the AAB manifest');
    }
    if (wire === 0) fields.push({ field, wire, value: varint() });
    else if (wire === 1 || wire === 2 || wire === 5) {
      const length = wire === 1 ? 8n : wire === 5 ? 4n : varint();
      if (length > BigInt(bytes.length - at)) {
        throw new Error('Truncated protobuf in the AAB manifest');
      }
      fields.push({ field, wire, value: bytes.subarray(at, at + Number(length)) });
      at += Number(length);
    } else throw new Error(`Unsupported protobuf wire type ${wire} in the AAB manifest`);
  }
  return fields;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** @param {{ wire: number, value: bigint | Uint8Array }} entry */
function protoBytes(entry) {
  if (entry.wire !== 2 || !(entry.value instanceof Uint8Array)) {
    throw new Error('Unexpected protobuf wire type in the AAB manifest');
  }
  return entry.value;
}

/** @param {{ wire: number, value: bigint | Uint8Array }} entry */
function protoVarint(entry) {
  if (entry.wire !== 0 || typeof entry.value !== 'bigint') {
    throw new Error('Unexpected protobuf wire type in the AAB manifest');
  }
  return entry.value;
}

/**
 * @typedef {{ namespaceUri: string, name: string, value: string, compiledInt?: bigint,
 *   compiledString?: string }} ProtoAttribute
 */

/**
 * aapt.pb.XmlAttribute: 1 namespace_uri, 2 name, 3 value, 6 compiled_item. Item: 2 str, 3 raw_str
 * (String/RawString: 1 value), 7 prim (Primitive: 6 int_decimal_value, 7 int_hexadecimal_value).
 * @param {Uint8Array} bytes
 */
function protoAttribute(bytes) {
  /** @type {ProtoAttribute} */
  const attribute = { namespaceUri: '', name: '', value: '' };
  for (const entry of protoFields(bytes)) {
    if (entry.field === 1) attribute.namespaceUri = utf8.decode(protoBytes(entry));
    else if (entry.field === 2) attribute.name = utf8.decode(protoBytes(entry));
    else if (entry.field === 3) attribute.value = utf8.decode(protoBytes(entry));
    else if (entry.field === 6) {
      for (const item of protoFields(protoBytes(entry))) {
        if (item.field === 2 || item.field === 3) {
          for (const string of protoFields(protoBytes(item))) {
            if (string.field === 1) attribute.compiledString = utf8.decode(protoBytes(string));
          }
        } else if (item.field === 7) {
          for (const primitive of protoFields(protoBytes(item))) {
            if (primitive.field === 6) {
              attribute.compiledInt = BigInt.asIntN(32, protoVarint(primitive));
            } else if (primitive.field === 7) {
              attribute.compiledInt = BigInt.asUintN(32, protoVarint(primitive));
            }
          }
        }
      }
    }
  }
  return attribute;
}

/**
 * Read the base module manifest of an AAB (aapt2 protobuf XML, base/manifest/AndroidManifest.xml).
 * Pure and offline: no bundletool download, no SDK. The raw `value` and the compiled item written by
 * aapt2 must agree when both are present.
 * @param {Uint8Array} aab
 * @returns {ArtifactIdentity}
 */
export function readAabManifest(aab) {
  const roots = protoFields(readZipEntry(aab, 'base/manifest/AndroidManifest.xml')).filter(
    (entry) => entry.field === 1 || entry.field === 2,
  );
  if (roots.length !== 1 || roots[0].field !== 1) {
    throw new Error('AAB manifest root must be a single XML element');
  }
  // aapt.pb.XmlElement: 2 namespace_uri, 3 name, 4 attribute (1 namespaces and 5 children unused).
  let namespaceUri = '';
  let name = '';
  /** @type {ProtoAttribute[]} */
  const attributes = [];
  for (const entry of protoFields(protoBytes(roots[0]))) {
    if (entry.field === 2) namespaceUri = utf8.decode(protoBytes(entry));
    else if (entry.field === 3) name = utf8.decode(protoBytes(entry));
    else if (entry.field === 4) attributes.push(protoAttribute(protoBytes(entry)));
  }
  if (namespaceUri !== '' || name !== 'manifest') {
    throw new Error('AAB manifest root must be <manifest>');
  }
  /** @param {string} uri @param {string} attributeName */
  const attribute = (uri, attributeName) => {
    const matches = attributes.filter(
      (item) => item.namespaceUri === uri && item.name === attributeName,
    );
    if (matches.length !== 1) {
      throw new Error(
        `AAB manifest must have exactly one ${uri ? 'android:' : ''}${attributeName}`,
      );
    }
    return matches[0];
  };
  const android = 'http://schemas.android.com/apk/res/android';
  if (
    attributes.some((item) => item.namespaceUri === android && item.name === 'versionCodeMajor')
  ) {
    throw new Error('AAB manifest must not declare android:versionCodeMajor');
  }
  const code = attribute(android, 'versionCode');
  const versionName = attribute(android, 'versionName');
  let versionCode = code.value;
  if (code.compiledInt !== undefined) {
    if (!versionCode) versionCode = String(code.compiledInt);
    else if (String(code.compiledInt) !== versionCode) {
      throw new Error('AAB manifest versionCode differs from its compiled value');
    }
  }
  let versionNameValue = versionName.value;
  if (versionName.compiledString !== undefined) {
    if (!versionNameValue) versionNameValue = versionName.compiledString;
    else if (versionName.compiledString !== versionNameValue) {
      throw new Error('AAB manifest versionName differs from its compiled value');
    }
  }
  return artifactIdentity(attribute('', 'package').value, versionCode, versionNameValue, 'AAB');
}

/**
 * The APK and AAB must carry exactly the identity published in release-manifest.json.
 * @param {{ apk: ArtifactIdentity, aab: ArtifactIdentity }} actual
 * @param {ArtifactIdentity} expected
 */
export function verifyArtifactIdentity(actual, expected) {
  /** @type {(keyof ArtifactIdentity)[]} */
  const keys = ['applicationId', 'versionCode', 'versionName'];
  for (const [label, found] of Object.entries({ APK: actual.apk, AAB: actual.aab })) {
    for (const key of keys) {
      if (found?.[key] !== expected[key]) {
        throw new Error(
          `${label} ${key} ${JSON.stringify(found?.[key])} does not match the release manifest ${JSON.stringify(expected[key])}`,
        );
      }
    }
  }
}

/** @param {string} apk APK identity from aapt2 of the pinned build-tools 36.1.0 */
function dumpApkBadging(apk) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const executable = process.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
  const aapt2 = process.env.AAPT2 || (sdk && join(sdk, 'build-tools', '36.1.0', executable));
  if (!aapt2) throw new Error('Set AAPT2 or ANDROID_HOME to read the APK manifest');
  return parseApkBadging(
    execFileSync(aapt2, ['dump', 'badging', apk], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

/** @param {string} apk */
function verifyApk(apk) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const signer = process.env.APKSIGNER || (sdk && join(sdk, 'build-tools', '36.1.0', 'apksigner'));
  if (!signer) throw new Error('Set APKSIGNER or ANDROID_HOME to verify the APK certificate');
  // CI runs on Linux; Windows callers can set APKSIGNER to a native executable wrapper.
  return parseApkCertificate(
    execFileSync(signer, ['verify', '--verbose', '--print-certs', apk], {
      encoding: 'utf8',
    }),
  );
}

/**
 * @param {string[]} argv
 * @param {(apk: string) => string} inspectApk injectable only for local tests, not a CLI option
 * @param {(apk: string) => ArtifactIdentity} inspectApkManifest same; aapt2 dump badging
 */
export function main(argv, inspectApk = verifyApk, inspectApkManifest = dumpApkBadging) {
  const names = [
    'apk',
    'aab',
    'expected-app-cert-sha256',
    'commit',
    'repo-url',
    'version',
    'version-code',
    'out-dir',
  ];
  try {
    /** @type {Record<string, string>} */
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
      const name = argv[i].slice(2);
      if (!argv[i].startsWith('--') || !names.includes(name) || !argv[i + 1] || args[name]) {
        throw new Error('Invalid or duplicate argument');
      }
      args[name] = argv[i + 1];
    }
    if (names.some((name) => !args[name])) {
      throw new Error(
        `Usage: android-artifacts.mjs ${names.map((name) => `--${name} <value>`).join(' ')}`,
      );
    }
    const root = fileURLToPath(new URL('../', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(root, 'apps/android/package.json'), 'utf8'));
    if (args.version !== pkg.version)
      throw new Error('Version mismatch with apps/android/package.json');
    normalizeFingerprint(args['expected-app-cert-sha256']);
    if (!/^[1-9]\d*$/.test(args['version-code'])) throw new Error('Invalid versionCode');
    const aab = readFileSync(args.aab);
    const files = createArtifacts(
      {
        apk: readFileSync(args.apk),
        aab,
        apkName: basename(args.apk),
        aabName: basename(args.aab),
        expectedAppCertSha256: args['expected-app-cert-sha256'],
        actualAppCertSha256: inspectApk(args.apk),
        commit: args.commit,
        repoUrl: args['repo-url'],
        version: args.version,
        versionCode: Number(args['version-code']),
      },
      {
        version: pkg.version,
        capacitorVersion: pkg.dependencies['@capacitor/android'],
        minWebViewVersion: MIN_WEBVIEW_VERSION,
        hardwareValidated: parseHardwareValidated(
          readFileSync(join(root, 'web/src/lib/cable/android-status.ts'), 'utf8'),
        ),
      },
    );
    // n5: both artifacts must carry the identity being published; nothing is written otherwise.
    const manifest = JSON.parse(files['release-manifest.json']);
    const expected = {
      applicationId: buildConfig({ OA_ANDROID_TARGET: 'prod' }, pkg.version).appId,
      versionCode: manifest.versionCode,
      versionName: manifest.version,
    };
    verifyArtifactIdentity(
      { apk: inspectApkManifest(args.apk), aab: readAabManifest(aab) },
      expected,
    );
    mkdirSync(args['out-dir'], { recursive: true });
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(args['out-dir'], name), content);
    process.stdout.write(
      `android-artifacts: APK and AAB manifests match ${expected.applicationId} versionCode ${expected.versionCode} versionName ${expected.versionName}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `android-artifacts: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
