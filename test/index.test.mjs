import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as core from 'open-auri';
import * as dsp from 'open-auri/dsp';
import * as safety from 'open-auri/safety';
import * as share from 'open-auri/share';
import * as io from 'open-auri/io';
import * as solver from 'open-auri/solver';
import * as catalog from 'open-auri/catalog';
import * as transport from 'open-auri/transport';
import * as policy from 'open-auri/policy';
import * as meter from 'open-auri/meter';

const areas = {
  dsp: {
    api: dsp,
    members: ['eq0xcb', 'grid', 'level', 'distance', 'iso226'],
    duplicates: {},
  },
  safety: {
    api: safety,
    members: ['gate', 'policy', 'thresholds', 'classify'],
    // gate forwards these bindings; the area index exports them from thresholds only.
    duplicates: {
      THRESHOLDS: 'thresholds',
      PROVENANCE: 'thresholds',
      YOLO_THRESHOLDS: 'thresholds',
    },
  },
  share: { api: share, members: ['s1', 'envelope'], duplicates: {} },
  io: { api: io, members: ['equalizer-apo', 'measurement'], duplicates: {} },
  solver: { api: solver, members: ['peq'], duplicates: {} },
  catalog: { api: catalog, members: ['presets'], duplicates: {} },
  transport: { api: transport, members: ['webhid', 'fake-device'], duplicates: {} },
  policy: { api: policy, members: ['flash', 'loudness', 'journal'], duplicates: {} },
  meter: {
    api: meter,
    members: ['ballistics', 'truepeak', 'loudness', 'correlation', 'common'],
    duplicates: {},
  },
};

const curated = {
  encodePayload: dsp.encodePayload,
  encodeReports: dsp.encodeReports,
  commitReport: dsp.commitReport,
  magnitudeDb: dsp.magnitudeDb,
  gate: safety.gate,
  gateForWrite: safety.gateForWrite,
  autoPreamp: safety.autoPreamp,
  levelDb: dsp.levelDb,
  encodeS1: share.encodeS1,
  decodeS1: share.decodeS1,
  curveId: share.curveId,
  validateEnvelope: share.validateEnvelope,
  parseEqualizerApo: io.parseEqualizerApo,
  serializeEqualizerApo: io.serializeEqualizerApo,
  solvePeq: solver.solvePeq,
  OFFICIAL_PRESETS: catalog.OFFICIAL_PRESETS,
  NEUTRO: catalog.NEUTRO,
  PADRAO_AURI: catalog.PADRAO_AURI,
  writeCurve: transport.writeCurve,
  requestCable: transport.requestCable,
};

test('package self-reference exposes all nine area namespaces', () => {
  assert.equal(Object.keys(areas).length, 9);
  for (const [area, { api }] of Object.entries(areas)) {
    assert.equal(typeof core[area], 'object', area);
    assert.equal(core[area], api, `open-auri/${area}`);
  }
});

test('root exports exactly the area namespaces and curated functions/objects', () => {
  assert.equal(Object.keys(curated).length, 20);
  assert.deepEqual(
    Object.keys(core).sort(),
    [...Object.keys(areas), ...Object.keys(curated)].sort(),
  );
  for (const [name, value] of Object.entries(curated)) {
    assert.notEqual(core[name], null, name);
    assert.equal(typeof core[name], name in catalog ? 'object' : 'function', name);
    assert.equal(core[name], value, name);
  }
});

for (const [area, { api, members, duplicates }] of Object.entries(areas)) {
  test(`open-auri/${area} exports every member binding without undocumented collisions`, async () => {
    const bindings = new Map();
    for (const member of members) {
      const module = await import(new URL(`../src/${area}/${member}.mjs`, import.meta.url));
      for (const [name, value] of Object.entries(module)) {
        if (!bindings.has(name)) bindings.set(name, []);
        bindings.get(name).push({ member, value });
      }
    }

    assert.deepEqual(Object.keys(api).sort(), [...bindings.keys()].sort());
    const observedDuplicates = [];
    for (const [name, providers] of bindings) {
      if (providers.length > 1) {
        observedDuplicates.push(name);
        assert.ok(
          providers.some(({ member }) => member === duplicates[name]),
          `${area}.${name} must have a documented owning module`,
        );
      }
      for (const { member, value } of providers) {
        assert.equal(api[name], value, `${area}.${name} from ${member}`);
      }
    }
    assert.deepEqual(observedDuplicates.sort(), Object.keys(duplicates).sort());
  });
}

test('safety preserves the level helpers from their DSP owner', async () => {
  const level = await import('../src/dsp/level.mjs');
  for (const name of ['levelDb', 'MEAN_FREQUENCIES', 'sectionDb']) {
    assert.equal(safety[name], level[name], name);
    assert.equal(safety[name], dsp[name], name);
  }
});

test('a cold root import adds no globals', () => {
  // Static imports above are already cached, so verify a first import in a fresh Node process.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        const before = Reflect.ownKeys(globalThis);
        await import('open-auri');
        assert.deepEqual(Reflect.ownKeys(globalThis), before);
      `,
    ],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '', 'import must not write to stdout');
  assert.equal(result.stderr, '', 'import must not write to stderr');
});
