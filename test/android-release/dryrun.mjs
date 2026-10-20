// Deliberately not *.test.mjs: normal Node/tooling tests do not require an Android SDK.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join, posix, win32 } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  deriveVersionCode,
  normalizeFingerprint,
  parseApkCertificate,
  sha256,
  verifyUploadCertificate,
} from '../../tools/android-artifacts.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const read = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

function validatedDirectory(directory, paths = windows ? win32 : posix) {
  if (
    typeof directory !== 'string' ||
    !paths.isAbsolute(directory) ||
    /[^-A-Za-z0-9_.:=@+/,\\ ]/.test(directory)
  ) {
    throw new Error('Tool base directory must be absolute and contain only safe path characters');
  }
  return directory;
}

function toolCommand(command, args, env, platform = process.platform) {
  if (
    typeof command !== 'string' ||
    command.length === 0 ||
    /[^-A-Za-z0-9_.:=@+/,\\ ]/.test(command)
  ) {
    throw new Error('Invalid tool executable path');
  }
  if (platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(command)) {
    return { command, args: [...args], cwd: root };
  }
  // Launch qualified wrappers from their directory, so spaces in the base path never reach
  // cmd.exe's command text. Like run-gradle.mjs, reject quoting, expansion and metacharacters.
  const directory = win32.dirname(command);
  const qualified = directory !== '.';
  const cwd = qualified ? validatedDirectory(directory, win32) : root;
  const argv = ['/d', '/s', '/c', qualified ? `.\\${win32.basename(command)}` : command, ...args];
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length === 0 || /[^-A-Za-z0-9_.:=@+/,\\]/.test(arg)) {
      throw new Error('Invalid Windows tooling argument');
    }
  }
  const comspec = env.ComSpec || 'cmd.exe';
  if (
    /[^-A-Za-z0-9_.:=@+/,\\ ]/.test(comspec) ||
    win32.basename(comspec).toLowerCase() !== 'cmd.exe'
  ) {
    throw new Error('Invalid ComSpec executable path');
  }
  if (comspec !== 'cmd.exe') validatedDirectory(win32.dirname(comspec), win32);
  return { command: comspec, args: argv, cwd };
}

function findJdk() {
  const gradleHome = validatedDirectory(process.env.GRADLE_USER_HOME || join(homedir(), '.gradle'));
  const homes = [process.env.JAVA_HOME];
  for (const path of [
    join(gradleHome, 'gradle.properties'),
    join(root, 'apps/android/android/gradle.properties'),
    join(root, 'apps/android/android/.gradle/config.properties'),
  ]) {
    if (!existsSync(path)) continue;
    for (const match of read(path).matchAll(
      /^[ \t]*(?:org\.gradle\.java\.(?:home|installations\.paths)|java\.home)[ \t]*[=:][ \t]*(.+)$/gm,
    )) {
      homes.push(
        ...match[1]
          .trim()
          .replace(/\\([\\ :])/g, '$1')
          .split(','),
      );
    }
  }
  const cachedJdks = join(gradleHome, 'jdks');
  if (existsSync(cachedJdks)) {
    for (const entry of readdirSync(cachedJdks, { withFileTypes: true })) {
      if (entry.isDirectory()) homes.push(join(cachedJdks, entry.name));
    }
  }
  const names = ['java', 'keytool', 'jarsigner'];
  for (const candidate of homes) {
    if (!candidate) continue;
    const home = validatedDirectory(candidate.trim());
    const release = join(home, 'release');
    if (!existsSync(release) || !/^JAVA_VERSION="21(?:[.+-][^"]*)?"$/m.test(read(release)))
      continue;
    const tools = Object.fromEntries(
      names.map((name) => [name, join(home, 'bin', `${name}${windows ? '.exe' : ''}`)]),
    );
    if (Object.values(tools).every((path) => existsSync(path))) return { home, ...tools };
  }
  throw new Error(
    'JDK 21 keytool/jarsigner missing: set JAVA_HOME or Gradle org.gradle.java.home/installations.paths to the daemon JDK.',
  );
}

