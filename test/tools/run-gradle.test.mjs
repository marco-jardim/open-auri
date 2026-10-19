import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  capSyncCommand,
  gradleCommand,
  main,
  parseArgs,
  validateArg,
} from '../../tools/run-gradle.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'tools', 'run-gradle.mjs');

function runner(outcomes = [0, 0], overrides = {}) {
  const calls = [];
  const errors = [];
  const dependencies = {
    platform: 'linux',
    env: { KEEP: 'fixture', OA_ANDROID_TARGET: 'previous' },
    existsSync: () => true,
    error: (message) => errors.push(message),
    spawn: (command, args, options) => {
      const outcome = outcomes[calls.length] ?? 0;
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => {
        if (outcome instanceof Error) child.emit('error', outcome);
        else if (typeof outcome === 'string') child.emit('close', null, outcome);
        else child.emit('close', outcome, null);
      });
      return child;
    },
    ...overrides,
  };
  return { calls, errors, dependencies, run: (args = []) => main(args, dependencies) };
}

test('parses wrapper options and leaves Gradle tasks and flags in their original order', () => {
  assert.deepEqual(parseArgs([]), { target: 'prod', noSync: false, syncOnly: false, args: [] });
  const tasks = ['verifyCapacitorConfig', 'bundleRelease', '-Pfixture=a,b', '--stacktrace'];
  assert.deepEqual(parseArgs(['--target', 'staging', '--no-sync', ...tasks]), {
    target: 'staging',
    noSync: true,
    syncOnly: false,
    args: tasks,
  });
  assert.equal(parseArgs(['--target', 'e2e', '--sync-only']).syncOnly, true);
  assert.equal(parseArgs(['--target', 'prod']).target, 'prod');
  for (const args of [
    ['--target'],
    ['--target', 'dev'],
    ['--target', '--no-sync'],
    ['--no-sync', '--sync-only'],
  ]) {
    assert.throws(() => parseArgs(args), /--target|Cannot combine/);
  }
});

test('selects the correct Gradle and Capacitor executable on Windows, Linux and macOS', () => {
  const args = [
    ':app:testDebugUnitTest',
    '--info',
    '-Pfixture=a,b',
    '-Durl=https://fixture.invalid',
  ];
  for (const platform of ['linux', 'darwin']) {
    const command = gradleCommand(platform, args, { ComSpec: 'custom-cmd.exe' });
    assert.deepEqual(command, { command: './gradlew', args });
    assert.notEqual(command.args, args, 'the caller array is not reused');
    assert.deepEqual(capSyncCommand(platform, {}), {
      command: 'npx',
      args: ['cap', 'sync', 'android'],
    });
  }
  for (const env of [{}, { ComSpec: 'custom-cmd.exe' }]) {
    assert.deepEqual(gradleCommand('win32', args, env), {
      command: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'gradlew.bat', ...args],
    });
    assert.deepEqual(capSyncCommand('win32', env), {
      command: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npx.cmd', 'cap', 'sync', 'android'],
    });
  }
});

test('rejects empty arguments, whitespace and every cmd.exe metacharacter before starting sync', async () => {
  for (const arg of ['assembleDebug', ':app:test', '-Pvalue=a,b', './file_1.2@a+b/c']) {
    assert.equal(validateArg(arg), true, arg);
  }
  for (const arg of [
    '',
    'two words',
    'x\ny',
    'x\ty',
    'x\n',
    'x\r',
    'x\r\n',
    'x\u2028',
    'x&y',
    'x|y',
    'x;y',
    'x>y',
    'x<y',
    '%PATH%',
    '!name!',
    'x^y',
    '"quoted"',
    "'quoted'",
    '(task)',
    '$value',
    '`task`',
    'a\\b',
    'olá',
  ]) {
    assert.equal(validateArg(arg), false, JSON.stringify(arg));
    assert.throws(() => parseArgs([arg]), /Invalid Gradle argument/);
    assert.throws(() => gradleCommand('win32', [arg], {}), /Invalid Gradle argument/);
    const fake = runner();
    assert.equal(await fake.run([arg]), 2);
    assert.equal(fake.calls.length, 0);
    assert.match(fake.errors.join('\n'), /Invalid Gradle argument/);
  }
});

