import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const safelist = new Set([
  'WORKER_NAME_WEB',
  'WORKER_NAME_JOBS',
  'ACCESS_LOG_ENABLED',
  'SIGNUP_ENABLED',
  'ADMIN_2FA_REQUIRED',
  'PUBLIC_GITHUB_URL',
  // A calendar date; it collides with dated paths and fixtures and identifies nobody.
  'PUBLIC_POLICY_EFFECTIVE_DATE',
  // Public resource names derived from the project name; their IDs stay scanned.
  'D1_DATABASE_NAME',
  'D1_DATABASE_NAME_STAGING',
  'R2_BUCKET',
  'R2_BUCKET_STAGING',
  'ACCESS_LOG_QUEUE',
  'ACCESS_LOG_QUEUE_STAGING',
  'ACCESS_LOG_DLQ',
  'ACCESS_LOG_DLQ_STAGING',
]);
// The product's own public domain (and its subdomains, e.g. the sending domain) is published on
// purpose; addresses and other values stay scanned through their keys.
const publicDomains = ['open-auri.com'];
// Public mailbox providers: their domain identifies nobody (third-party license texts are full of
// such addresses); the operator's full address stays scanned through its own key.
const publicMailProviders = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'yandex.com',
  'uol.com.br',
  'bol.com.br',
  'terra.com.br',
]);
/** @param {string} domain */
const isPublicDomain = (domain) =>
  publicDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
const maxFileSize = 5 * 1024 * 1024;

// Well-known credential shapes, scanned in every mode (also without a .env, as in CI with
// --no-env). Case-sensitive; only the label is ever reported. Shapes that the repository's own
// test fixtures use on purpose (e.g. `whsec_` webhook test secrets) are not listed.
/** @type {{ pattern: RegExp, label: string }[]} */
const genericPatterns = [
  { pattern: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{24,}/g, label: 'generic:RESEND_API_KEY' },
  { pattern: /\b0x4AAAAAAA[A-Za-z0-9_-]{10,}/g, label: 'generic:TURNSTILE_KEY' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g, label: 'generic:GITHUB_TOKEN' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}/g, label: 'generic:GITHUB_TOKEN' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'generic:AWS_ACCESS_KEY' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, label: 'generic:PRIVATE_KEY' },
  {
    // A concrete Windows profile path (placeholders such as <nome> or an ellipsis do not match).
    pattern: /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!(?:Public|Default|All Users)\b)[A-Za-z0-9]/g,
    label: 'generic:WINDOWS_USER_PROFILE',
  },
];

// Block Android credentials and local configuration by filename, including binary or large files.
/** @type {{ pattern: RegExp, label: string }[]} */
const androidFilePatterns = [
  { pattern: /\.(?:jks|keystore)$/i, label: 'file:ANDROID_KEYSTORE' },
  { pattern: /\.pepk$/i, label: 'file:ANDROID_PEPK' },
  { pattern: /(?:^|\/)keystore\.properties$/i, label: 'file:ANDROID_KEYSTORE_PROPERTIES' },
  { pattern: /(?:^|\/)google-services\.json$/i, label: 'file:ANDROID_GOOGLE_SERVICES' },
  { pattern: /(?:^|\/)local\.properties$/i, label: 'file:ANDROID_LOCAL_PROPERTIES' },
];

/** @param {string} text */
function parseEnv(text) {
  /** @type {Map<string, string>} */
  const values = new Map();
  const assignment =
    /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|([^\r\n]*))/gm;
  for (const match of text.matchAll(assignment)) {
    let value;
    if (match[2] !== undefined) {
      value = match[2].replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
    } else {
      value = match[3] ?? match[4].replace(/#.*$/, '').trim();
    }
    values.set(match[1], value);
  }
  return values;
}