function findBuildTools() {
  for (const candidate of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (!candidate) continue;
    const sdk = validatedDirectory(candidate);
    if (!existsSync(join(sdk, 'build-tools'))) continue;
    const versions = readdirSync(join(sdk, 'build-tools'))
      .filter((name) => /^36\.\d+\.\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    // Use the workflow version when installed; otherwise allow another stable 36.x toolchain.
    if (versions.includes('36.1.0')) versions.unshift('36.1.0');
    for (const version of versions) {
      const dir = join(sdk, 'build-tools', version);
      const zipalign = join(dir, windows ? 'zipalign.exe' : 'zipalign');
      const apksigner = (
        windows ? ['apksigner.exe', 'apksigner.bat', 'apksigner.cmd'] : ['apksigner']
      )
        .map((name) => join(dir, name))
        .find((path) => existsSync(path));
      if (existsSync(zipalign) && apksigner) return { zipalign, apksigner, dir };
    }
  }
  throw new Error(
    'Android build-tools 36.x zipalign/apksigner missing: set ANDROID_HOME or ANDROID_SDK_ROOT (CI uses 36.1.0).',
  );
}

function fingerprint(output) {
  const matches = [...output.matchAll(/^\s*SHA256: ([\dA-Fa-f:]+)\s*$/gm)];
  assert.equal(matches.length, 1, 'keytool must report exactly one certificate');
  return normalizeFingerprint(matches[0][1]);
}

test('dry-run launches native tools directly and Windows wrappers with validated argv', () => {
  const args = ['verify', '--print-certs', 'C:\\release\\app.apk'];
  const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  assert.deepEqual(
    toolCommand('C:\\Program Files\\Java\\bin\\java.exe', ['-version'], env, 'win32'),
    { command: 'C:\\Program Files\\Java\\bin\\java.exe', args: ['-version'], cwd: root },
  );
  for (const extension of ['bat', 'cmd']) {
    assert.deepEqual(toolCommand(`C:\\Android SDK\\apksigner.${extension}`, args, env, 'win32'), {
      command: env.ComSpec,
      args: ['/d', '/s', '/c', `.\\apksigner.${extension}`, ...args],
      cwd: 'C:\\Android SDK',
    });
  }
  assert.deepEqual(toolCommand('npm.cmd', ['run', 'build:android:release'], {}, 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'build:android:release'],
    cwd: root,
  });
  assert.deepEqual(toolCommand('/sdk/apksigner', args, {}, 'linux'), {
    command: '/sdk/apksigner',
    args,
    cwd: root,
  });
});

test('dry-run rejects unsafe base paths, ComSpec and every batch argument before spawning', () => {
  for (const value of [
    '',
    'two words',
    'x&y',
    'x|y',
    'x>y',
    'x<y',
    '%PATH%',
    '!PATH!',
    'x^y',
    '"quoted"',
    "'quoted'",
    '(x)',
    'x;y',
    '$x',
    '`x`',
    'x\n',
    'x\r',
    'x\t',
    'x\u2028',
  ]) {
    assert.throws(
      () => toolCommand('npm.cmd', [value], {}, 'win32'),
      /Invalid Windows tooling argument/,
    );
  }
  for (const directory of ['relative', 'C:\\sdk&whoami', 'C:\\%SDK%', 'C:\\sdk\n']) {
    assert.throws(() => validatedDirectory(directory, win32), /Tool base directory/);
  }
  for (const ComSpec of ['cmd.exe&whoami', '%SHELL%', 'powershell.exe', 'relative\\cmd.exe']) {
    assert.throws(() => toolCommand('npm.cmd', ['run'], { ComSpec }, 'win32'));
  }
});

