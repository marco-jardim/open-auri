// Build targets of the Android app. Kept in plain JS so node:test can exercise it directly
// (test/tools/android-capacitor-targets.test.mjs); capacitor.config.ts only wires it.

export const PRODUCTION_ORIGIN = 'https://open-auri.com';
export const E2E_ORIGIN = 'http://10.0.2.2:4173';
/** Chromium baseline of the site build (Vite 8 default target, plan section 14, PF1.7). */
export const MIN_WEBVIEW_VERSION = 111;

/** @typedef {'prod' | 'staging' | 'e2e'} AndroidTarget */

/** @type {readonly AndroidTarget[]} */
export const TARGETS = ['prod', 'staging', 'e2e'];

/**
 * @param {string | undefined} value
 * @returns {AndroidTarget}
 */
export function parseTarget(value) {
  const target = value === undefined || value === '' ? 'prod' : value;
  const match = TARGETS.find((candidate) => candidate === target);
  if (match === undefined) {
    throw new Error(`OA_ANDROID_TARGET must be one of ${TARGETS.join(', ')}; got "${target}"`);
  }
  return match;
}

/**
 * @param {string | undefined} value
 * @param {string} name
 * @returns {string}
 */
export function bareHttpsOrigin(value, name) {
  if (value === undefined || value === '') {
    throw new Error(`${name} is required when OA_ANDROID_TARGET=staging`);
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${name} is not a valid URL: "${value}"`, { cause: error });
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use https; got "${value}"`);
  }
  if (url.origin !== value) {
    throw new Error(
      `${name} must be a bare origin without path, query or trailing slash; got "${value}"`,
    );
  }
  return url.origin;
}

/**
 * Capacitor config for a target. `server.url` is always a bare origin: Capacitor adds it verbatim
 * to the WebMessageListener origin rules (Bridge.setAllowedOriginRules).
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} version app version from apps/android/package.json
 */
export function buildConfig(env, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`app version must be x.y.z; got "${version}"`);
  }
  const target = parseTarget(env.OA_ANDROID_TARGET);
  const url =
    target === 'prod'
      ? PRODUCTION_ORIGIN
      : target === 'staging'
        ? bareHttpsOrigin(env.STAGING_ORIGIN, 'STAGING_ORIGIN')
        : E2E_ORIGIN;
  return {
    appId: 'com.openauri.app',
    appName: 'open-auri',
    webDir: 'www',
    server: {
      url,
      cleartext: target === 'e2e',
      errorPath: 'offline.html',
      /** @type {string[]} */
      allowNavigation: [],
    },
    android: {
      appendUserAgent: `OpenAuriAndroid/${version}`,
      minWebViewVersion: MIN_WEBVIEW_VERSION,
      webContentsDebuggingEnabled: target !== 'prod',
      allowMixedContent: false,
    },
  };
}
