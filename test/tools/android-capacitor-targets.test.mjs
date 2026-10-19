import assert from 'node:assert/strict';
import test from 'node:test';

import {
  E2E_ORIGIN,
  MIN_WEBVIEW_VERSION,
  PRODUCTION_ORIGIN,
  buildConfig,
  parseTarget,
} from '../../apps/android/capacitor.targets.mjs';
import { releaseViolations } from '../../tools/verify-capacitor-config.mjs';

test('prod is the default target and passes the release guard', () => {
  for (const env of [{}, { OA_ANDROID_TARGET: '' }, { OA_ANDROID_TARGET: 'prod' }]) {
    const config = buildConfig(env, '1.0.0');
    assert.equal(config.appId, 'com.openauri.app');
    assert.equal(config.appName, 'open-auri');
    assert.equal(config.webDir, 'www');
    assert.deepEqual(config.server, {
      url: PRODUCTION_ORIGIN,
      cleartext: false,
      errorPath: 'offline.html',
      allowNavigation: [],
    });
    assert.deepEqual(config.android, {
      appendUserAgent: 'OpenAuriAndroid/1.0.0',
      minWebViewVersion: MIN_WEBVIEW_VERSION,
      webContentsDebuggingEnabled: false,
      allowMixedContent: false,
    });
    assert.deepEqual(releaseViolations(config), []);
  }
});

test('staging requires a bare https STAGING_ORIGIN and enables debugging', () => {
  const config = buildConfig(
    { OA_ANDROID_TARGET: 'staging', STAGING_ORIGIN: 'https://staging.open-auri.com' },
    '1.2.3',
  );
  assert.equal(config.server.url, 'https://staging.open-auri.com');
  assert.equal(config.server.cleartext, false);
  assert.equal(config.android.webContentsDebuggingEnabled, true);
  assert.notDeepEqual(releaseViolations(config), []);

  assert.throws(
    () => buildConfig({ OA_ANDROID_TARGET: 'staging' }, '1.0.0'),
    /STAGING_ORIGIN is required/,
  );
  assert.throws(
    () =>
      buildConfig(
        { OA_ANDROID_TARGET: 'staging', STAGING_ORIGIN: 'http://staging.open-auri.com' },
        '1.0.0',
      ),
    /must use https/,
  );
  assert.throws(
    () =>
      buildConfig(
        { OA_ANDROID_TARGET: 'staging', STAGING_ORIGIN: 'https://staging.open-auri.com/' },
        '1.0.0',
      ),
    /bare origin/,
  );
  assert.throws(
    () =>
      buildConfig(
        { OA_ANDROID_TARGET: 'staging', STAGING_ORIGIN: 'https://staging.open-auri.com/app' },
        '1.0.0',
      ),
    /bare origin/,
  );
  assert.throws(
    () => buildConfig({ OA_ANDROID_TARGET: 'staging', STAGING_ORIGIN: 'not a url' }, '1.0.0'),
    /not a valid URL/,
  );
});

test('e2e uses the emulator host with cleartext only there', () => {
  const config = buildConfig({ OA_ANDROID_TARGET: 'e2e' }, '1.0.0');
  assert.equal(config.server.url, E2E_ORIGIN);
  assert.equal(config.server.cleartext, true);
  assert.equal(config.android.webContentsDebuggingEnabled, true);
  assert.notDeepEqual(releaseViolations(config), []);
});

test('unknown target and malformed version throw', () => {
  assert.throws(() => parseTarget('production'), /must be one of prod, staging, e2e/);
  assert.throws(() => buildConfig({ OA_ANDROID_TARGET: 'PROD' }, '1.0.0'), /must be one of/);
  for (const version of ['1.0', '1.0.0-beta.1', 'v1.0.0', '']) {
    assert.throws(() => buildConfig({}, version), /x\.y\.z/);
  }
});
