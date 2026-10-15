#!/usr/bin/env node
// Generates golden reference vectors for the 0xCB wire format.
//
// Source: the public Kuba equalizer page, which is a *working* implementation
// that writes presets to the chip. Its DSP/PRESETS code is evaluated here ONLY
// to produce the expected byte streams. That code is not vendored into this
// repository: the fixture is derived data (the correct bytes for each preset),
// used to assert that src/dsp/eq0xcb.mjs reproduces the format byte for byte.
//
// Credit: presets and reference implementation by Kuba (kuba.audio). The page
// itself attributes its default curve to Leonardo ("Padrão = filtros do Leonardo").
//
// Safety: the reference is third-party code. It is never run straight from the
// network. --fetch only downloads and saves it; --template runs a local copy
// whose SHA-256 is recorded in the fixture (and can be pinned with
// --expect-sha256), inside a separate V8 context with a timeout. node:vm is not
// a security boundary; reviewing and pinning the file is the actual control.
//
// Usage:
//   node tools/extract-kuba-reference.mjs --fetch <out.html>
//   node tools/extract-kuba-reference.mjs --template <file> [--expect-sha256 <hex>]
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const URL_DEFAULT = 'https://equalizador.kuba.audio/';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../test/fixtures/eq0xcb.reference.json');
const USAGE = [
  'usage:',
  '  node tools/extract-kuba-reference.mjs --fetch <out.html>',
  '  node tools/extract-kuba-reference.mjs --template <file> [--expect-sha256 <hex>]',
].join('\n');

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function option(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// The page is a bundled artifact: the app lives in a JSON-encoded template tag.
// Plain (already decoded) HTML passes through unchanged.
function decodeTemplate(html) {
  const m = html.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : html;
}

function between(src, start, end, inclusiveEnd) {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`start marker not found: ${start}`);
  const b = src.indexOf(end, a);
  if (b < 0) throw new Error(`end marker not found: ${end}`);
  return src.slice(a, inclusiveEnd ? b + end.length : b);
}

async function fetchTemplate(out) {
  const res = await fetch(URL_DEFAULT);
  if (!res.ok) throw new Error(`GET ${URL_DEFAULT} -> HTTP ${res.status}`);
  const text = decodeTemplate(await res.text());
  await writeFile(out, text);
  console.log(`wrote ${out}`);
  console.log(`sha256 ${sha256(text)}`);
  console.log('Review the file, then run --template with --expect-sha256.');
}

async function buildFixture(path, expectedSha) {
  const text = decodeTemplate(await readFile(path, 'utf8'));
  const hash = sha256(text);
  if (expectedSha && expectedSha.toLowerCase() !== hash) {
    throw new Error(`sha256 mismatch: expected ${expectedSha}, got ${hash}`);
  }

  const dspSrc = between(text, 'const DSP = {', 'module.exports = DSP;', true);
  const presetsSrc = between(text, 'const PK = ', '// Medição', false);
  const { DSP, PRESETS } = vm.runInContext(
    `${dspSrc}\n${presetsSrc}\n({ DSP, PRESETS })`,
    vm.createContext({}),
    { timeout: 5000 },
  );

  const fixture = {
    _provenance: {
      source: URL_DEFAULT,
      templateSha256: hash,
      credit: 'Presets and reference implementation: Kuba (kuba.audio). '
        + 'The reference page attributes its default curve to Leonardo '
        + '("Padrão = filtros do Leonardo").',
      note: 'Reference bytes produced by the Kuba page DSP implementation, '
        + 'evaluated from a pinned local copy (not vendored).',
    },
    constants: {
      VENDOR_ID: DSP.VENDOR_ID,
      PRODUCT_ID: DSP.PRODUCT_ID,
      REPORT_ID: DSP.REPORT_ID,
      FS: DSP.FS,
      HEADER: DSP.HEADER,
      APPLY: DSP.APPLY,
    },
    presets: {},
  };

  for (const p of PRESETS.auri) {
    fixture.presets[p.id] = {
      pre: p.pre,
      bands: p.bands,
      blob: DSP.blob(p.bands, p.pre),
      packets: DSP.packets(p.bands, p.pre).map((pk) => Array.from(pk)),
    };
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(fixture, null, 2) + '\n');
  const ids = Object.keys(fixture.presets);
  console.log(`wrote ${OUT}`);
  console.log(`template sha256 ${hash}`);
  console.log(`presets: ${ids.length} (${ids.join(', ')})`);
}

async function main() {
  const argv = process.argv.slice(2);
  const fetchOut = option(argv, '--fetch');
  const template = option(argv, '--template');
  if (fetchOut) return fetchTemplate(fetchOut);
  if (template) return buildFixture(template, option(argv, '--expect-sha256'));
  console.error(USAGE);
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
