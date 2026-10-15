#!/usr/bin/env node
// Generates golden reference vectors for the 0xCB wire format.
//
// Source: the public Kuba equalizer page, which is a *working* implementation
// that writes presets to the chip. Its DSP/PRESETS code is evaluated here ONLY
// to produce the expected byte streams. None of that code is vendored into this
// repository -- the fixture is derived data (the correct bytes for a given
// preset), used to assert that our own implementation in src/dsp/eq0xcb.mjs
// reproduces the format byte for byte.
//
// Credit: presets and reference implementation by Kuba (kuba.audio). The page
// itself attributes its default curve to Leonardo ("Padrão = filtros do Leonardo").
//
// Usage:
//   node tools/extract-kuba-reference.mjs                       # fetch the live page
//   node tools/extract-kuba-reference.mjs --template <file>     # use a saved HTML/template
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_DEFAULT = 'https://equalizador.kuba.audio/';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../test/fixtures/eq0xcb.reference.json');

async function loadTemplate(argv) {
  const i = argv.indexOf('--template');
  let raw;
  if (i >= 0) {
    raw = await readFile(argv[i + 1], 'utf8');
  } else {
    raw = await (await fetch(URL_DEFAULT)).text();
  }
  // The page is a bundled artifact: the app lives in a JSON-encoded template tag.
  const m = raw.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/);
  const text = m ? JSON.parse(m[1]) : raw; // plain HTML passthrough
  return text;
}

function sliceInclusive(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`start marker not found: ${start}`);
  const b = src.indexOf(end, a);
  if (b < 0) throw new Error(`end marker not found: ${end}`);
  return src.slice(a, b + end.length);
}

async function main() {
  const src = await loadTemplate(process.argv.slice(2));

  const dspSrc = sliceInclusive(src, 'const DSP = {', 'module.exports = DSP;');
  const presetsSrc = src.slice(src.indexOf('const PK = '), src.indexOf('// Medição'));

  // Evaluate the reference implementation in an isolated function scope.
  const { DSP, PRESETS } = new Function(
    `${dspSrc}\n${presetsSrc}\nreturn { DSP, PRESETS };`)();

  const fixture = {
    _provenance: {
      source: URL_DEFAULT,
      credit: 'Presets and reference implementation: Kuba (kuba.audio). '
        + 'The reference page attributes its default curve to Leonardo '
        + '("Padrão = filtros do Leonardo").',
      note: 'Reference bytes produced by the Kuba page DSP implementation (not vendored).',
      generatedAt: new Date().toISOString(),
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
  console.log(`presets: ${ids.length} (${ids.join(', ')})`);
  console.log(`blob length: ${fixture.presets[ids[0]].blob.length}, packets: ${fixture.presets[ids[0]].packets.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
