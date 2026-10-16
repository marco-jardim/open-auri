#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { designSection, encodeSection, encodePayload, OFF } from '../../src/dsp/eq0xcb.mjs';
import { gate, levelDb, analyseSection, autoPreampForSection, THRESHOLDS, Q27, MEAN_FREQUENCIES } from './gate.mjs';

const fixtureText = await readFile(new URL('../../test/fixtures/eq0xcb.reference.json', import.meta.url), 'utf8');
const fixture = JSON.parse(fixtureText);
const envelope = JSON.parse(await readFile(new URL('./envelope.json', import.meta.url), 'utf8'));
assert.equal(createHash('sha256').update(fixtureText).digest('hex'), envelope.metadata.fixtureSha256);
const unique = (values) => [...new Set(values)].sort((a, b) => a - b);
const log = (min, max, n) => Array.from({ length: n }, (_, i) => i === n - 1 ? max : min * (max / min) ** (i / (n - 1)));
const frequencies = unique([...log(20, 20000, 151), 25, 30, 35, 40, 50, 80, 100, 150, 200, 300, 500, 1000, 2000, 4000, 8000, 10000, 16000]);
const qs = unique([...log(0.1, 20, 81), 0.5, 0.707, 0.7, 1, 2, 4, 10]);
const gains = Array.from({ length: 391 }, (_, i) => Number((-24 + i / 10).toFixed(1)));
const sampleGains = [-24, -12, 0, 2, 6, 9, 9.2];
const neutral = (band = OFF) => Array.from({ length: 10 }, () => ({ ...band }));
const single = (band) => [band, ...neutral().slice(1)];

const proof = [];
let pkSymmetryFailures = 0, pkCount = 0, analyticMaxError = 0;
for (const [id, p] of Object.entries(fixture.presets)) p.eqBands.forEach((band, i) => {
  const words = encodeSection(designSection(band));
  // PK constraints in Q27 integer arithmetic: b1=a1 and b0+b2=1+a2.
  const b1MinusA1Words = words[3] + words[2];
  const dcSymmetryResidualWords = words[0] + words[1] - Q27 + words[4];
  if (band.kind === 'LS') proof.push({ preset: id, stage: i + 1, band, words,
    b1MinusA1Words, b1MinusA1: b1MinusA1Words / Q27,
    dcSymmetryResidualWords, dcSymmetryResidual: dcSymmetryResidualWords / Q27 });
  else { pkCount++; if (b1MinusA1Words !== 0) pkSymmetryFailures++; }
  analyticMaxError = Math.max(analyticMaxError,
    Math.abs(analyseSection(band).fullPeak.db - envelope.presets[id].sections[i].quantizedSinglePeak.db));
});
assert.equal(pkSymmetryFailures, 0);
assert.ok(proof.every((s) => s.b1MinusA1Words !== 0 && s.dcSymmetryResidualWords !== 0));
assert.ok(analyticMaxError < 1e-8);

