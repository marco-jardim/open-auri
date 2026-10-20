#!/usr/bin/env node
// Release metadata has no timestamps or machine-specific paths: identical inputs yield identical files.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MIN_WEBVIEW_VERSION } from '../apps/android/capacitor.targets.mjs';

export const NOTICE_PT_BR =
  'Aviso: a gravação pelo app ainda não foi testada num cabo Auri real. O app usa o mesmo protocolo e envia os mesmos bytes que o site no computador (conferido por testes automáticos); em teoria o resultado é o mesmo, mas não há garantia. Relate o resultado em https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml';
export const NOTICE_EN_US =
  'Notice: writing from the app has not been tested on a real Auri cable yet. The app uses the same protocol and sends the same bytes as the desktop site (checked by automated tests); in theory the result is the same, but it is not guaranteed. Report your result at https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml';

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

/**
 * Read every published Android manifest, ignoring other releases and drafts.
 * @param {{ tag_name: string, draft: boolean, assets: { id: number, name: string }[] }[]} releases
 * @param {(assetId: number) => unknown} readManifest
 * @param {string[]} [tags] existing tags, excluding only the tag triggering this release
 */
export function getPreviousAndroidVersionCode(releases, readManifest, tags = []) {
  let previous = 0;
  for (const tag of tags) {
    if (tag.startsWith('android-v')) {
      previous = Math.max(previous, deriveVersionCode(tag.slice('android-v'.length)));
    }
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
 * Only publishing tags must advance the floor; PR/dispatch dry runs can rebuild a released version.
 * @param {string} version
 * @param {number} previous
 * @param {string | undefined} refType
 * @param {(message: string) => void} [warn]
 */
export function versionCodeForRun(version, previous, refType, warn = console.warn) {
  if (!Number.isInteger(previous) || previous < 0 || previous > 2100000000) {
    throw new Error('Previous Android versionCode baseline is invalid');
  }
  const code = deriveVersionCode(version, refType === 'tag' ? previous : 0);
  if (refType !== 'tag' && code <= previous) {
    warn(`::warning::Dry-run versionCode ${code} is not above the published/tag maximum ${previous}`);
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
 */
export function main(argv, inspectApk = verifyApk) {
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
    const files = createArtifacts(
      {
        apk: readFileSync(args.apk),
        aab: readFileSync(args.aab),
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
    mkdirSync(args['out-dir'], { recursive: true });
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(args['out-dir'], name), content);
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