test('sync runs first in the Capacitor workspace with the selected target and inherited environment', async () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const fake = runner([0, 0], { platform });
    const args = ['assembleDebug', '--stacktrace', '-Pfixture=a,b'];
    assert.equal(await fake.run(['--target', 'e2e', ...args]), 0);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(fake.calls[0], {
      ...capSyncCommand(platform, fake.dependencies.env),
      options: {
        cwd: join(root, 'apps', 'android'),
        env: { KEEP: 'fixture', OA_ANDROID_TARGET: 'e2e' },
        stdio: 'inherit',
      },
    });
    assert.deepEqual(fake.calls[1], {
      ...gradleCommand(platform, args, fake.dependencies.env),
      options: {
        cwd: join(root, 'apps', 'android', 'android'),
        env: { KEEP: 'fixture', OA_ANDROID_TARGET: 'e2e' },
        stdio: 'inherit',
      },
    });
    assert.equal(fake.dependencies.env.OA_ANDROID_TARGET, 'previous');
  }
});

test('--no-sync runs only Gradle, and --sync-only does not even check for a wrapper', async () => {
  const noSync = runner();
  assert.equal(await noSync.run(['--no-sync', 'lintDebug']), 0);
  assert.deepEqual(
    noSync.calls.map(({ command, args }) => ({ command, args })),
    [{ command: './gradlew', args: ['lintDebug'] }],
  );
  const syncOnly = runner([0], {
    existsSync: () => assert.fail('sync-only must not need the Gradle wrapper'),
  });
  assert.equal(await syncOnly.run(['--sync-only']), 0);
  assert.equal(syncOnly.calls.length, 1);
  assert.equal(syncOnly.calls[0].command, 'npx');
  assert.equal(syncOnly.calls[0].options.env.OA_ANDROID_TARGET, 'prod');
});

test('propagates sync failure without starting Gradle, Gradle exit codes, and signals as 1', async () => {
  for (const code of [1, 7, 42]) {
    const sync = runner([code]);
    assert.equal(await sync.run(['assembleDebug']), code);
    assert.equal(sync.calls.length, 1);
    const gradle = runner([0, code]);
    assert.equal(await gradle.run(['assembleDebug']), code);
    assert.equal(gradle.calls.length, 2);
    const syncOnly = runner([code]);
    assert.equal(await syncOnly.run(['--sync-only']), code);
  }
  assert.equal(await runner(['SIGTERM']).run(), 1);
  assert.equal(await runner([0, 'SIGINT']).run(), 1);
});

test('propagates a real child exit code through the injected spawn', async () => {
  const fake = runner([], {
    // Native Android output is ignored and need not exist in a fresh checkout.
    spawn: (_command, _args, options) =>
      spawn(process.execPath, ['-e', 'process.exit(23)'], { ...options, cwd: root }),
  });
  assert.equal(await fake.run(['--no-sync', 'assembleDebug']), 23);
});

test('reports spawn errors and synchronous spawn failures with exit code 1', async () => {
  const emitted = runner([new Error('fixture spawn failure')]);
  assert.equal(await emitted.run(), 1);
  assert.match(emitted.errors.join('\n'), /Could not start Android tooling: fixture spawn failure/);
  const thrown = runner([], {
    spawn: () => {
      throw new Error('fixture EINVAL');
    },
  });
  assert.equal(await thrown.run(['--no-sync']), 1);
  assert.match(thrown.errors.join('\n'), /fixture EINVAL/);
});

test('a missing wrapper reports its full path and the Capacitor setup command', async () => {
  for (const platform of ['win32', 'linux']) {
    const checked = [];
    const fake = runner([], {
      platform,
      existsSync: (path) => {
        checked.push(path);
        return false;
      },
    });
    assert.equal(await fake.run(['--no-sync', 'assembleDebug']), 1);
    const wrapper = join(
      root,
      'apps',
      'android',
      'android',
      platform === 'win32' ? 'gradlew.bat' : 'gradlew',
    );
    assert.deepEqual(checked, [wrapper]);
    assert.deepEqual(fake.errors, [
      `Gradle wrapper not found at ${wrapper}. Run "npx cap add android" in apps/android first.`,
    ]);
    assert.equal(fake.calls.length, 0);
  }
});

test('the CLI exits 2 with a clear message for unknown targets or unsafe arguments', () => {
  for (const [args, message] of [
    [['--target', 'unknown'], /Invalid --target/],
    [['--target'], /Invalid --target/],
    [['--no-sync', 'task&another'], /Invalid Gradle argument/],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, message);
  }
});
