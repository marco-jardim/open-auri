import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PRODUCTION_ORIGIN, releaseViolations } from '../../tools/verify-capacitor-config.mjs';

const script = fileURLToPath(new URL('../../tools/verify-capacitor-config.mjs', import.meta.url));

/** @returns {Record<string, any>} */
function prodConfig() {
  return {
    appId: 'com.openauri.app',
    appName: 'open-auri',
    webDir: 'www',
    server: {
      url: PRODUCTION_ORIGIN,
      cleartext: false,
      errorPath: 'offline.html',
      allowNavigation: [],
    },
    android: {
      appendUserAgent: 'OpenAuriAndroid/1.0.0',
      minWebViewVersion: 111,
      webContentsDebuggingEnabled: false,
      allowMixedContent: false,
    },
  };
}

test('accepts the production config', () => {
  assert.deepEqual(releaseViolations(prodConfig()), []);
});

test('release rejects every truthy legacy bridge override at either scope', () => {
  for (const value of [true, 'true', 'false', 1, {}, []]) {
    for (const scope of ['android', 'top-level']) {
      const config = prodConfig();
      (scope === 'android' ? config.android : config).useLegacyBridge = value;
      assert.match(releaseViolations(config).join('; '), /useLegacyBridge/);
    }
  }
});

test('release allows only absent or none Android logging and disables native HTTP', () => {
  for (const logging of ['debug', 'production', '', true, null]) {
    const config = prodConfig();
    config.android.loggingBehavior = logging;
    assert.match(releaseViolations(config).join('; '), /loggingBehavior/);
  }
  const config = prodConfig();
  config.plugins = { CapacitorHttp: { enabled: true } };
  assert.match(releaseViolations(config).join('; '), /CapacitorHttp/);
  config.plugins.CapacitorHttp.enabled = false;
  config.android.loggingBehavior = 'none';
  config.android.useLegacyBridge = false;
  config.useLegacyBridge = false;
  assert.deepEqual(releaseViolations(config), []);
});

test('rejects a non-object config', () => {
  for (const value of [null, [], 'x', 42]) {
    assert.deepEqual(releaseViolations(value), ['capacitor.config.json is not a JSON object']);
  }
});

const cases = [
  ['staging server.url', (c) => (c.server.url = 'https://staging.open-auri.com'), /server\.url/],
  ['e2e server.url', (c) => (c.server.url = 'http://10.0.2.2:4173'), /server\.url/],
  ['trailing slash', (c) => (c.server.url = 'https://open-auri.com/'), /server\.url/],
  ['missing server.url', (c) => delete c.server.url, /server\.url/],
  ['missing server block', (c) => delete c.server, /server block is missing/],
  ['cleartext on', (c) => (c.server.cleartext = true), /cleartext/],
  [
    'allowNavigation not empty',
    (c) => (c.server.allowNavigation = ['*.open-auri.com']),
    /allowNavigation/,
  ],
  ['allowNavigation not an array', (c) => (c.server.allowNavigation = 'x'), /allowNavigation/],
  ['hostname override', (c) => (c.server.hostname = 'evil.example'), /hostname/],
  [
    'debugging on',
    (c) => (c.android.webContentsDebuggingEnabled = true),
    /webContentsDebuggingEnabled/,
  ],
  [
    'top-level debugging on',
    (c) => (c.webContentsDebuggingEnabled = true),
    /webContentsDebuggingEnabled/,
  ],
  ['mixed content on', (c) => (c.android.allowMixedContent = true), /allowMixedContent/],
  ['wrong appId', (c) => (c.appId = 'com.example.app'), /appId/],
];

for (const [name, mutate, pattern] of cases) {
  test(`rejects ${name}`, () => {
    const config = prodConfig();
    mutate(config);
    const violations = releaseViolations(config);
    assert.equal(violations.length, 1, violations.join('; '));
    assert.match(violations[0], pattern);
  });
}

test('CLI exits 0 for production, 1 for a violation, 1 for unreadable file, 2 without args', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oa-capcfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = join(dir, 'good.json');
  const bad = join(dir, 'bad.json');
  writeFileSync(good, JSON.stringify(prodConfig()));
  const staging = prodConfig();
  staging.server.url = 'https://staging.open-auri.com';
  writeFileSync(bad, JSON.stringify(staging));

  const ok = spawnSync(process.execPath, [script, good], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /OK/);

  const rejected = spawnSync(process.execPath, [script, bad], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /server\.url must be "https:\/\/open-auri\.com"/);

  const missing = spawnSync(process.execPath, [script, join(dir, 'nope.json')], {
    encoding: 'utf8',
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read/);

  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});
