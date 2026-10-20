// Deliberately not *.test.mjs: normal Node/tooling tests do not require an Android SDK.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { deriveVersionCode, normalizeFingerprint, parseApkCertificate, sha256 } from '../../tools/android-artifacts.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const read = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

function findJdk() {
  const gradleHome = process.env.GRADLE_USER_HOME || join(homedir(), '.gradle');
  const homes = [process.env.JAVA_HOME];
  for (const path of [
    join(gradleHome, 'gradle.properties'),
    join(root, 'apps/android/android/gradle.properties'),
    join(root, 'apps/android/android/.gradle/config.properties'),
  ]) {
    if (!existsSync(path)) continue;
    for (const match of read(path).matchAll(/^[ \t]*(?:org\.gradle\.java\.(?:home|installations\.paths)|java\.home)[ \t]*[=:][ \t]*(.+)$/gm)) {
      homes.push(...match[1].trim().replace(/\\([\\ :])/g, '$1').split(','));
    }
  }
  const cachedJdks = join(gradleHome, 'jdks');
  if (existsSync(cachedJdks)) {
    for (const entry of readdirSync(cachedJdks, { withFileTypes: true })) {
      if (entry.isDirectory()) homes.push(join(cachedJdks, entry.name));
    }
  }
  const names = ['java', 'keytool', 'jarsigner'];
  for (const home of homes) {
    if (!home) continue;
    const release = join(home.trim(), 'release');
    if (!existsSync(release) || !/^JAVA_VERSION="21(?:[.+-][^"]*)?"$/m.test(read(release))) continue;
    const tools = Object.fromEntries(names.map((name) => [name, join(home.trim(), 'bin', `${name}${windows ? '.exe' : ''}`)]));
    if (Object.values(tools).every((path) => existsSync(path))) return { home: home.trim(), ...tools };
  }
  throw new Error('JDK 21 keytool/jarsigner missing: set JAVA_HOME or Gradle org.gradle.java.home/installations.paths to the daemon JDK.');
}

