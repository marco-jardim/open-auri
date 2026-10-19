import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const USAGE =
  'Usage: node tools/run-gradle.mjs [--target prod|staging|e2e] ' +
  '[--no-sync] [--sync-only] <gradle tasks/args...>';

/** @param {string} arg */
export function validateArg(arg) {
  return arg.length > 0 && !/[^-A-Za-z0-9_.:=@+/,]/.test(arg);
}

/**
 * @param {string[]} argv
 * @returns {{ target: 'prod' | 'staging' | 'e2e', noSync: boolean, syncOnly: boolean,
 *   args: string[] }}
 */
export function parseArgs(argv) {
  /** @type {'prod' | 'staging' | 'e2e'} */
  let target = 'prod';
  let noSync = false;
  let syncOnly = false;
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
    } else {
      if (!validateArg(arg)) {
        throw new Error('Invalid Gradle argument: use only [A-Za-z0-9_.:=@+/,-].');
      }
      args.push(arg);
    }
  }
  if (noSync && syncOnly) throw new Error(`Cannot combine --no-sync and --sync-only. ${USAGE}`);
  return { target, noSync, syncOnly, args };
}

/**
 * Batch files need cmd.exe on Windows with Node 24. The wrapper is called as .\gradlew.bat, a\n * qualified path, because cmd.exe skips the current directory when NoDefaultCurrentDirectoryInExePath\n * is set (sandboxed runners set it). Keep each argument separate, and allow
 * only characters that cannot introduce cmd.exe quoting, expansion or extra commands.
 * @param {string} platform
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
export function gradleCommand(platform, args, env) {
  if (args.some((arg) => !validateArg(arg))) {
    throw new Error('Invalid Gradle argument: use only [A-Za-z0-9_.:=@+/,-].');
  }
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
 * @param {{ command: string, args: string[] }} invocation
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawn} spawnChild
 * @param {(message: string) => void} error
 * @returns {Promise<number>}
 */
function runChild({ command, args }, cwd, env, spawnChild, error) {
  return new Promise((resolve) => {
    /** @param {unknown} cause */
    const failed = (cause) => {
      error(`Could not start Android tooling: ${cause instanceof Error ? cause.message : cause}`);
      resolve(1);
    };
    try {
      const child = spawnChild(command, args, { cwd, env, stdio: 'inherit' });
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
      capSyncCommand(platform, env),
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
  return runChild(gradleCommand(platform, parsed.args, env), gradle, childEnv, spawnChild, error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