/** @param {Map<string, string>} values */
function sensitiveNeedles(values) {
  /** @type {{value: string, label: string}[]} */
  const needles = [];
  /**
   * @param {string | undefined} value
   * @param {string} label
   */
  const add = (value, label) => {
    if (value) needles.push({ value: value.toLowerCase(), label });
  };

  for (const [key, value] of values) {
    if (!safelist.has(key) && value.length >= 6) add(value, key);
    for (const email of value.matchAll(
      /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,})/g,
    )) {
      const domain = email[1].toLowerCase();
      if (!isPublicDomain(domain) && !publicMailProviders.has(domain)) {
        add(email[1], `derived:EMAIL_DOMAIN(${key})`);
      }
    }
    if (key === 'CLOUDFLARE_WORKERS_SUBDOMAIN') {
      add(value, 'derived:WORKERS_SUBDOMAIN');
    }
    if (key === 'PUBLIC_ORIGIN') {
      try {
        const hostname = new URL(value).hostname;
        if (hostname.endsWith('.workers.dev')) {
          const parts = hostname.split('.');
          if (parts.length >= 3) add(parts.at(-3), 'derived:WORKERS_SUBDOMAIN');
        }
      } catch {
        // Other values remain covered by their original key.
      }
    }
  }

  const profile = homedir().match(/^([A-Za-z]:)[\\/]Users[\\/]([^\\/]+)/i);
  if (profile) {
    add(`${profile[1]}\\Users\\${profile[2]}`, 'derived:WINDOWS_USER_PROFILE');
    add(`${profile[1]}/Users/${profile[2]}`, 'derived:WINDOWS_USER_PROFILE');
  }
  return needles;
}

/** @param {string} text */
function lineStartsOf(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/**
 * 1-based line of `offset`, by binary search over the line starts.
 * @param {number[]} starts
 * @param {number} offset
 */
function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low + 1;
}

/**
 * @param {string} root
 * @param {boolean} useEnv false (--no-env) scans filenames, generic shapes and the profile path
 */
function scan(root, useEnv) {
  const values = useEnv ? parseEnv(readFileSync(resolve(root, '.env'), 'utf8')) : new Map();
  const needles = sensitiveNeedles(values);
  const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(Boolean);
  const findings = [];
  for (const path of new Set(files)) {
    const absolute = resolve(root, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const blockedName = androidFilePatterns.find(({ pattern }) => pattern.test(path));
    if (blockedName) {
      findings.push({ path, line: 1, label: blockedName.label });
      continue;
    }
    if (stat.size > maxFileSize) continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const original = bytes.toString('utf8');
    const text = original.toLowerCase();
    const lowerStarts = lineStartsOf(text);
    const matches = new Map();
    /**
     * @param {number} line
     * @param {string} label
     */
    const record = (line, label) => {
      if (!matches.has(line)) matches.set(line, new Set());
      matches.get(line).add(label);
    };
    for (const needle of needles) {
      let offset = text.indexOf(needle.value);
      while (offset !== -1) {
        record(lineAt(lowerStarts, offset), needle.label);
        offset = text.indexOf(needle.value, offset + 1);
      }
    }
    // The generic shapes are case-sensitive, so they run on the original text with its own line
    // index (toLowerCase() may change the length of a few code points).
    const originalStarts = lineStartsOf(original);
    for (const { pattern, label } of genericPatterns) {
      for (const match of original.matchAll(pattern)) {
        record(lineAt(originalStarts, match.index), label);
      }
    }
    for (const [line, labels] of [...matches].sort(([a], [b]) => a - b)) {
      for (const label of labels) findings.push({ path, line, label });
    }
  }
  return findings;
}

// --no-env: for CI, where no .env exists. Filenames, generic credential shapes and the user
// profile path are scanned; the values of the operator's .env are covered by the local run.
const json = process.argv.includes('--json');
const useEnv = !process.argv.includes('--no-env');
try {
  const findings = scan(process.cwd(), useEnv);
  if (json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    for (const { path, line, label } of findings) console.log(`${path}:${line}: ${label}`);
  }
  process.exitCode = findings.length ? 1 : 0;
} catch {
  const error = 'Sensitive-data scan failed; check that .env exists and git is available.';
  if (json) console.log(JSON.stringify({ error }));
  else console.error(error);
  process.exitCode = 2;
}
