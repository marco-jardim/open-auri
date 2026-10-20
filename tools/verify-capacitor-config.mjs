#!/usr/bin/env node
// Release guard for the Android app (plan 0.12.5): the generated capacitor.config.json must point
// at the production origin, with no cleartext, no extra navigation and WebView debugging off.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PRODUCTION_ORIGIN = 'https://open-auri.com';

/**
 * @param {unknown} config parsed capacitor.config.json
 * @returns {string[]} violations; empty when the config is valid for a release build
 */
export function releaseViolations(config) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return ['capacitor.config.json is not a JSON object'];
  }
  const record = /** @type {Record<string, unknown>} */ (config);
  /** @type {string[]} */
  const violations = [];
  const server = asRecord(record.server);
  const android = asRecord(record.android);

  if (record.appId !== 'com.openauri.app') {
    violations.push(`appId must be "com.openauri.app"; got ${JSON.stringify(record.appId)}`);
  }
  if (server === null) {
    violations.push('server block is missing');
  } else {
    if (server.url !== PRODUCTION_ORIGIN) {
      violations.push(
        `server.url must be "${PRODUCTION_ORIGIN}"; got ${JSON.stringify(server.url)}`,
      );
    }
    if (server.cleartext !== undefined && server.cleartext !== false) {
      violations.push('server.cleartext must be false');
    }
    if (
      server.allowNavigation !== undefined &&
      !(Array.isArray(server.allowNavigation) && server.allowNavigation.length === 0)
    ) {
      violations.push('server.allowNavigation must be empty');
    }
    if (server.hostname !== undefined || server.androidScheme !== undefined) {
      violations.push('server.hostname and server.androidScheme must not be set');
    }
  }
  if (android !== null) {
    if (android.useLegacyBridge) {
      violations.push('android.useLegacyBridge must not be enabled');
    }
    // Even "debug" is rejected in release config: only an absent value or "none" is allowed.
    if (android.loggingBehavior !== undefined && android.loggingBehavior !== 'none') {
      violations.push('android.loggingBehavior must be "none" or absent');
    }
    if (
      android.webContentsDebuggingEnabled !== undefined &&
      android.webContentsDebuggingEnabled !== false
    ) {
      violations.push('android.webContentsDebuggingEnabled must be false');
    }
    if (android.allowMixedContent !== undefined && android.allowMixedContent !== false) {
      violations.push('android.allowMixedContent must be false');
    }
  }
  if (
    record.webContentsDebuggingEnabled !== undefined &&
    record.webContentsDebuggingEnabled !== false
  ) {
    violations.push('webContentsDebuggingEnabled must be false');
  }
  if (record.useLegacyBridge) {
    violations.push('useLegacyBridge must not be enabled');
  }
  // CapConfig falls back to these top-level values. Reject unsafe overrides at either scope,
  // even when a safe android value currently masks them.
  if (record.loggingBehavior !== undefined && record.loggingBehavior !== 'none') {
    violations.push('loggingBehavior must be "none" or absent');
  }
  if (record.allowMixedContent !== undefined && record.allowMixedContent !== false) {
    violations.push('allowMixedContent must be false');
  }
  const nativeHttp = asRecord(asRecord(record.plugins)?.CapacitorHttp)?.enabled;
  // org.json getBoolean also enables the plugin for a case-insensitive string "true".
  if (
    nativeHttp === true ||
    (typeof nativeHttp === 'string' && nativeHttp.toLowerCase() === 'true')
  ) {
    violations.push('plugins.CapacitorHttp.enabled must not be true');
  }
  return violations;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  const path = argv[0];
  if (path === undefined) {
    process.stderr.write('usage: verify-capacitor-config.mjs <path to capacitor.config.json>\n');
    return 2;
  }
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verifyCapacitorConfig: cannot read ${path}: ${message}\n`);
    return 1;
  }
  const violations = releaseViolations(config);
  if (violations.length > 0) {
    process.stderr.write(`verifyCapacitorConfig: release config rejected (${path}):\n`);
    for (const violation of violations) process.stderr.write(`  - ${violation}\n`);
    return 1;
  }
  process.stdout.write(`verifyCapacitorConfig: OK (${path})\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
