import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NEUTRO } from '../../src/catalog/presets.mjs';
import { commitReport, encodeReports } from '../../src/dsp/eq0xcb.mjs';
import { captureGolden, compareWireLog, parseArgs } from '../../tools/usb-golden.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'tools/usb-golden.mjs');
const directory = join(root, 'test/fixtures/usb-golden');
const load = (name) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const interrupt = load('synthetic-tshark.json');
const control = load('synthetic-control.json');
const reference = JSON.parse(
  readFileSync(new URL('../fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);
const metadata = { capturedOn: '2026-10-18', os: 'Windows 11', browser: 'Chromium 140' };
const ids = [...Object.keys(reference.presets), 'neutro'];
const clone = (value) => structuredClone(value);
const dataFor = (id) =>
  id === 'neutro' ? encodeReports(NEUTRO.bands, NEUTRO.preampDb) : reference.presets[id].reports;

function frame(data, length) {
  const bytes = Buffer.alloc(length);
  bytes[0] = 0xcb;
  bytes.set(data, 1);
  return bytes.toString('hex');
}

function packet(hex, transfer = 'interrupt', extra = {}) {
  return {
    _source: {
      layers: {
        usb: {
          'usb.bus_id': '1',
          'usb.device_address': '7',
          'usb.endpoint_address': transfer === 'interrupt' ? '0x02' : '0x00',
          'usb.transfer_type': transfer === 'interrupt' ? '0x01' : '0x02',
          'usb.interface_number': '3',
          ...(transfer === 'control'
            ? {
                'usb.setup': {
                  'usb.setup.bmRequestType': '0x21',
                  'usb.setup.bRequest': '9',
                  'usb.setup.wValue': '0x02cb',
                  'usb.setup.wIndex': '3',
                },
              }
            : {}),
          ...extra,
        },
        ...(transfer === 'interrupt'
          ? { usbhid: { 'usbhid.data': hex } }
          : { data: { 'usb.data_fragment': hex } }),
      },
    },
  };
}

function write(id = 'padrao', transfer = 'interrupt', length = 32) {
  return [...dataFor(id), commitReport()].map((data) => packet(frame(data, length), transfer));
}

function capture(packets) {
  return [...clone(interrupt.slice(0, 2)), ...packets];
}
function appLog(golden) {
  return golden.writes
    .flatMap((write) => [...write.reports, write.commit])
    .map((hex, i) => ({ atMs: 1000 + i * 7, hex }));
}
function warningCount(result, pattern) {
  return result.warnings
    .filter(({ message }) => pattern.test(message))
    .reduce((sum, warning) => sum + warning.count, 0);
}

test('committed synthetic USBPcap captures validate both routes and preserve complete buffers', () => {
  for (const [input, transfer, length] of [
    [interrupt, 'interrupt', 32],
    [control, 'control', 64],
  ]) {
    const lengths = input.flatMap((p) => {
      const layers = p._source.layers;
      const value =
        layers.usbhid?.['usbhid.data'] ??
        layers.usb['usb.data_fragment'] ??
        layers.usb['usb.capdata'];
      return value?.startsWith('cb') ? [value.length / 2] : [];
    });
    assert.ok(
      lengths.every((value) => value === length),
      `${transfer} buffer lengths: ${lengths}`,
    );
    const { golden, warnings } = captureGolden(input, metadata);
    assert.deepEqual(warnings, []);
    assert.deepEqual(golden, {
      ...metadata,
      transfer,
      paddedLength: length,
      writes: [
        {
          curve: 'padrao',
          reports: reference.presets.padrao.reports.map((report) => frame(report, length)),
          commit: frame(commitReport(), length),
        },
      ],
    });
    assert.equal(
      golden.writes[0].reports[8].length,
      length * 2,
      'zero-filled last report must not be trimmed',
    );
  }
});

for (const transfer of ['interrupt', 'control']) {
  for (const length of [32, 64]) {
    test(`all 11 independent fixture curves and encoded Neutro: ${transfer}, ${length} bytes`, () => {
      const result = captureGolden(
        capture(ids.flatMap((id) => write(id, transfer, length))),
        metadata,
      );
      assert.deepEqual(
        result.golden.writes.map(({ curve }) => curve),
        ids,
      );
      assert.equal(result.golden.transfer, transfer);
      assert.equal(result.golden.paddedLength, length);
      assert.deepEqual(result.warnings, []);
      assert.deepEqual(compareWireLog(appLog(result.golden), result.golden), []);
    });
  }
}

test('other buses/devices/interfaces, interrupt IN and unrelated control requests are ignored', () => {
  const unwanted = [];
  for (const extra of [
    { 'usb.bus_id': '2' },
    { 'usb.device_address': '8' },
    { 'usb.interface_number': '0' },
    { 'usb.endpoint_address': '0x81' },
    { 'usb.endpoint_address.direction': '1' },
    { 'usb.endpoint_address': '0x03' },
    { 'usb.transfer_type': '0x03' },
    { 'usb.interface_class': '1' },
  ])
    unwanted.push(packet(frame(dataFor('padrao')[0], 32), 'interrupt', extra));
  for (const [field, value] of [
    ['usb.setup.bmRequestType', '0xa1'],
    ['usb.setup.bRequest', '1'],
    ['usb.setup.wValue', '0x03cb'],
    ['usb.setup.wIndex', '0'],
  ]) {
    const p = write('padrao', 'control')[0];
    p._source.layers.usb['usb.setup'][field] = value;
    unwanted.push(p);
  }
  const { golden, warnings } = captureGolden(capture([...unwanted, ...write()]), metadata);
  assert.equal(golden.writes.length, 1);
  assert.deepEqual(warnings, []);
});

test('decoded repeated interface descriptors assign endpoints without accepting non-HID endpoints', () => {
  const enumeration = clone(control.slice(0, 2));
  Object.assign(enumeration[1]._source.layers.usb, {
    'usb.bNumEndpoints': ['1', '1'],
    'usb.bEndpointAddress': ['0x01', '0x02'],
  });
  const data = write();
  for (const p of data) {
    p._source.layers.usb['usb.capdata'] = p._source.layers.usbhid['usbhid.data'];
    delete p._source.layers.usbhid;
    delete p._source.layers.usb['usb.interface_number'];
  }
  const wrong = clone(data[0]);
  wrong._source.layers.usb['usb.endpoint_address'] = '0x01';
  assert.equal(captureGolden([...enumeration, wrong, ...data], metadata).golden.writes.length, 1);
});

test('request/completion copies are counted once, and reused Windows IRP IDs do not lose later writes', () => {
  for (const transfer of ['interrupt', 'control']) {
    const packets = ids.flatMap((id) =>
      write(id, transfer).flatMap((p, index) => {
        p._source.layers.usb['usb.irp_id'] = `reused-${index}`;
        p._source.layers.usb['usb.irp_info.direction'] = '0';
        const completion = clone(p);
        completion._source.layers.usb['usb.irp_info.direction'] = '1';
        return [p, completion];
      }),
    );
    const result = captureGolden(capture(packets), metadata);
    assert.deepEqual(
      result.golden.writes.map(({ curve }) => curve),
      ids,
    );
    assert.deepEqual(result.warnings, []);
  }
});

test('address override works without enumeration and refuses ambiguous automatic identification', () => {
  assert.equal(
    captureGolden(write(), { ...metadata, address: '01.007' }).golden.writes[0].curve,
    'padrao',
  );
  assert.throws(() => captureGolden(write(), metadata), /0 matching.*--address/);
  const second = clone(interrupt[0]);
  second._source.layers.usb['usb.device_address'] = '8';
  const input = capture([second, ...write()]);
  assert.throws(() => captureGolden(input, metadata), /2 matching.*--address/);
  assert.equal(captureGolden(input, { ...metadata, address: '1.7' }).golden.writes.length, 1);
  assert.throws(() => captureGolden(input, { ...metadata, address: '7' }), /bus.dev/);
});

test('missing fields and malformed hex are skipped with counted warnings, not crashes', () => {
  const broken = [];
  for (const name of [
    'usb.bus_id',
    'usb.device_address',
    'usb.endpoint_address',
    'usb.transfer_type',
  ]) {
    const p = write()[0];
    delete p._source.layers.usb[name];
    broken.push(p);
  }
  for (const value of ['bad!', 'c', 'cb:zz']) {
    const p = write()[0];
    p._source.layers.usbhid['usbhid.data'] = value;
    broken.push(p);
  }
  const noPayload = write()[0];
  delete noPayload._source.layers.usbhid;
  const noIndex = write('padrao', 'control')[0];
  delete noIndex._source.layers.usb['usb.setup']['usb.setup.wIndex'];
  for (const name of ['usb.setup.bmRequestType', 'usb.setup.bRequest', 'usb.setup.wValue']) {
    const p = write('padrao', 'control')[0];
    delete p._source.layers.usb['usb.setup'][name];
    broken.push(p);
  }
  const result = captureGolden(
    capture([null, {}, ...broken, noPayload, noPayload, noIndex, ...write()]),
    metadata,
  );
  assert.equal(result.golden.writes.length, 1);
  assert.equal(warningCount(result, /missing bus\/device/), 2);
  assert.equal(warningCount(result, /missing payload/), 2);
  assert.equal(warningCount(result, /malformed payload/), 3);
  assert.equal(warningCount(result, /missing endpoint/), 1);
  assert.equal(warningCount(result, /missing transfer/), 1);
  assert.equal(warningCount(result, /wIndex/), 1);
  assert.equal(warningCount(result, /missing control setup/), 3);
});

test('singleton field arrays, nested setup, colon hex and separate HID report ID are tolerated', () => {
  const input = write();
  for (const p of input) {
    const hid = p._source.layers.usbhid;
    hid['usbhid.report_id'] = ['0xcb'];
    hid['usbhid.data'] = [hid['usbhid.data'].slice(2).match(/../g).join(':').toUpperCase()];
    for (const [key, value] of Object.entries(p._source.layers.usb))
      p._source.layers.usb[key] = [value];
  }
  assert.equal(
    captureGolden(capture(input), metadata).golden.writes[0].reports[0],
    frame(dataFor('padrao')[0], 32),
  );
});

test('incomplete writes are discarded at restart, commit and EOF without mixing streams', () => {
  const full = write();
  const result = captureGolden(
    capture([...full.slice(0, 2), ...full, ...full.slice(0, 3), full[9], ...full.slice(0, 1)]),
    metadata,
  );
  assert.equal(result.golden.writes.length, 1);
  assert.equal(warningCount(result, /incomplete write/), 3);
  assert.throws(
    () =>
      captureGolden(
        capture([...write().slice(0, 4), ...write('padrao', 'control').slice(4)]),
        metadata,
      ),
    /No complete valid writes/,
  );
  assert.throws(
    () => captureGolden(capture(full.slice(0, 9)), metadata),
    /No complete valid writes.*incomplete/,
  );
});

test('out-of-order curves are matched and preserved, with a warning instead of sorting', () => {
  const result = captureGolden(
    capture([...write('neutro'), ...write('emv'), ...write('padrao')]),
    metadata,
  );
  assert.deepEqual(
    result.golden.writes.map(({ curve }) => curve),
    ['neutro', 'emv', 'padrao'],
  );
  assert.equal(warningCount(result, /out-of-order curve/), 2);
});

test('unknown curves fail closed; nonzero padding is not silently stripped', () => {
  const unknown = write();
  const hid = unknown[2]._source.layers.usbhid;
  hid['usbhid.data'] = hid['usbhid.data'].slice(0, -2) + 'ff';
  assert.throws(() => captureGolden(capture(unknown), metadata), /does not match any reference/);
  const invalidPadding = write('padrao', 'interrupt', 64);
  const bad = invalidPadding[1]._source.layers.usbhid;
  bad['usbhid.data'] = bad['usbhid.data'].slice(0, -2) + '01';
  const result = captureGolden(capture([...invalidPadding, ...write()]), metadata);
  assert.equal(result.golden.writes.length, 1);
  assert.equal(warningCount(result, /nonzero padding/), 1);
  assert.throws(
    () => captureGolden(capture([...write(), ...write('emv', 'control')]), metadata),
    /Mixed transfer/,
  );
  assert.throws(
    () => captureGolden(capture([...write(), ...write('emv', 'interrupt', 64)]), metadata),
    /Mixed transfer/,
  );
  const shortCommit = write();
  shortCommit[9]._source.layers.usbhid['usbhid.data'] = 'cb01650001ff';
  assert.throws(() => captureGolden(capture(shortCommit), metadata), /Mixed transfer/);
});

test('compare supports the actual diagnostics export and raw array, ignoring only timestamps', () => {
  const { golden } = captureGolden(control, metadata);
  const log = appLog(golden);
  log[0].atMs = 0;
  assert.deepEqual(compareWireLog(log, golden), []);
  assert.deepEqual(
    compareWireLog({ wireLog: log, transfer: 'control', paddedLength: 64, device: {} }, golden),
    [],
  );
  assert.match(
    compareWireLog({ wireLog: log, paddedLength: 32, transfer: 'interrupt' }, golden).join('\n'),
    /transfer: expected control.*\npaddedLength: expected 64/,
  );
});

test('compare reports report bytes, commit, IDs, padding, missing/extra buffers and malformed entries', () => {
  const { golden } = captureGolden(control, metadata);
  const equal = appLog(golden);
  for (const [index, byte] of [
    [0, 0],
    [3, 7],
    [9, 2],
    [0, 63],
  ]) {
    const log = clone(equal);
    const offset = byte * 2;
    log[index].hex = log[index].hex.slice(0, offset) + 'ab' + log[index].hex.slice(offset + 2);
    assert.match(
      compareWireLog(log, golden).join('\n'),
      new RegExp(`${index === 9 ? 'commit' : `report ${index}`}: byte ${byte} expected`),
    );
  }
  const short = clone(equal);
  short[0].hex = short[0].hex.slice(0, 64);
  assert.match(compareWireLog(short, golden).join('\n'), /padded length expected 64, got 32/);
  assert.match(compareWireLog(equal.slice(0, -1), golden).join('\n'), /commit: missing/);
  assert.match(compareWireLog([...equal, equal[0]], golden).join('\n'), /extra buffer/);
  const malformed = clone(equal);
  malformed[0] = { atMs: NaN, hex: 'not hex' };
  assert.match(
    compareWireLog(malformed, golden).join('\n'),
    /invalid atMs\nbuffer 1: malformed hex/,
  );
  assert.throws(() => compareWireLog({ reports: [] }, golden), /wireLog/);
  for (const invalid of [
    null,
    {},
    { ...golden, writes: [] },
    { ...golden, paddedLength: 31 },
    { ...golden, writes: [{ curve: 'padrao', reports: [] }] },
  ]) {
    assert.throws(() => compareWireLog(equal, invalid), /Invalid golden/);
  }
});

function cliFixture(t) {
  const dir = mkdtempSync(join(directory, '.run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const json = (name, value) => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const run = (args) =>
    spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  const out = join(dir, 'golden.json');
  const flags = [
    '--out',
    out,
    '--captured-on',
    metadata.capturedOn,
    '--os',
    metadata.os,
    '--browser',
    metadata.browser,
  ];
  return { dir, json, run, out, flags };
}

test('CLI emits deterministic JSON with CLI provenance and counted warnings; compare exits 0 or 1', (t) => {
  const f = cliFixture(t);
  const input = f.json('capture.json', capture([...write(), ...write().slice(0, 2)]));
  const first = f.run([input, ...f.flags]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Validated 1\/12 writes, interrupt, 32 bytes/);
  assert.match(first.stderr, /Warning \(1\): incomplete write discarded/);
  const bytes = readFileSync(f.out, 'utf8');
  const second = f.run([input, ...f.flags]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.equal(second.stderr, first.stderr);
  assert.equal(readFileSync(f.out, 'utf8'), bytes);
  const golden = JSON.parse(bytes);
  assert.deepEqual(Object.keys(golden), [
    'capturedOn',
    'os',
    'browser',
    'transfer',
    'paddedLength',
    'writes',
  ]);
  assert.equal(golden.capturedOn, metadata.capturedOn);
  const log = appLog(golden);
  const file = f.json('wire-log.json', { wireLog: log, paddedLength: 32, transfer: 'interrupt' });
  assert.equal(f.run(['--compare', file, '--golden', f.out]).status, 0);
  log[9].hex = log[9].hex.slice(0, -2) + 'ff';
  f.json('wire-log.json', log);
  const unequal = f.run(['--compare', file, '--golden', f.out]);
  assert.equal(unequal.status, 1);
  assert.match(unequal.stderr, /write 1 \(padrao\) commit: byte 31/);
});

test('CLI failures never overwrite an existing golden; help and invalid arguments are explicit', (t) => {
  const f = cliFixture(t);
  const bad = f.json('bad.json', capture(write().slice(0, 2)));
  writeFileSync(f.out, 'keep existing golden');
  assert.equal(f.run([bad, ...f.flags]).status, 1);
  assert.equal(readFileSync(f.out, 'utf8'), 'keep existing golden');
  assert.equal(f.run(['--help']).status, 0);
  for (const args of [
    [],
    ['--what'],
    ['--compare'],
    ['capture.json'],
    ['x', ...f.flags, '--out', 'y'],
    ['x', ...f.flags, '--interface', '256'],
    ['x', ...f.flags, '--address', '1.999'],
    ['--compare', 'x', '--out', 'y'],
    ['x', ...f.flags, '--golden', 'y'],
  ]) {
    assert.throws(() => parseArgs(args), /Usage:|Invalid --interface|out of range/);
    assert.equal(f.run(args).status, 1);
  }
  assert.throws(() => captureGolden({}, metadata), /JSON array/);
});
