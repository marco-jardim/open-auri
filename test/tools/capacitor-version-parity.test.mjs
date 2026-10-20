import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/** @param {string} path relative to the repository root */
function manifest(path) {
  return JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
}

const SEMVER_EXACT = /^\d+\.\d+\.\d+$/;

test('every @capacitor package of the site and the app is pinned to the same exact version', () => {
  const web = manifest('web/package.json');
  const app = manifest('apps/android/package.json');
  const versions = {
    'web @capacitor/core': web.dependencies?.['@capacitor/core'],
    'app @capacitor/core': app.dependencies?.['@capacitor/core'],
    'app @capacitor/android': app.dependencies?.['@capacitor/android'],
    'app @capacitor/cli': app.devDependencies?.['@capacitor/cli'],
  };
  for (const [name, version] of Object.entries(versions)) {
    assert.match(String(version), SEMVER_EXACT, `${name} must be an exact version, got ${version}`);
  }
  assert.equal(new Set(Object.values(versions)).size, 1, JSON.stringify(versions));
});

test('the lockfile resolves @capacitor/core to that same version', () => {
  const lock = manifest('package-lock.json');
  const pinned = manifest('apps/android/package.json').dependencies['@capacitor/core'];
  const resolved = Object.entries(lock.packages)
    .filter(([path]) => path.endsWith('node_modules/@capacitor/core'))
    .map(([, entry]) => entry.version);
  assert.ok(resolved.length > 0, 'package-lock.json has no @capacitor/core');
  for (const version of resolved) assert.equal(version, pinned);
});