const validation = {}, orderValidation = { frequency: [], reversed: [] };
for (const [id, p] of Object.entries(fixture.presets)) {
  const g = gate(p.eqBands, p.preampDb);
  assert.ok(g.ok, `${id}: ${g.reasons}`);
  validation[id] = { ok: g.ok, internalAudibleDb: g.metrics.internalAudible.db,
    outputAudibleDb: g.metrics.outputAudible.db, outputFullDb: g.metrics.outputFull.db };
  for (const [key, bands] of [
    ['frequency', [...p.eqBands].sort((a, b) => a.freqHz - b.freqHz)],
    ['reversed', [...p.eqBands].reverse()],
  ]) {
    const v = gate(bands, p.preampDb);
    orderValidation[key].push({ preset: id, ok: v.ok, reasons: v.reasons, internalAudibleDb: v.metrics.internalAudible.db });
  }
}
assert.ok(orderValidation.reversed.every((v) => v.reasons.includes('d:internal-audible')));
assert.ok(orderValidation.frequency.find((v) => v.preset === 'harman').reasons.includes('d:internal-audible'));
assert.ok(orderValidation.frequency.filter((v) => !v.ok).length >= 7);
const neutralResults = {};
for (const [id, bands] of [
  ['neutro_OFF', neutral()],
  ['neutro_PK', neutral({ kind: 'PK', freqHz: 1000, gainDb: 0, qFactor: 0.707 })],
]) {
  const g = gate(bands, -0.5);
  assert.ok(g.ok);
  neutralResults[id] = { eqBands: bands, preampDb: -0.5, crc: g.metrics.payloadCrc,
    payload: encodePayload(bands, -0.5), ok: g.ok, levelDb: levelDb(bands, -0.5),
    poleRadius: g.metrics.sections[0].poleRadius, wireWords: g.metrics.sections[0].words,
    outputDb: g.metrics.outputAudible.db };
}
// Verify the reconstructed Kuba measurement frequency lattice, when the temp
// dump from the preceding task is present. Never execute its source here.
let meanGridMatchesOfficial = 'not checked (temp dump absent)';
try {
  const html = await readFile(join(tmpdir(), "Claude", "kuba-dump", "template.html"), 'utf8');
  const actual = JSON.parse(html.match(/const MEAS = \{ auri: \{"f":(\[[^\]]+\])/)[1]);
  assert.deepEqual(actual.filter((f) => f >= 300 && f <= 3000), [...MEAN_FREQUENCIES]);
  meanGridMatchesOfficial = true;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const levels = Object.fromEntries(Object.entries(fixture.presets).map(([id, p]) => [id, levelDb(p.eqBands, p.preampDb)]));
Object.assign(levels, Object.fromEntries(Object.entries(neutralResults).map(([id, n]) => [id, n.levelDb])));
const levelIds = Object.keys(levels);
const jumps = Object.fromEntries(levelIds.map((from) => [from,
  Object.fromEntries(levelIds.map((to) => [to, levels[to] - levels[from]]))]));
let largestJump = { db: -Infinity };
for (const from of levelIds) for (const to of levelIds) if (jumps[from][to] > largestJump.db) largestJump = { from, to, db: jumps[from][to] };

console.log(JSON.stringify({ thresholds: THRESHOLDS, pkCount, lowShelfCount: proof.length,
  analyticMaxError, officialPasses: Object.keys(validation).length,
  frequencyOrderFailures: orderValidation.frequency.filter((v) => !v.ok).length,
  reversedOrderFailures: orderValidation.reversed.filter((v) => !v.ok).length,
  neutralCrcs: Object.fromEntries(Object.entries(neutralResults).map(([id, n]) => [id, n.crc])), largestJump }, null, 2));

const sweep = {};
let gateSpotChecks = 0;
for (const kind of ['PK', 'LS', 'HS', 'LP', 'HP']) {
  const kindGains = ['LP', 'HP'].includes(kind) ? [0] : gains;
  const stats = { tested: 0, accepted: 0, failures: {}, deepestCut: null, highestBoost: null,
    maxQ: null, perFrequency: [], perQ: qs.map((q) => ({ q, minimumFrequencyHz: null, maximumFrequencyHz: null })) };
  for (const f of frequencies) {
    const row = { frequencyHz: f, minGainDb: null, maxGainDb: null, minQ: null, maxQ: null,
      qByGain: Object.fromEntries(sampleGains.map((g) => [g, { min: null, max: null }])) };
    for (const [qi, q] of qs.entries()) for (const gain of kindGains) {
      const band = { kind, freqHz: f, gainDb: gain, qFactor: q };
      stats.tested++;
      let metrics;
      try { metrics = analyseSection(band); }
      catch (error) { stats.failures['f:codec'] = (stats.failures['f:codec'] ?? 0) + 1; continue; }
      const preamp = metrics.reasons.length ? null : autoPreampForSection(metrics);
      const reasons = [...metrics.reasons];
      if (!reasons.length && preamp === null) reasons.push('g:preamp-floor');
      for (const reason of reasons) stats.failures[reason] = (stats.failures[reason] ?? 0) + 1;
      if (reasons.length) continue;
      stats.accepted++;
      const location = { gainDb: gain, frequencyHz: f, qFactor: q, preampDb: preamp };
      if (stats.deepestCut === null || gain < stats.deepestCut.gainDb) stats.deepestCut = location;
      if (stats.highestBoost === null || gain > stats.highestBoost.gainDb) stats.highestBoost = location;
      if (stats.maxQ === null || q > stats.maxQ.qFactor) stats.maxQ = location;
      row.minGainDb = row.minGainDb === null ? gain : Math.min(row.minGainDb, gain);
      row.maxGainDb = row.maxGainDb === null ? gain : Math.max(row.maxGainDb, gain);
      row.minQ = row.minQ === null ? q : Math.min(row.minQ, q);
      row.maxQ = row.maxQ === null ? q : Math.max(row.maxQ, q);
      if (sampleGains.includes(gain)) {
        const entry = row.qByGain[gain];
        entry.min = entry.min === null ? q : Math.min(entry.min, q);
        entry.max = entry.max === null ? q : Math.max(entry.max, q);
      }
      const qRow = stats.perQ[qi];
      qRow.minimumFrequencyHz ??= f;
      qRow.maximumFrequencyHz = f;
      // Equivalent single-active-section optimization is checked against the
      // full ten-band gate throughout the sweep, not assumed silently.
      if ((stats.accepted % 100000 === 0) || stats.accepted === 1) {
        const g = gate(single(band), preamp);
        assert.ok(g.ok, `${kind} sweep/gate mismatch ${JSON.stringify(band)} ${g.reasons}`);
        gateSpotChecks++;
      }
    }
    stats.perFrequency.push(row);
  }
  sweep[kind] = stats;
  console.log(JSON.stringify({ kind, tested: stats.tested, accepted: stats.accepted, deepestCut: stats.deepestCut,
    highestBoost: stats.highestBoost, maxQ: stats.maxQ, failures: stats.failures }));
}

const hpExamples = [];
for (const f of [20, 25, 30, 35]) for (const q of [0.5, 0.707]) {
  const band = { kind: 'HP', freqHz: f, gainDb: 0, qFactor: q }, g = gate(single(band), -0.5);
  hpExamples.push({ frequencyHz: f, qFactor: q, ok: g.ok, reasons: g.reasons,
    poleRadius: g.metrics.sections[0].poleRadius, words: g.metrics.sections[0].words });
}
const softRanges = [
  { id: 'PK-main', kind: 'PK', freqHz: [150, 20000], gainDb: [-24, 6], qFactor: [1, 2] },
  { id: 'PK-narrow', kind: 'PK', freqHz: [300, 20000], gainDb: [-24, 9], qFactor: [2, 4] },
  { id: 'LS', kind: 'LS', freqHz: [80, 1000], gainDb: [-24, 6], qFactor: [0.5, 0.7] },
  { id: 'HS-cut', kind: 'HS', freqHz: [80, 20000], gainDb: [-24, 0], qFactor: [0.5, 0.7] },
  { id: 'HS-boost', kind: 'HS', freqHz: [8000, 20000], gainDb: [-24, 2], qFactor: [0.5, 0.7] },
  { id: 'LP', kind: 'LP', freqHz: [30, 20000], gainDb: [0, 0], qFactor: [0.5, 0.7] },
  { id: 'HP', kind: 'HP', freqHz: [50, 20000], gainDb: [0, 0], qFactor: [0.5, 0.7] },
];
for (const box of softRanges) {
  const fs = log(...box.freqHz, 81), qValues = log(...box.qFactor, 41);
  const gs = Array.from({ length: Math.round((box.gainDb[1] - box.gainDb[0]) * 10) + 1 }, (_, i) => Number((box.gainDb[0] + i / 10).toFixed(1)));
  let tested = 0, violations = 0;
  const margins = { coefficientWords: Infinity, poleRadius: Infinity, sectionPeakDb: Infinity };
  for (const f of fs) for (const q of qValues) for (const gain of gs) {
    const m = analyseSection({ kind: box.kind, freqHz: f, gainDb: gain, qFactor: q });
    tested++;
    if (m.reasons.length || autoPreampForSection(m) === null) violations++;
    m.words.forEach((w, i) => { margins.coefficientWords = Math.min(margins.coefficientWords, THRESHOLDS.coefficientAbsWords[i] - Math.abs(w)); });
    margins.poleRadius = Math.min(margins.poleRadius, THRESHOLDS.poleRadius - m.poleRadius);
    margins.sectionPeakDb = Math.min(margins.sectionPeakDb, THRESHOLDS.sectionPeakDb - m.fullPeak.db);
  }
  box.validation = { tested, violations, margins };
  assert.equal(violations, 0, `soft range ${box.id} contains failures`);
}

const output = {
  metadata: { node: process.version, generatedAt: new Date().toISOString(), fixtureSha256: envelope.metadata.fixtureSha256,
    templateSha256: envelope.metadata.templateSha256,
    interpretation: 'Observed-envelope heuristic, not firmware safety proof; types are invisible but hidden-state/transient bounds remain unknown.' },
  thresholds: THRESHOLDS, preampPolicy: { minDb: -25.5, maxDb: -0.5, stepDb: 0.1,
    floorReason: 'S1 compact format, still strictly positive Q23 word; usability floor rather than measured chip boundary' },
  proof: { lowShelves: proof, pkCount, pkB1EqualityFailures: pkSymmetryFailures },
  validation: { official: validation, reordered: orderValidation, analyticSectionPeakMaxDifferenceDb: analyticMaxError,
    gateSpotChecks, meanGridMatchesOfficial, meanFrequencyCount: MEAN_FREQUENCIES.length },
  sweep: { frequenciesHz: frequencies, qFactors: qs, gainsDb: gains,
    passFiltersGainNote: 'LP/HP have no gain parameter; each f/Q cell evaluated once, equivalent to every ignored gain label.', kinds: sweep },
  softRanges, hpExamples, neutrals: neutralResults,
  loudness: { method: 'Unweighted arithmetic mean dB on the official 280-point log frequency lattice restricted to 300–3000 Hz; includes Q23 preamp and Q27 response.',
    levelsDb: levels, matrixConvention: 'row=old/from, column=new/to; positive means louder', jumpDb: jumps,
    largestPositiveJump: largestJump, warningThresholdDb: 3,
    unknownCurrentPolicy: 'Always warn when current on-cable curve is unknown: browser localStorage is not readback.' },
};
await writeFile(new URL('./limites-v2.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ gateSpotChecks, hpExamples, softRanges, largestJump,
  totalSweepCases: Object.values(sweep).reduce((n, s) => n + s.tested, 0) }, null, 2));
