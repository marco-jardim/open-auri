// Usage: node tools/android-notices.mjs [--input artifacts.json] [--output notices.txt] [--check]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INPUT = resolve(
  ROOT,
  'apps/android/android/app/build/reports/licensee/androidRelease/artifacts.json',
);
const OUTPUT = resolve(ROOT, 'web/static/third-party-licenses-android.txt');
const USAGE =
  'Usage: node tools/android-notices.mjs [--input artifacts.json] [--output notices.txt] [--check]';

// Keep in sync with licensee { allow(...) } in apps/android/android/app/build.gradle.
export const ALLOWED_SPDX = Object.freeze([
  'Apache-2.0',
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'EPL-2.0',
]);

/** @typedef {{ identifier: string, name?: string, url?: string }} SpdxLicense */
/** @typedef {{ name?: string, url?: string }} UnknownLicense */
/**
 * @typedef {{ groupId: string, artifactId: string, version: string, name?: string,
 *   scm?: string, spdxLicenses: SpdxLicense[], unknownLicenses: UnknownLicense[] }} Artifact
 */

/** @param {string} a @param {string} b */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @param {unknown} value @param {string} context @returns {Record<string, unknown>} */
function record(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected an object: ${context}`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} context */
function requiredText(value, context) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing or invalid ${context}`);
  }
  return value.replace(/\s+/g, ' ').trim();
}

/** @param {unknown} value @param {string} context */
function optionalText(value, context) {
  return value === undefined ? undefined : requiredText(value, context);
}

/** @param {unknown} value @param {string} context @returns {unknown[]} */
function optionalArray(value, context) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Expected an array: ${context}`);
  return value;
}

/**
 * Validate Licensee's JSON without guessing SPDX expressions or accepting unknown-only licenses.
 * Missing license arrays in Licensee 1.14.1 mean empty arrays.
 * @param {unknown} report
 * @returns {Artifact[]}
 */
export function validateArtifacts(report) {
  if (!Array.isArray(report) || !report.length) {
    throw new Error('Expected a non-empty Licensee artifacts array');
  }
  return report.map((entry, index) => {
    const raw = record(entry, `artifact ${index}`);
    const groupId = requiredText(raw.groupId, `groupId at artifact ${index}`);
    const artifactId = requiredText(raw.artifactId, `artifactId at artifact ${index}`);
    const version = requiredText(raw.version, `version at artifact ${index}`);
    const coordinates = `${groupId}:${artifactId}:${version}`;
    const spdxLicenses = optionalArray(raw.spdxLicenses, `${coordinates} spdxLicenses`).map(
      (value) => {
        const license = record(value, `${coordinates} SPDX license`);
        const identifier = requiredText(license.identifier, `${coordinates} SPDX identifier`);
        if (!ALLOWED_SPDX.includes(identifier)) {
          throw new Error(`Disallowed SPDX license ${identifier}: ${coordinates}`);
        }
        return {
          identifier,
          name: optionalText(license.name, `${coordinates} license name`),
          url: optionalText(license.url, `${coordinates} license URL`),
        };
      },
    );
    if (!spdxLicenses.length) throw new Error(`No SPDX license: ${coordinates}`);
    const unknownLicenses = optionalArray(
      raw.unknownLicenses,
      `${coordinates} unknownLicenses`,
    ).map((value) => {
      const license = record(value, `${coordinates} unknown license`);
      return {
        name: optionalText(license.name, `${coordinates} unknown license name`),
        url: optionalText(license.url, `${coordinates} unknown license URL`),
      };
    });
    let scm;
    if (raw.scm !== undefined) {
      scm =
        typeof raw.scm === 'string'
          ? requiredText(raw.scm, `${coordinates} SCM`)
          : optionalText(record(raw.scm, `${coordinates} SCM`).url, `${coordinates} SCM URL`);
    }
    return {
      groupId,
      artifactId,
      version,
      name: optionalText(raw.name, `${coordinates} project name`),
      scm,
      spdxLicenses,
      unknownLicenses,
    };
  });
}

/**
 * Pure, deterministic render: no network, timestamps, locale ordering or absolute paths.
 * @param {unknown} report
 * @returns {string}
 */
export function renderNotices(report) {
  const entries = validateArtifacts(report).map((artifact) => {
    const coordinates = `${artifact.groupId}:${artifact.artifactId}:${artifact.version}`;
    const licenses = artifact.spdxLicenses
      .map(
        ({ identifier, name, url }) =>
          `SPDX: ${identifier}${name ? ` (${name})` : ''}\n` +
          `License URL: ${url ?? `https://spdx.org/licenses/${identifier}.html`}`,
      )
      .sort(compare);
    const unknown = artifact.unknownLicenses
      .map(
        ({ name, url }) =>
          `Other reported license: ${name ?? 'Unidentified'}${url ? ` (${url})` : ''}`,
      )
      .sort(compare);
    const text = [
      `Coordinates: ${coordinates}`,
      `Version: ${artifact.version}`,
      ...(artifact.name ? [`Project: ${artifact.name}`] : []),
      ...(artifact.scm ? [`SCM: ${artifact.scm}`] : []),
      ...licenses,
      ...unknown,
    ].join('\n');
    return { coordinates, text };
  });
  entries.sort((a, b) => compare(a.coordinates, b.coordinates) || compare(a.text, b.text));
  return (
    'Third-party licenses for the open-auri Android app (native dependencies)\n' +
    'Repository: https://github.com/marco-jardim/open-auri\n' +
    'Generated from the Licensee androidRelease artifacts.json report. Do not edit by hand.\n' +
    'Regenerate: npm run build:android:release && node tools/android-notices.mjs\n' +
    'These notices list the license identifiers and URLs reported for each native dependency.\n\n' +
    entries.map(({ text }) => `${'='.repeat(80)}\n${text}\n`).join('\n')
  );
}

/** @param {string[]} args */
export function parseArgs(args) {
  let input = INPUT;
  let output = OUTPUT;
  let check = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--check') check = true;
    else if ((arg === '--input' || arg === '--output') && args[index + 1]?.[0] !== '-') {
      const value = args[++index];
      if (!value) throw new Error(USAGE);
      if (arg === '--input') input = resolve(value);
      else output = resolve(value);
    } else throw new Error(USAGE);
  }
  return { input, output, check };
}

/** @param {string[]} args */
export function main(args) {
  const { input, output, check } = parseArgs(args);
  const text = renderNotices(JSON.parse(readFileSync(input, 'utf8')));
  if (check) {
    if (readFileSync(output, 'utf8') !== text) {
      throw new Error(`Android notices drift: regenerate ${output} from ${input}`);
    }
    console.log(`Android notices are up to date: ${output}`);
  } else {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, text, 'utf8');
    console.log(`Wrote Android notices to ${output}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
