import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class RenderError extends Error {}

/** @typedef {'web' | 'jobs'} WorkerId */
/** @typedef {{ name: string, source: string, required: boolean, workers: readonly WorkerId[] }} SecretSpec */

/**
 * Runtime secrets. `name` is the Worker secret / .dev.vars key, `source` the repository .env key.
 * Optional secrets are skipped with a notice when absent (RESEND_WEBHOOK_SECRET lands in F5).
 * `workers` lists which Workers receive the secret (least privilege; T3.3 may widen jobs).
 * @type {readonly SecretSpec[]}
 */
export const SECRETS = [
  { name: 'BETTER_AUTH_SECRET', source: 'BETTER_AUTH_SECRET', required: true, workers: ['web'] },
  { name: 'RESEND_API_KEY', source: 'RESEND_API_KEY', required: true, workers: ['web'] },
  { name: 'TURNSTILE_SECRET', source: 'TURNSTILE_SECRET_KEY', required: true, workers: ['web'] },
  { name: 'IPHASH_PEPPER', source: 'IPHASH_PEPPER', required: true, workers: ['web'] },
  {
    name: 'ACCESS_LOG_KEY',
    source: 'ACCESS_LOG_KEY',
    required: true,
    workers: ['web', 'jobs'],
  },
  {
    name: 'RESEND_WEBHOOK_SECRET',
    source: 'RESEND_WEBHOOK_SECRET',
    required: false,
    workers: ['web'],
  },
];

/**
 * Placeholder values used when the key is missing or empty in .env / process.env. Only for
 * non-secret settings whose default is the production behaviour. An empty Android certificate
 * list deliberately leaves verified App Links unpublished until the signing key is configured.
 * @type {Readonly<Record<string, string>>}
 */
export const DEFAULTS = Object.freeze({
  EMAIL_TRANSPORT: 'resend',
  PUBLIC_ANDROID_APP_ID: 'com.openauri.app',
  PUBLIC_ANDROID_CERT_SHA256: '',
});

/** @param {string} source */
export function parseEnv(source) {
  /** @type {Map<string, string>} */
  const values = new Map();
  for (const [index, raw] of source
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new RenderError(`Invalid .env syntax at line ${index + 1}`);
    const [, key, remainder] = match;
    let value = remainder;
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) {
        throw new RenderError(`Invalid .env syntax at line ${index + 1}`);
      }
      value = value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values.set(key, value);
  }
  return values;
}

/**
 * Repository .env (next to this tools/ directory) overlaid by process.env (CI wins).
 * @returns {Map<string, string>}
 */
export function loadValues() {
  let dotenv = '';
  try {
    dotenv = readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new RenderError('Could not read the repository .env file');
    }
  }
  const values = parseEnv(dotenv);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) values.set(key, value);
  }
  return values;
}

/**
 * @param {string} template
 * @param {string} output
 * @param {Map<string, string>} values
 */
export function renderTemplate(template, output, values) {
  let source;
  try {
    source = readFileSync(template, 'utf8');
  } catch {
    throw new RenderError('Could not read the Wrangler template');
  }
  /** @type {Set<string>} */
  const missing = new Set();
  // Placeholders always sit inside JSON strings: escape quotes, backslashes and control
  // characters so a value such as `"Name" <mail>` cannot break (or inject into) the config.
  const rendered = source.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (/** @type {string} */ _, /** @type {string} */ key) => {
      const given = values.get(key);
      const value =
        (given === undefined || given === '') && Object.hasOwn(DEFAULTS, key)
          ? DEFAULTS[key]
          : given;
      if (value === undefined || (value === '' && !Object.hasOwn(DEFAULTS, key))) missing.add(key);
      return JSON.stringify(value ?? '').slice(1, -1);
    },
  );
  if (missing.size) {
    throw new RenderError(`Missing environment variables: ${[...missing].sort().join(', ')}`);
  }
  const header = `// GENERATED — do not edit; source: ${template.replace(/[\r\n]/g, '')}\n`;
  try {
    writeFileSync(output, header + rendered, 'utf8');
  } catch {
    throw new RenderError('Could not write the generated Wrangler configuration');
  }
}

/**
 * Quotes a value for the dotenv parser Wrangler uses for .dev.vars, without ever echoing it.
 * @param {string} name
 * @param {string} value
 */
function formatDevVar(name, value) {
  if (/[\r\n]/.test(value)) throw new RenderError(`Secret ${name} contains a line break`);
  if (/^[A-Za-z0-9_./:+=@-]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  throw new RenderError(`Secret ${name} cannot be written to .dev.vars safely`);
}

/**
 * Writes the local secrets file for `wrangler dev` / `getPlatformProxy`.
 * @param {string} output
 * @param {Map<string, string>} values
 * @param {WorkerId} worker
 * @returns {{ written: string[], skipped: string[] }} names only
 */
export function renderDevVars(output, values, worker) {
  const specs = SECRETS.filter((spec) => spec.workers.includes(worker));
  const missing = specs
    .filter((spec) => spec.required && !values.get(spec.source))
    .map((spec) => spec.source);
  if (missing.length) {
    throw new RenderError(`Missing environment variables: ${missing.sort().join(', ')}`);
  }
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const skipped = [];
  const lines = ['# GENERATED by tools/render-wrangler.mjs --dev-vars — do not edit or commit.'];
  for (const spec of specs) {
    const value = values.get(spec.source);
    if (!value) {
      skipped.push(spec.name);
      continue;
    }
    lines.push(`${spec.name}=${formatDevVar(spec.name, value)}`);
    written.push(spec.name);
  }
  try {
    writeFileSync(output, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    throw new RenderError('Could not write the .dev.vars file');
  }
  return { written, skipped };
}

const USAGE =
  'Usage: node tools/render-wrangler.mjs <template> <output>\n' +
  '       node tools/render-wrangler.mjs --dev-vars <output> [--worker web|jobs]';

/** @param {string[]} args */
function main(args) {
  if (args[0] === '--dev-vars') {
    const [, output, flag, choice, ...extra] = args;
    if (!output || output.startsWith('--') || extra.length) throw new RenderError(USAGE);
    /** @type {WorkerId} */
    let worker = 'web';
    if (flag !== undefined) {
      if (flag !== '--worker' || (choice !== 'web' && choice !== 'jobs')) {
        throw new RenderError(USAGE);
      }
      worker = choice;
    }
    const { skipped } = renderDevVars(output, loadValues(), worker);
    for (const name of skipped) console.error(`Skipped optional secret (not set): ${name}`);
    return;
  }
  const [template, output, ...extra] = args;
  if (!template || !output || extra.length) throw new RenderError(USAGE);
  renderTemplate(template, output, loadValues());
}

/**
 * True when the module at `moduleUrl` is the script Node was started with (not an import).
 * @param {string} moduleUrl `import.meta.url` of the caller
 */
export function isEntryPoint(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // Only controlled diagnostics may reach the terminal, never input or OS error text.
    console.error(
      error instanceof RenderError ? error.message : 'Could not render Wrangler config',
    );
    process.exitCode = 1;
  }
}