test(
  'release APK and AAB use distinct ephemeral app/upload keys and verified release metadata',
  { timeout: 45 * 60_000 },
  (t) => {
    const jdk = findJdk();
    const tools = findBuildTools();
    const temp = mkdtempSync(
      // The native realpath expands Windows 8.3 short names (MARQUI~1) to safe long paths.
      join(validatedDirectory(realpathSync.native(tmpdir())), 'open-auri-release-'),
    );
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
    const redact = (text) =>
      String(text || '')
        .replaceAll(appPassword, '[redacted]')
        .replaceAll(uploadPassword, '[redacted]');
    const run = (command, args, childEnv = env) => {
      const launch = toolCommand(command, args, childEnv);
      const result = spawnSync(launch.command, launch.args, {
        cwd: launch.cwd,
        env: childEnv,
        shell: false,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 40 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(
        result.status,
        0,
        redact(
          `${basename(command)} failed: ${result.error?.message || ''}\n${result.stdout}\n${result.stderr}`,
        ),
      );
      return result.stdout.replaceAll('\r\n', '\n');
    };
    const signerJar = join(tools.dir, 'lib', 'apksigner.jar');
    const batchSigner = windows && /\.(?:bat|cmd)$/i.test(tools.apksigner);
    const apksigner = (args) => run(tools.apksigner, args);
    if (batchSigner)
      assert.ok(existsSync(signerJar), 'Windows apksigner wrapper requires lib/apksigner.jar');

    const outputs = join(root, 'apps/android/android/app/build/outputs');
    const unsigned = () => {
      const find = (dir, pattern) =>
        existsSync(dir)
          ? readdirSync(dir)
              .filter((name) => pattern.test(name))
              .map((name) => join(dir, name))
          : [];
      return {
        apk: find(join(outputs, 'apk/release'), /-unsigned\.apk$/),
        aab: find(join(outputs, 'bundle/release'), /\.aab$/),
      };
    };
    let inputs = unsigned();
    if (!inputs.apk.length || !inputs.aab.length) {
      t.diagnostic('Unsigned outputs missing; running npm run build:android:release.');
      if (process.env.npm_execpath) {
        const paths = windows ? win32 : posix;
        const npm = join(
          validatedDirectory(paths.dirname(process.env.npm_execpath)),
          paths.basename(process.env.npm_execpath),
        );
        run(process.execPath, [npm, 'run', 'build:android:release']);
      } else run(windows ? 'npm.cmd' : 'npm', ['run', 'build:android:release']);
      inputs = unsigned();
    }
    assert.equal(inputs.apk.length, 1, 'Expected exactly one unsigned release APK');
    assert.equal(inputs.aab.length, 1, 'Expected exactly one unsigned release AAB');

    const keys = {};
    for (const role of ['APP', 'UPLOAD']) {
      const alias = `android-ci-${role.toLowerCase()}`;
      const keystore = join(temp, `android-${role.toLowerCase()}.p12`);
      run(jdk.keytool, [
        '-genkeypair',
        '-keystore',
        keystore,
        '-storetype',
        'PKCS12',
        '-storepass:env',
        `ANDROID_${role}_KEYSTORE_PASSWORD`,
        '-keypass:env',
        `ANDROID_${role}_KEY_PASSWORD`,
        '-alias',
        alias,
        '-keyalg',
        'RSA',
        '-keysize',
        '2048',
        '-validity',
        '2',
        '-dname',
        `CN=Android CI ${role}, O=Open Auri, C=BR`,
        '-noprompt',
      ]);
      keys[role] = {
        alias,
        keystore,
        fingerprint: fingerprint(
          run(jdk.keytool, [
            '-J-Duser.language=en',
            '-list',
            '-v',
            '-keystore',
            keystore,
            '-storepass:env',
            `ANDROID_${role}_KEYSTORE_PASSWORD`,
            '-alias',
            alias,
          ]),
        ),
      };
    }
    assert.notEqual(keys.APP.fingerprint, keys.UPLOAD.fingerprint);
    env.ANDROID_APP_CERT_SHA256 = keys.APP.fingerprint;
    env.ANDROID_UPLOAD_CERT_SHA256 = keys.UPLOAD.fingerprint;

    const pkg = JSON.parse(read(join(root, 'apps/android/package.json')));
    const out = join(temp, 'release');
    mkdirSync(out);
    const apk = join(out, `open-auri-${pkg.version}.apk`);
    const aab = join(out, `open-auri-${pkg.version}.aab`);
    const aligned = join(temp, 'aligned.apk');
    // Mirror .github/workflows/android-release.yml: zipalign, v2/v3 APK, upload-signed AAB.
    run(tools.zipalign, ['-p', '-f', '4', inputs.apk[0], aligned]);
    apksigner([
      'sign',
      '--ks',
      keys.APP.keystore,
      '--ks-key-alias',
      keys.APP.alias,
      '--ks-pass',
      'env:ANDROID_APP_KEYSTORE_PASSWORD',
      '--key-pass',
      'env:ANDROID_APP_KEY_PASSWORD',
      '--v1-signing-enabled',
      'false',
      '--v2-signing-enabled',
      'true',
      '--v3-signing-enabled',
      'true',
      '--out',
      apk,
      aligned,
    ]);
    const verification = apksigner(['verify', '--verbose', '--print-certs', apk]);
    assert.match(verification, /^Verified using v1 scheme \(JAR signing\): false$/m);
    assert.match(verification, /^Verified using v2 scheme \(APK Signature Scheme v2\): true$/m);
    assert.match(verification, /^Verified using v3 scheme \(APK Signature Scheme v3\): true$/m);
    assert.equal(parseApkCertificate(verification), keys.APP.fingerprint);
    run(tools.zipalign, ['-c', '-p', '4', apk]);
    run(jdk.jarsigner, [
      '-keystore',
      keys.UPLOAD.keystore,
      '-storepass:env',
      'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
      '-keypass:env',
      'ANDROID_UPLOAD_KEY_PASSWORD',
      '-sigalg',
      'SHA256withRSA',
      '-digestalg',
      'SHA-256',
      '-signedjar',
      aab,
      inputs.aab[0],
      keys.UPLOAD.alias,
    ]);
    assert.match(run(jdk.jarsigner, ['-J-Duser.language=en', '-verify', aab]), /^jar verified\.$/m);
    const aabCert = fingerprint(
      run(jdk.keytool, ['-J-Duser.language=en', '-printcert', '-jarfile', aab]),
    );
    assert.equal(aabCert, keys.UPLOAD.fingerprint);
    assert.notEqual(aabCert, keys.APP.fingerprint);
    verifyUploadCertificate(aabCert, env.ANDROID_UPLOAD_CERT_SHA256, env.ANDROID_APP_CERT_SHA256);
    assert.throws(
      () => verifyUploadCertificate(aabCert, keys.APP.fingerprint, keys.APP.fingerprint),
      /expected upload certificate/,
    );

    const nodeArgs = [];
    if (batchSigner) {
      // The CLI uses execFileSync (which cannot launch .bat on Node 24). Adapt only its launch
      // transport on Windows, still executing the real SDK verifier with all original arguments.
      const preload = join(temp, 'apksigner-windows.mjs');
      writeFileSync(
        preload,
        `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => command === process.env.APKSIGNER
  ? original(process.env.ANDROID_DRYRUN_JAVA, ['-jar', process.env.ANDROID_DRYRUN_SIGNER_JAR, ...args], options)
  : original(command, args, options);
syncBuiltinESMExports();
`,
      );
      env.ANDROID_DRYRUN_JAVA = jdk.java;
      env.ANDROID_DRYRUN_SIGNER_JAR = signerJar;
      nodeArgs.push('--import', pathToFileURL(preload).href);
    }
    const commit = run('git', ['rev-parse', 'HEAD']).trim();
    run(process.execPath, [
      ...nodeArgs,
      'tools/android-artifacts.mjs',
      '--apk',
      apk,
      '--aab',
      aab,
      '--expected-app-cert-sha256',
      keys.APP.fingerprint,
      '--commit',
      commit,
      '--repo-url',
      'https://github.com/marco-jardim/open-auri',
      '--version',
      pkg.version,
      '--version-code',
      String(deriveVersionCode(pkg.version)),
      '--out-dir',
      out,
    ]);
    const hashes = [apk, aab].map((path) => [basename(path), sha256(readFileSync(path))]);
    const sums = hashes
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, hash]) => `${hash}  ${name}\n`)
      .join('');
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
    t.diagnostic(
      'Verified APK v2/v3 app certificate, distinct AAB upload certificate, checksums, manifest and G.5 notes.',
    );
  },
);
