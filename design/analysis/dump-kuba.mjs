#!/usr/bin/env node
// Decode the public bundler artifact without executing any downloaded script.
// Third-party material stays outside the repository, regardless of its licence.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const destination = join(tmpdir(), "Claude", "kuba-dump");
const fixture = JSON.parse(await readFile(new URL('../../test/fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'));
const response = await fetch('https://equalizador.kuba.audio/');
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const html = await response.text();
await mkdir(destination, { recursive: true });
await writeFile(resolve(destination, 'page.html'), html);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const metadata = {
  fetchedAt: new Date().toISOString(), url: response.url,
  pageSha256: hash(html), pinnedTemplateSha256: fixture._provenance.templateSha256,
  scripts: [], assets: [],
};
const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '_');
let assetIndex = 0;
async function decodeAssets(value, path = []) {
  if (value && typeof value === 'object' && typeof value.data === 'string' && typeof value.mime === 'string') {
    const encoded = Buffer.from(value.data, 'base64');
    const decoded = value.compressed ? gunzipSync(encoded) : encoded;
    const extension = ({ 'image/svg+xml': 'svg', 'image/png': 'png', 'font/woff2': 'woff2',
      'text/javascript': 'js', 'application/javascript': 'js', 'text/html': 'html' })[value.mime] ?? 'bin';
    const filename = `asset-${String(++assetIndex).padStart(3, '0')}-${safeName(path.at(-1))}.${extension}`;
    await writeFile(resolve(destination, filename), decoded);
    metadata.assets.push({ path, filename, mime: value.mime, compressed: value.compressed,
      bytes: decoded.length, sha256: hash(decoded) });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) await decodeAssets(child, [...path, key]);
  }
}
for (const [index, match] of [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].entries()) {
  const type = match[1].match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1] ?? '';
  const filename = `script-${String(index).padStart(2, '0')}-${safeName(type || 'javascript')}.txt`;
  await writeFile(resolve(destination, filename), match[2]);
  let data;
  try { data = JSON.parse(match[2]); } catch { /* Runtime scripts are not JSON. */ }
  metadata.scripts.push({ index, type, filename, bytes: match[2].length,
    shape: data && typeof data === 'object' ? Object.keys(data) : typeof data });
  if (type === '__bundler/template') {
    if (typeof data !== 'string') throw new Error('Expected JSON-encoded template string');
    await writeFile(resolve(destination, 'template.html'), data);
    metadata.templateSha256 = hash(data);
    metadata.matchesPin = metadata.templateSha256 === metadata.pinnedTemplateSha256;
    metadata.appScripts = [];
    for (const [appIndex, appMatch] of [...data.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].entries()) {
      const appFilename = `template-script-${String(appIndex).padStart(2, '0')}.js`;
      await writeFile(resolve(destination, appFilename), appMatch[2]);
      metadata.appScripts.push({ filename: appFilename, attributes: appMatch[1],
        templateStartLine: data.slice(0, appMatch.index).split('\n').length,
        lines: appMatch[2].split('\n').length, sha256: hash(appMatch[2]) });
    }
  }
  if (data !== undefined) {
    await decodeAssets(data, [type]);
    if (type !== '__bundler/template') {
      await writeFile(resolve(destination, `${safeName(type)}.json`), JSON.stringify(data, null, 2));
    }
  }
}
await writeFile(resolve(destination, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify({ destination, ...metadata }, null, 2));
