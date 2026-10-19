import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const USAGE =
  'Usage: node tools/run-gradle.mjs [--target prod|staging|e2e] ' +
  '[--no-sync] [--sync-only] [--maintainer-metadata] <gradle tasks/args...>';

// Only observational flags and execution/cache controls are forwarded. In particular,
// properties, init/settings scripts, project relocation and task exclusions are not.
const GRADLE_OPTIONS = new Set([
  '--stacktrace',
  '--full-stacktrace',
  '--info',
  '--debug',
  '--warn',
  '--quiet',
  '--no-daemon',
  '--daemon',
  '--parallel',
  '--no-parallel',
  '--offline',
  '--no-build-cache',
  '--no-configuration-cache',
  '--rerun-tasks',
]);

/** @param {string} arg */
export function validateArg(arg) {
  // This one fixed Windows wrapper path is trusted, not an arbitrary backslash path.
  return arg === '.\\gradlew.bat' || (arg.length > 0 && !/[^-A-Za-z0-9_.:=@+/,]/.test(arg));
}

/** @param {string[]} args @param {boolean} [maintainerMetadata] */
export function validateGradleArgs(args, maintainerMetadata = false) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!validateArg(arg)) {
      throw new Error('Invalid Gradle argument: use only [A-Za-z0-9_.:=@+/,-].');
    }
    if (arg === '--write-verification-metadata' && maintainerMetadata) {
      if (args[++index] !== 'sha256') {
        throw new Error('Maintainer metadata requires --write-verification-metadata sha256.');
      }
    } else if (
      !(
        /^:?[A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z][A-Za-z0-9_-]*)*$/.test(arg) ||
        GRADLE_OPTIONS.has(arg) ||
        /^--console=(plain|auto|rich)$/.test(arg) ||
        /^--max-workers=[1-9][0-9]*$/.test(arg)
      )
    ) {
      throw new Error(`Unsupported Gradle argument: ${arg}. ${USAGE}`);
    }
  }
}

/**
 * @param {string[]} argv
 * @returns {{ target: 'prod' | 'staging' | 'e2e', noSync: boolean, syncOnly: boolean,
 *   maintainerMetadata: boolean, args: string[] }}
 */
export function parseArgs(argv) {
  /** @type {'prod' | 'staging' | 'e2e'} */
  let target = 'prod';
  let noSync = false;
  let syncOnly = false;
  let maintainerMetadata = false;
  const args = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      const value = argv[++index];
      if (value !== 'prod' && value !== 'staging' && value !== 'e2e') {
        throw new Error(`Invalid --target: expected prod, staging or e2e. ${USAGE}`);
      }
      target = value;
    } else if (arg === '--no-sync') {
      noSync = true;
    } else if (arg === '--sync-only') {
      syncOnly = true;
    } else if (arg === '--maintainer-metadata') {
      maintainerMetadata = true;
    } else {
      if (!validateArg(arg)) {
        throw new Error('Invalid Gradle argument: use only [A-Za-z0-9_.:=@+/,-].');
      }
      args.push(arg);
    }
  }
  if (noSync && syncOnly) throw new Error(`Cannot combine --no-sync and --sync-only. ${USAGE}`);
  validateGradleArgs(args, maintainerMetadata);
  return { target, noSync, syncOnly, maintainerMetadata, args };
}

/**
 * Batch files need cmd.exe on Windows with Node 24. The wrapper is called as .\gradlew.bat, a
 * qualified path, because cmd.exe skips the current directory when NoDefaultCurrentDirectoryInExePath
 * is set (sandboxed runners set it). Keep each argument separate, and allow
 * only characters that cannot introduce cmd.exe quoting, expansion or extra commands.
 * @param {string} platform
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} [maintainerMetadata]
 */
export function gradleCommand(platform, args, env, maintainerMetadata = false) {
  validateGradleArgs(args, maintainerMetadata);
  return platform === 'win32'
    ? { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '.\\gradlew.bat', ...args] }
    : { command: './gradlew', args: [...args] };
}

/**
 * @param {string} platform
 * @param {NodeJS.ProcessEnv} env
 */
export function capSyncCommand(platform, env) {
  return platform === 'win32'
    ? {
        command: env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'npx.cmd', 'cap', 'sync', 'android'],
      }
    : { command: 'npx', args: ['cap', 'sync', 'android'] };
}

/**
 * @param {string} platform
 * @param {'sync' | 'gradle'} kind
 * @param {string[]} gradleArgs
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawn} spawnChild
 * @param {(message: string) => void} error
 * @param {boolean} [maintainerMetadata]
 * @returns {Promise<number>}
 */
export function runChild(
  platform,
  kind,
  gradleArgs,
  cwd,
  env,
  spawnChild,
  error,
  maintainerMetadata = false,
) {
  return new Promise((resolve) => {
    /** @param {unknown} cause */
    const failed = (cause) => {
      error(`Could not start Android tooling: ${cause instanceof Error ? cause.message : cause}`);
      resolve(1);
    };
    try {
      // Validate the option policy here, at the spawn boundary, even for direct callers.
      validateGradleArgs(gradleArgs, maintainerMetadata);
      const { command, args } =
        kind === 'gradle'
          ? gradleCommand(platform, gradleArgs, env, maintainerMetadata)
          : capSyncCommand(platform, env);
      const safeArgs = [];
      for (const arg of args) {
        // Keep the character allow-list local to the sink for command-injection analysis.
        if (!validateArg(arg) || (arg !== '.\\gradlew.bat' && /[^-A-Za-z0-9_.:=@+/,]/.test(arg))) {
          throw new Error('Invalid Android tooling argument.');
        }
        safeArgs.push(arg);
      }
      const child = spawnChild(command, safeArgs, { cwd, env, stdio: 'inherit', shell: false });
      child.once('error', failed);
      child.once('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    } catch (cause) {
      failed(cause);
    }
  });
}

/**
 * @param {string[]} argv
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, existsSync?: typeof existsSync,
 *   spawn?: typeof spawn, error?: (message: string) => void }} dependencies
 * @returns {Promise<number>}
 */
export async function main(
  argv = process.argv.slice(2),
  {
    platform = process.platform,
    env = process.env,
    existsSync: wrapperExists = existsSync,
    spawn: spawnChild = spawn,
    error = console.error,
  } = {},
) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    return 2;
  }
  const android = join(ROOT, 'apps', 'android');
  const childEnv = { ...env, OA_ANDROID_TARGET: parsed.target };
  if (!parsed.noSync) {
    const code = await runChild(
      platform,
      'sync',
      [],
      android,
      childEnv,
      spawnChild,
      error,
    );
    if (code !== 0) return code;
  }
  if (parsed.syncOnly) return 0;

  const gradle = join(android, 'android');
  const wrapper = join(gradle, platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!wrapperExists(wrapper)) {
    error(
      `Gradle wrapper not found at ${wrapper}. Run "npx cap add android" in apps/android first.`,
    );
    return 1;
  }
  return runChild(
    platform,
    'gradle',
    parsed.args,
    gradle,
    childEnv,
    spawnChild,
    error,
    parsed.maintainerMetadata,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
