// REAL hardware capture (Kuba Auri, 2026-10-28, Windows 11 / Edge 156, USBPcap).
// Unlike synthetic-*.json, these bytes were observed on the wire, not generated.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NEUTRO, OFFICIAL_PRESETS } from '../../src/catalog/presets.mjs';
import {
  commitReport,
  encodeReports,
  NEUTRAL_BANDS,
  REPORT_SIZE,
  reportsFromPayload,
} from '../../src/dsp/eq0xcb.mjs';
import { captureGolden, compareWireLog, parseArgs } from '../../tools/usb-golden.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(root, 'test/fixtures/usb-golden');
const rawFile = join(directory, 'capture-2026-10-28-edge-win.raw.json');
const provenanceFile = join(directory, 'capture-2026-10-28-edge-win.provenance.json');
const goldenFile = join(root, 'test/fixtures/usb-wire-golden.json');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const raw = readJson(rawFile);
const golden = readJson(goldenFile);
const reference = readJson(join(root, 'test/fixtures/eq0xcb.reference.json'));
const officialIds = Object.keys(reference.presets);
const metadata = { capturedOn: '2026-10-28', os: 'Windows11', browser: 'Edge156' };
const options = { ...metadata, inputFormat: 'interrupt-out-raw' };
const hex = (bytes) => Buffer.from(bytes).toString('hex');
/** Report ID CB + 31 data bytes, zero-extended like WebHID does. */
const wire = (data) => {
  const bytes = new Uint8Array(REPORT_SIZE + 1);
  bytes[0] = 0xcb;
  bytes.set(data, 1);
  return hex(bytes);
};
const commit = wire(commitReport());
// Write 12 repeats padrao after etymotic (open-auri), so the tool reports
// exactly one out-of-order warning for it. Any other warning is a failure.
const expectedWarnings = [
  {
    message: `out-of-order curve: padrao (fixture order: ${[...officialIds, 'neutro'].join(', ')})`,
    count: 1,
  },
];

test('real capture: 130 interrupt OUT buffers, 13 writes of 9 reports + commit, CB + 31 bytes', () => {
  assert.equal(raw.length, 130);
  for (const entry of raw) assert.match(entry.hex, /^cb[\da-f]{62}$/);
  const { golden: generated, warnings } = captureGolden(raw, options);
  assert.deepEqual(warnings, expectedWarnings);
  assert.equal(generated.transfer, 'interrupt');
  assert.equal(generated.paddedLength, 32);
  assert.deepEqual(
    generated.writes.map(({ curve }) => curve),
    [...officialIds, 'padrao', 'neutro'],
  );
});

test('real capture: writes 1-11 (official page) match eq0xcb.reference.json, 11/11', () => {
  assert.equal(officialIds.length, 11);
  officialIds.forEach((id, index) => {
    const write = raw.slice(index * 10, index * 10 + 9).map((entry) => entry.hex);
    assert.deepEqual(write, reference.presets[id].reports.map(wire), `official ${id}`);
  });
});

test('real capture: writes 12/13 (open-auri) match encodeReports for padrao and neutro', () => {
  const padrao = OFFICIAL_PRESETS.find(({ id }) => id === 'padrao');
  assert.ok(padrao);
  const write12 = raw.slice(110, 120).map((entry) => entry.hex);
  const write13 = raw.slice(120, 130).map((entry) => entry.hex);
  assert.deepEqual(write12.slice(0, 9), encodeReports(padrao.bands, padrao.preampDb).map(wire));
  assert.deepEqual(
    write12,
    raw.slice(0, 10).map((entry) => entry.hex),
    'open-auri padrao equals official padrao, commit included',
  );
  assert.deepEqual(write13.slice(0, 9), encodeReports(NEUTRAL_BANDS, -0.5).map(wire));
  assert.deepEqual(write13.slice(0, 9), encodeReports(NEUTRO.bands, NEUTRO.preampDb).map(wire));
});

test('real capture: every commit is cb + commitReport() and every payload CRC recomputes', () => {
  assert.equal(commit, `cb01650001ff${'00'.repeat(26)}`);
  for (let write = 0; write < 13; write++) {
    const buffers = raw.slice(write * 10, write * 10 + 10).map((entry) => entry.hex);
    assert.equal(buffers[9], commit, `write ${write + 1} commit`);
    const payload = Buffer.concat(
      buffers.slice(0, 9).map((value) => Buffer.from(value.slice(4), 'hex')),
    );
    // reportsFromPayload throws on CRC mismatch.
    assert.deepEqual(reportsFromPayload(payload.subarray(0, 220)).map(wire), buffers.slice(0, 9));
  }
});

test('committed real golden is the tool output plus provenance and replays the raw log', () => {
  const { _provenance: provenance, ...rest } = golden;
  assert.deepEqual(provenance, readJson(provenanceFile));
  assert.match(provenance.kind, /^REAL hardware capture/);
  assert.deepEqual(rest, captureGolden(raw, options).golden);
  const t0 = raw[0].t;
  const log = raw.map(({ t, hex: value }) => ({ atMs: (t - t0) * 1000, hex: value }));
  assert.deepEqual(compareWireLog(log, golden), []);
  const changed = structuredClone(log);
  changed[129].hex = changed[129].hex.slice(0, -2) + '01';
  assert.match(compareWireLog(changed, golden).join('\n'), /write 13 \(neutro\) commit: byte 31/);
});

test('interrupt-out-raw input is strict and explicit', () => {
  for (const broken of [
    {},
    [{ frame: 1, t: 0, hex: raw[0].hex.slice(0, -2) }],
    [{ frame: 1, t: 0, hex: `00${raw[0].hex.slice(2)}` }],
    [raw[1], raw[0]],
    [{ ...raw[0], t: -1 }],
    [{ ...raw[0], frame: 'x' }],
  ]) {
    assert.throws(() => captureGolden(broken, options), /Raw capture|interrupt-out-raw|byte hex/);
  }
  assert.throws(() => captureGolden(raw, { ...metadata, inputFormat: 'pcap' }), /input format/);
  assert.throws(() => captureGolden(raw, metadata), /JSON array|matching/);
  const flags = ['x', '--captured-on', 'd', '--os', 'o', '--browser', 'b'];
  assert.equal(
    parseArgs([...flags, '--input-format', 'interrupt-out-raw']).flags['--input-format'],
    'interrupt-out-raw',
  );
  for (const extra of [
    ['--input-format', 'pcap'],
    ['--input-format', 'interrupt-out-raw', '--address', '1.21'],
    ['--input-format', 'interrupt-out-raw', '--interface', '3'],
  ]) {
    assert.throws(() => parseArgs([...flags, ...extra]), /Usage:/);
  }
});

test('CLI regenerates the committed real golden byte for byte', (t) => {
  const dir = mkdtempSync(join(directory, '.run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'golden.json');
  const run = spawnSync(
    process.execPath,
    [
      join(root, 'tools/usb-golden.mjs'),
      rawFile,
      '--input-format',
      'interrupt-out-raw',
      '--captured-on',
      metadata.capturedOn,
      '--os',
      metadata.os,
      '--browser',
      metadata.browser,
      '--provenance',
      provenanceFile,
      '--out',
      out,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Validated 13 writes, interrupt, 32 bytes/);
  assert.equal(run.stderr.trim(), `Warning (1): ${expectedWarnings[0].message}`);
  assert.equal(readFileSync(out, 'utf8'), readFileSync(goldenFile, 'utf8'));
});