function findBuildTools() {
  for (const sdk of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (!sdk || !existsSync(join(sdk, 'build-tools'))) continue;
    const versions = readdirSync(join(sdk, 'build-tools'))
      .filter((name) => /^36\.\d+\.\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    // Use the workflow version when installed; otherwise allow another stable 36.x toolchain.
    if (versions.includes('36.1.0')) versions.unshift('36.1.0');
    for (const version of versions) {
      const dir = join(sdk, 'build-tools', version);
      const zipalign = join(dir, windows ? 'zipalign.exe' : 'zipalign');
      const apksigner = (windows ? ['apksigner.exe', 'apksigner.bat'] : ['apksigner'])
        .map((name) => join(dir, name)).find((path) => existsSync(path));
      if (existsSync(zipalign) && apksigner) return { zipalign, apksigner, dir };
    }
  }
  throw new Error('Android build-tools 36.x zipalign/apksigner missing: set ANDROID_HOME or ANDROID_SDK_ROOT (CI uses 36.1.0).');
}

function fingerprint(output) {
  const matches = [...output.matchAll(/^\s*SHA256: ([\dA-Fa-f:]+)\s*$/gm)];
  assert.equal(matches.length, 1, 'keytool must report exactly one certificate');
  return normalizeFingerprint(matches[0][1]);
}

test('release APK and AAB use distinct ephemeral app/upload keys and verified release metadata', { timeout: 45 * 60_000 }, (t) => {
  const jdk = findJdk();
  const tools = findBuildTools();
  const temp = mkdtempSync(join(tmpdir(), 'open-auri-release-'));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const appPassword = randomBytes(24).toString('hex');
  const uploadPassword = randomBytes(24).toString('hex');
  const env = {
    ...process.env,
    JAVA_HOME: jdk.home,
    PATH: `${join(jdk.home, 'bin')}${delimiter}${process.env.PATH || ''}`,
    ANDROID_APP_KEYSTORE_PASSWORD: appPassword,
    ANDROID_APP_KEY_PASSWORD: appPassword,
    ANDROID_UPLOAD_KEYSTORE_PASSWORD: uploadPassword,
    ANDROID_UPLOAD_KEY_PASSWORD: uploadPassword,
    APKSIGNER: tools.apksigner,
  };
  const redact = (text) => String(text || '').replaceAll(appPassword, '[redacted]').replaceAll(uploadPassword, '[redacted]');
  const run = (command, args, childEnv = env) => {
    const result = spawnSync(command, args, { cwd: root, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 40 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, redact(`${basename(command)} failed: ${result.error?.message || ''}\n${result.stdout}\n${result.stderr}`));
    return result.stdout.replaceAll('\r\n', '\n');
  };
  const signerJar = join(tools.dir, 'lib', 'apksigner.jar');
  const batchSigner = windows && tools.apksigner.endsWith('.bat');
  // The Windows SDK batch launcher delegates to this exact JAR. No shell or password arguments.
  const apksigner = (args) => batchSigner ? run(jdk.java, ['-jar', signerJar, ...args]) : run(tools.apksigner, args);
  if (batchSigner) assert.ok(existsSync(signerJar), 'Windows apksigner.bat requires lib/apksigner.jar');

  const outputs = join(root, 'apps/android/android/app/build/outputs');
  const unsigned = () => {
    const find = (dir, pattern) => existsSync(dir) ? readdirSync(dir).filter((name) => pattern.test(name)).map((name) => join(dir, name)) : [];
    return {
      apk: find(join(outputs, 'apk/release'), /-unsigned\.apk$/),
      aab: find(join(outputs, 'bundle/release'), /\.aab$/),
    };
  };
  let inputs = unsigned();
  if (!inputs.apk.length || !inputs.aab.length) {
    t.diagnostic('Unsigned outputs missing; running npm run build:android:release.');
    if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, 'run', 'build:android:release']);
    else if (windows) run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', 'run', 'build:android:release']);
    else run('npm', ['run', 'build:android:release']);
    inputs = unsigned();
  }
  assert.equal(inputs.apk.length, 1, 'Expected exactly one unsigned release APK');
  assert.equal(inputs.aab.length, 1, 'Expected exactly one unsigned release AAB');

  const keys = {};
  for (const role of ['APP', 'UPLOAD']) {
    const alias = `android-ci-${role.toLowerCase()}`;
    const keystore = join(temp, `android-${role.toLowerCase()}.p12`);
    run(jdk.keytool, [
      '-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12',
      '-storepass:env', `ANDROID_${role}_KEYSTORE_PASSWORD`, '-keypass:env', `ANDROID_${role}_KEY_PASSWORD`,
      '-alias', alias, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2',
      '-dname', `CN=Android CI ${role}, O=Open Auri, C=BR`, '-noprompt',
    ]);
    keys[role] = { alias, keystore, fingerprint: fingerprint(run(jdk.keytool, [
      '-J-Duser.language=en', '-list', '-v', '-keystore', keystore,
      '-storepass:env', `ANDROID_${role}_KEYSTORE_PASSWORD`, '-alias', alias,
    ])) };
  }
  assert.notEqual(keys.APP.fingerprint, keys.UPLOAD.fingerprint);

  const pkg = JSON.parse(read(join(root, 'apps/android/package.json')));
  const out = join(temp, 'release');
  mkdirSync(out);
  const apk = join(out, `open-auri-${pkg.version}.apk`);
  const aab = join(out, `open-auri-${pkg.version}.aab`);
  const aligned = join(temp, 'aligned.apk');
  // Mirror .github/workflows/android-release.yml: zipalign, v2/v3 APK, upload-signed AAB.
  run(tools.zipalign, ['-p', '-f', '4', inputs.apk[0], aligned]);
  apksigner([
    'sign', '--ks', keys.APP.keystore, '--ks-key-alias', keys.APP.alias,
    '--ks-pass', 'env:ANDROID_APP_KEYSTORE_PASSWORD', '--key-pass', 'env:ANDROID_APP_KEY_PASSWORD',
    '--v1-signing-enabled', 'false', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',
    '--out', apk, aligned,
  ]);
  const verification = apksigner(['verify', '--verbose', '--print-certs', apk]);
  assert.match(verification, /^Verified using v1 scheme \(JAR signing\): false$/m);
  assert.match(verification, /^Verified using v2 scheme \(APK Signature Scheme v2\): true$/m);
  assert.match(verification, /^Verified using v3 scheme \(APK Signature Scheme v3\): true$/m);
  assert.equal(parseApkCertificate(verification), keys.APP.fingerprint);
  run(tools.zipalign, ['-c', '-p', '4', apk]);
  run(jdk.jarsigner, [
    '-keystore', keys.UPLOAD.keystore, '-storepass:env', 'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
    '-keypass:env', 'ANDROID_UPLOAD_KEY_PASSWORD', '-sigalg', 'SHA256withRSA', '-digestalg', 'SHA-256',
    '-signedjar', aab, inputs.aab[0], keys.UPLOAD.alias,
  ]);
  assert.match(run(jdk.jarsigner, ['-J-Duser.language=en', '-verify', aab]), /^jar verified\.$/m);
  const aabCert = fingerprint(run(jdk.keytool, ['-J-Duser.language=en', '-printcert', '-jarfile', aab]));
  assert.equal(aabCert, keys.UPLOAD.fingerprint);
  assert.notEqual(aabCert, keys.APP.fingerprint);

  const nodeArgs = [];
  if (batchSigner) {
    // The CLI uses execFileSync (which cannot launch .bat on Node 24). Adapt only its launch
    // transport on Windows, still executing the real SDK verifier with all original arguments.
    const preload = join(temp, 'apksigner-windows.mjs');
    writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => command === process.env.APKSIGNER
  ? original(process.env.ANDROID_DRYRUN_JAVA, ['-jar', process.env.ANDROID_DRYRUN_SIGNER_JAR, ...args], options)
  : original(command, args, options);
syncBuiltinESMExports();
`);
    env.ANDROID_DRYRUN_JAVA = jdk.java;
    env.ANDROID_DRYRUN_SIGNER_JAR = signerJar;
    nodeArgs.push('--import', pathToFileURL(preload).href);
  }
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  run(process.execPath, [...nodeArgs, 'tools/android-artifacts.mjs',
    '--apk', apk, '--aab', aab, '--expected-app-cert-sha256', keys.APP.fingerprint,
    '--commit', commit, '--repo-url', 'https://github.com/marco-jardim/open-auri',
    '--version', pkg.version, '--version-code', String(deriveVersionCode(pkg.version)), '--out-dir', out,
  ]);
  const hashes = [apk, aab].map((path) => [basename(path), sha256(readFileSync(path))]);
  const sums = hashes.sort(([a], [b]) => a.localeCompare(b)).map(([name, hash]) => `${hash}  ${name}\n`).join('');
  assert.equal(read(join(out, 'SHA256SUMS.txt')), sums);
  const manifest = JSON.parse(read(join(out, 'release-manifest.json')));
  assert.equal(manifest.apkCertSha256, keys.APP.fingerprint);
  assert.equal(manifest.hardwareValidated, false);
  assert.equal(manifest.apkSha256, sha256(readFileSync(apk)));
  assert.equal(manifest.aabSha256, sha256(readFileSync(aab)));
  const plan = read(join(root, 'docs/plans/2026-10-18-android-capacitor-plano.md'));
  const g5 = plan.split('**G.5 Notas da release, README e ficha da Play**')[1].split('**G.6')[0];
  const pt = g5.match(/- pt-BR: "([^"]+)"/)[1];
  const en = g5.match(/- en-US: "([^"]+)"/)[1];
  assert.ok(read(join(out, 'RELEASE_NOTES.md')).startsWith(`${pt}\n\n${en}\n\n`));
  t.diagnostic('Verified APK v2/v3 app certificate, distinct AAB upload certificate, checksums, manifest and G.5 notes.');
});
