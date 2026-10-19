// Filter labels (open-auri/preset@2) are presentation only: the gate verdict, the
// exact payload bytes, S1, curveId and canonKey never depend on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import {
  LABEL_COUNT,
  envelopeFormat,
  normalizeLabels,
  parseEnvelope,
  serializeEnvelope,
  validateEnvelope,
} from '../../src/share/envelope.mjs';
import { canonKey, curveId, decodeS1, encodeS1 } from '../../src/share/s1.mjs';
import { gateForWrite } from '../../src/safety/gate.mjs';

const { presets } = JSON.parse(
  readFileSync(new URL('../fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);

// The S1 v2 golden (docs/s1-format.md): padrao with band 6 cut at 25 kHz. It travels
// in open-auri/preset@2 with or without labels.
const padraoV2 = {
  eqBands: presets.padrao.eqBands.map((/** @type {object} */ band, /** @type {number} */ index) =>
    index === 6 ? { kind: 'PK', freqHz: 25000, gainDb: -3, qFactor: 1 } : band,
  ),
  preampDb: presets.padrao.preampDb,
};

/**
 * The lowest format for the curve without labels (`@1`, or `@2` for an S1 v2 curve).
 * @param {{eqBands: object[], preampDb: number}} preset
 */
const envelopeOf = (preset) => ({
  format: envelopeFormat({ bands: preset.eqBands }),
  name: 'Curva',
  description: '',
  source: 'custom',
  license: 'CC0-1.0',
  code: encodeS1({ bands: preset.eqBands, preampDb: preset.preampDb }),
  preampDb: preset.preampDb,
  bands: preset.eqBands,
  lang: 'pt-BR',
  createdAt: '2026-10-18T12:00:00.000Z',
});

// Official curves that are valid publication data, plus the S1 v2 golden.
const curves = [...Object.values(presets), padraoV2].filter(
  (preset) => validateEnvelope(envelopeOf(preset)).ok,
);

test('fixture curves are available for the identity property, an S1 v2 curve included', () => {
  assert.ok(curves.length >= 4, String(curves.length));
  assert.ok(curves.includes(padraoV2));
  assert.equal(envelopeOf(padraoV2).format, 'open-auri/preset@2');
  assert.equal(decodeS1(envelopeOf(padraoV2).code).version, 2);
  assert.equal(envelopeOf(presets.padrao).format, 'open-auri/preset@1');
});

test('gate verdict, payload bytes, S1, curveId and canonKey ignore labels', async () => {
  const labelArbitrary = fc.array(fc.option(fc.string({ maxLength: 30 }), { nil: null }), {
    minLength: LABEL_COUNT,
    maxLength: LABEL_COUNT,
  });
  await fc.assert(
    fc.asyncProperty(fc.constantFrom(...curves), labelArbitrary, async (preset, raw) => {
      // Any label list the editor could hold, falling back to one fixed label.
      const labels =
        normalizeLabels(raw, { lenient: true }) ??
        Array.from({ length: LABEL_COUNT }, (_, index) => (index === 0 ? 'Grave' : null));
      const plain = parseEnvelope(serializeEnvelope(envelopeOf(preset)));
      const named = parseEnvelope(
        serializeEnvelope({ ...envelopeOf(preset), format: 'open-auri/preset@2', labels }),
      );
      assert.equal(plain.ok, true);
      assert.equal(named.ok, true);
      if (!plain.ok || !named.ok) return;
      assert.equal(named.value.format, envelopeFormat({ bands: preset.eqBands, labels }));
      assert.deepEqual(named.value.labels, labels);
      assert.equal(named.value.code, plain.value.code);
      assert.equal(named.value.preampDb, plain.value.preampDb);
      assert.deepEqual(named.value.bands, plain.value.bands);
      const s1 = encodeS1({ bands: named.value.bands, preampDb: named.value.preampDb });
      assert.equal(s1, encodeS1({ bands: plain.value.bands, preampDb: plain.value.preampDb }));
      assert.equal(s1, plain.value.code);
      assert.equal(await curveId(named.value.code), await curveId(plain.value.code));
      assert.equal(
        canonKey(named.value.bands, named.value.preampDb),
        canonKey(plain.value.bands, plain.value.preampDb),
      );
      for (const experimental of [false, true]) {
        const withLabels = gateForWrite(named.value.bands, named.value.preampDb, { experimental });
        const withoutLabels = gateForWrite(plain.value.bands, plain.value.preampDb, {
          experimental,
        });
        assert.equal(withLabels.ok, withoutLabels.ok);
        assert.deepEqual(withLabels.reasons, withoutLabels.reasons);
        assert.deepEqual(withLabels.metrics.payload, withoutLabels.metrics.payload);
        assert.deepEqual(withLabels, withoutLabels);
      }
    }),
    { numRuns: 60 },
  );
});
