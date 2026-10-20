import * as nativeFs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ existsSync: (path: string) => boolean,
 *   readFileSync: (path: string, encoding: 'utf8') => string,
 *   readdirSync: (path: string) => string[] }} DoctorFs
 * @typedef {{ env: NodeJS.ProcessEnv, fs: DoctorFs, homedir: string,
 *   nodeVersion: string }} DoctorOptions
 * @typedef {{ id: string, ok: boolean, required: boolean, message: string }} DoctorItem
 */

/**
 * Only SDK directories, JDK release files and the two Java path properties are inspected.
 * No subprocesses, environment files or signing credentials are needed.
 * @param {DoctorOptions} options
 * @returns {{ ok: boolean, items: DoctorItem[] }}
 */
export function checkAll({ env, fs, homedir: home, nodeVersion }) {
  /** @param {string} path */
  const directoryEntries = (path) => {
    try {
      return fs.existsSync(path) ? fs.readdirSync(path) : undefined;
    } catch {
      // Missing or unreadable directories are reported as unavailable, not fatal exceptions.
      return undefined;
    }
  };
  /** @param {string} path */
  const isDirectory = (path) => directoryEntries(path) !== undefined;
  /** @param {string} path */
  const isJdk21 = (path) => {
    const release = join(path, 'release');
    try {
      return (
        fs.existsSync(release) &&
        /^[ \t]*JAVA_VERSION="21(?:[.+-][^"\r\n]*)?"[ \t\r]*$/m.test(
          fs.readFileSync(release, 'utf8'),
        )
      );
    } catch {
      // An unreadable release file cannot establish the required JDK version.
      return false;
    }
  };
  let jdk21 = Boolean(env.JAVA_HOME && isJdk21(env.JAVA_HOME));
  if (!jdk21) {
    const properties = join(env.GRADLE_USER_HOME || join(home, '.gradle'), 'gradle.properties');
    let text = '';
    try {
      if (fs.existsSync(properties)) text = fs.readFileSync(properties, 'utf8');
    } catch {
      // An unavailable Gradle user configuration leaves the JDK check unsatisfied.
      text = '';
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(
        /^[ \t]*(org\.gradle\.java\.(?:installations\.paths|home))(?:[ \t]*[=:][ \t]*|[ \t]+)(.*)$/,
      );
      if (!match) continue;
      // Java properties escape Windows backslashes, colons and spaces. Ignore every other key.
      const value = match[2].trim().replace(/\\([\\ :])/g, '$1');
      const paths = match[1].endsWith('.paths') ? value.split(',') : [value];
      if (paths.some((path) => path.trim() && isJdk21(path.trim()))) {
        jdk21 = true;
        break;
      }
    }
  }

  const sdk = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].find((path) => path && isDirectory(path));
  const buildTools = sdk ? join(sdk, 'build-tools') : undefined;
  const hasBuildTools = Boolean(
    buildTools &&
    directoryEntries(buildTools)?.some(
      (name) => /^36\./.test(name) && isDirectory(join(buildTools, name)),
    ),
  );
  const version = nodeVersion.match(/^v?(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/);
  const nodeOk = Boolean(
    version && (Number(version[1]) > 22 || (Number(version[1]) === 22 && Number(version[2]) >= 12)),
  );
  /** @type {DoctorItem[]} */
  const items = [
    {
      id: 'jdk21',
      ok: jdk21,
      required: true,
      message: jdk21
        ? 'JDK 21 available via JAVA_HOME or Gradle user properties.'
        : 'JDK 21 missing: set JAVA_HOME, org.gradle.java.installations.paths or org.gradle.java.home.',
    },
    {
      id: 'android-sdk',
      ok: Boolean(sdk),
      required: true,
      message: sdk
        ? 'Android SDK directory available.'
        : 'Android SDK missing: set ANDROID_HOME or ANDROID_SDK_ROOT to an existing SDK directory.',
    },
    {
      id: 'android-platform-36',
      ok: Boolean(sdk && isDirectory(join(sdk, 'platforms', 'android-36'))),
      required: true,
      message: 'Android SDK platform: platforms/android-36.',
    },
    {
      id: 'android-build-tools-36',
      ok: hasBuildTools,
      required: true,
      message: 'Android SDK build tools: a build-tools/36.* directory.',
    },
    {
      id: 'android-platform-tools',
      ok: Boolean(sdk && isDirectory(join(sdk, 'platform-tools'))),
      required: true,
      message: 'Android SDK platform tools: platform-tools.',
    },
    {
      id: 'android-emulator',
      ok: Boolean(sdk && isDirectory(join(sdk, 'emulator'))),
      required: false,
      message: 'Optional Android emulator: emulator directory.',
    },
    {
      id: 'android-system-image',
      ok: Boolean(
        sdk && isDirectory(join(sdk, 'system-images', 'android-36', 'google_apis', 'x86_64')),
      ),
      required: false,
      message: 'Optional emulator image: system-images/android-36/google_apis/x86_64.',
    },
    {
      id: 'node',
      ok: nodeOk,
      required: true,
      message: `Node >= 22.12 required (current: ${nodeVersion}).`,
    },
  ];
  return { ok: items.every((item) => !item.required || item.ok), items };
}

/**
 * @param {DoctorOptions} options
 * @param {(message: string) => void} log
 */
export function main(
  options = {
    env: process.env,
    fs: nativeFs,
    homedir: homedir(),
    nodeVersion: process.versions.node,
  },
  log = console.log,
) {
  const report = checkAll(options);
  log('Android tooling doctor');
  for (const item of report.items) {
    const status = item.ok ? 'OK' : item.required ? 'FAIL' : 'WARN';
    log(`[${status}] ${item.message}`);
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
