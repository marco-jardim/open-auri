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
]);
const maxFileSize = 5 * 1024 * 1024;

function parseEnv(text) {
  const values = new Map();
  const assignment = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|([^\r\n]*))/gm;
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

function sensitiveNeedles(values) {
  const needles = [];
  const add = (value, label) => {
    if (value) needles.push({ value: value.toLowerCase(), label });
  };

  for (const [key, value] of values) {
    if (!safelist.has(key) && value.length >= 6) add(value, key);
    for (const email of value.matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,})/g)) {
      add(email[1], `derived:EMAIL_DOMAIN(${key})`);
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

function scan(root) {
  const values = parseEnv(readFileSync(resolve(root, '.env'), 'utf8'));
  const needles = sensitiveNeedles(values);
  const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean);
  const findings = [];
  for (const path of new Set(files)) {
    const absolute = resolve(root, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.size > maxFileSize) continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8').toLowerCase();
    const lineStarts = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === '\n') lineStarts.push(index + 1);
    }
    const matches = new Map();
    for (const needle of needles) {
      let offset = text.indexOf(needle.value);
      while (offset !== -1) {
        let low = 0;
        let high = lineStarts.length;
        while (low + 1 < high) {
          const middle = Math.floor((low + high) / 2);
          if (lineStarts[middle] <= offset) low = middle;
          else high = middle;
        }
        const line = low + 1;
        if (!matches.has(line)) matches.set(line, new Set());
        matches.get(line).add(needle.label);
        offset = text.indexOf(needle.value, offset + 1);
      }
    }
    for (const [line, labels] of [...matches].sort(([a], [b]) => a - b)) {
      for (const label of labels) findings.push({ path, line, label });
    }
  }
  return findings;
}

const json = process.argv.includes('--json');
try {
  const findings = scan(process.cwd());
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
