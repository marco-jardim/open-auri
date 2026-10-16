#!/usr/bin/env node
// Derived numeric analysis only. No downloaded implementation is executed here.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  designSection, encodeSection, encodePayload, isStable, magnitudeDb, preampWord, SAMPLE_RATE,
} from '../../src/dsp/eq0xcb.mjs';

const fixturePath = new URL('../../test/fixtures/eq0xcb.reference.json', import.meta.url);
const fixtureText = await readFile(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);
const Q27 = 2 ** 27;
const positions = ['b0', 'b2', '-a1', 'b1', '-a2'];
const ordered = (s) => [s.b0, s.b2, -s.a1, s.b1, -s.a2];
const fromWords = (w) => ({ b0: w[0] / Q27, b2: w[1] / Q27,
  a1: -w[2] / Q27, b1: w[3] / Q27, a2: -w[4] / Q27 });
function poleRadius({ a1, a2 }) {
  const discriminant = a1 * a1 - 4 * a2;
  return discriminant < 0 ? Math.sqrt(a2)
    : Math.max(Math.abs((-a1 + Math.sqrt(discriminant)) / 2), Math.abs((-a1 - Math.sqrt(discriminant)) / 2));
}

// Same stable polynomial form as the codec's magnitudeDb; coefficients are
// predesigned so we can also evaluate Q27-quantized sections without redesign.
function sectionDb(s, frequency) {
  const omega = 2 * Math.PI * frequency / SAMPLE_RATE;
  const re = 2 * Math.sin(omega / 2) ** 2, im = Math.sin(omega);
  const u2re = re * re - im * im, u2im = 2 * re * im;
  const power = (p0, p1, p2) => {
    const sum = p0 + p1 + p2, slope = p1 + 2 * p2;
    const r = sum - slope * re + p2 * u2re;
    const i = -slope * im + p2 * u2im;
    return r * r + i * i;
  };
  return 10 * Math.log10(power(s.b0, s.b1, s.b2) / power(1, s.a1, s.a2));
}
const domains = {
  audible: { minHz: 20, maxHz: 20000 },
  extended: { minHz: 20, maxHz: 48000 },
  full: { minHz: 0, maxHz: 48000 },
};
const intervals = 16384;
function grid(domain) {
  const lo = domain.minHz || 0.001;
  const frequencies = Array.from({ length: intervals + 1 }, (_, i) => lo * (domain.maxHz / lo) ** (i / intervals));
  frequencies[0] = lo; frequencies[intervals] = domain.maxHz;
  if (domain.minHz === 0) frequencies.unshift(0);
  return frequencies;
}
const grids = Object.fromEntries(Object.entries(domains).map(([key, value]) => [key, grid(value)]));
function refine(fn, a, b) {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let c = b - ratio * (b - a), d = a + ratio * (b - a);
  let fc = fn(c), fd = fn(d);
  for (let i = 0; i < 70 && b - a > 1e-8; i++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - ratio * (b - a); fc = fn(c); }
    else { a = c; c = d; fc = fd; d = a + ratio * (b - a); fd = fn(d); }
  }
  return fc > fd ? { db: fc, frequencyHz: c } : { db: fd, frequencyHz: d };
}
function peak(fn, domain) {
  const frequencies = grids[domain];
  const values = frequencies.map(fn);
  let best = { db: values[0], frequencyHz: frequencies[0] };
  for (let i = 1; i < values.length; i++) {
    if (values[i] > best.db) best = { db: values[i], frequencyHz: frequencies[i] };
    if (i < values.length - 1 && values[i] > values[i - 1] && values[i] >= values[i + 1]) {
      const candidate = refine(fn, frequencies[i - 1], frequencies[i + 1]);
      if (candidate.db > best.db) best = candidate;
    }
  }
  return best;
}
function cascade(sections, preampDb, domain) {
  const stages = [{ stage: 0, db: preampDb, frequencyHz: null }];
  for (let count = 1; count <= sections.length; count++) {
    const prefix = sections.slice(0, count);
    stages.push({ stage: count, ...peak((f) => prefix.reduce((db, s) => db + sectionDb(s, f), preampDb), domain) });
  }
  return { stages, internalPeak: stages.reduce((a, b) => b.db > a.db ? b : a), outputPeak: stages.at(-1) };
}

const result = {
  metadata: { node: process.version, generatedAt: new Date().toISOString(), sampleRate: SAMPLE_RATE,
    fixtureSha256: createHash('sha256').update(fixtureText).digest('hex'),
    templateSha256: fixture._provenance.templateSha256, coefficientOrder: positions,
    q27Limit: 16, domains, logGridIntervals: intervals, refinementIterations: 70,
    refinementToleranceHz: 1e-8,
    note: 'Sinusoidal prefix transfer peaks, preamp included; not time-domain state bounds or hardware proof.' },
  validation: {}, presets: {}, aggregate: {},
};
let count = 0;
const maxima = positions.map((position) => ({ position, absCoefficient: 0 }));
const quantizedMaxima = positions.map((position) => ({ position, absCoefficient: 0 }));
let maxPole = { radius: 0 }, maxQuantizedPole = { radius: 0 }, maxSection = { db: -Infinity };
const orderWorst = Object.fromEntries(['reference', 'frequency', 'reversed'].map((key) => [key, { db: -Infinity }]));
const orderAboveZero = { reference: 0, frequency: 0, reversed: 0 };
const aggregatePeaks = Object.fromEntries(Object.keys(domains).map((key) => [key, {
  internalPeak: { db: -Infinity }, outputPeak: { db: -Infinity },
  quantizedInternalPeak: { db: -Infinity }, quantizedOutputPeak: { db: -Infinity },
}]));
for (const [id, preset] of Object.entries(fixture.presets)) {
  assert.equal(preset.eqBands.length, 10);
  assert.deepEqual(encodePayload(preset.eqBands, preset.preampDb), preset.payload);
  const floats = preset.eqBands.map((band) => designSection(band));
  const words = floats.map((s) => encodeSection(s));
  const quantized = words.map(fromWords);
  const quantizedPreampDb = 20 * Math.log10(preampWord(preset.preampDb) / 2 ** 23);
  const sections = floats.map((section, index) => {
    const values = ordered(section), quantizedValues = ordered(quantized[index]);
    const maximumAbsCoefficient = Math.max(...values.map(Math.abs));
    const radius = poleRadius(section), quantizedRadius = poleRadius(quantized[index]);
    assert.ok(isStable(quantized[index].a1, quantized[index].a2));
    for (const f of [0, 20, 25, 100, 1000, 10000, 20000, 48000]) {
      assert.ok(Math.abs(sectionDb(section, f) - magnitudeDb([preset.eqBands[index]], f)) < 1e-10);
    }
    values.forEach((coefficient, position) => {
      if (Math.abs(coefficient) > maxima[position].absCoefficient) {
        maxima[position] = { position: positions[position], absCoefficient: Math.abs(coefficient),
          fractionOf16: Math.abs(coefficient) / 16, preset: id, stage: index + 1, coefficient };
      }
      if (Math.abs(quantizedValues[position]) > quantizedMaxima[position].absCoefficient) {
        quantizedMaxima[position] = { position: positions[position], absCoefficient: Math.abs(quantizedValues[position]),
          fractionOf16: Math.abs(quantizedValues[position]) / 16, preset: id, stage: index + 1,
          word: words[index][position] };
      }
    });
    if (radius > maxPole.radius) maxPole = { radius, distanceToUnitCircle: 1 - radius, preset: id, stage: index + 1 };
    if (quantizedRadius > maxQuantizedPole.radius) maxQuantizedPole = {
      radius: quantizedRadius, distanceToUnitCircle: 1 - quantizedRadius, preset: id, stage: index + 1 };
    const singlePeak = peak((f) => sectionDb(section, f), 'full');
    const quantizedSinglePeak = peak((f) => sectionDb(quantized[index], f), 'full');
    if (singlePeak.db > maxSection.db) maxSection = { ...singlePeak, preset: id, stage: index + 1 };
    count++;
    return { stage: index + 1, band: preset.eqBands[index], coefficients: section, words: words[index],
      maximumAbsCoefficient, fractionOf16: maximumAbsCoefficient / 16,
      poleRadius: radius, distanceToUnitCircle: 1 - radius,
      quantizedPoleRadius: quantizedRadius, quantizedDistanceToUnitCircle: 1 - quantizedRadius,
      quantizedStable: true, singlePeak, quantizedSinglePeak };
  });
  const cascades = {}, quantizedCascades = {};
  for (const domain of Object.keys(domains)) {
    cascades[domain] = cascade(floats, preset.preampDb, domain);
    quantizedCascades[domain] = cascade(quantized, quantizedPreampDb, domain);
    for (const [key, candidate] of [
      ['internalPeak', cascades[domain].internalPeak], ['outputPeak', cascades[domain].outputPeak],
      ['quantizedInternalPeak', quantizedCascades[domain].internalPeak],
      ['quantizedOutputPeak', quantizedCascades[domain].outputPeak],
    ]) {
      if (candidate.db > aggregatePeaks[domain][key].db) aggregatePeaks[domain][key] = { ...candidate, preset: id };
    }
  }
  const orders = {
    reference: cascades.audible,
    frequency: cascade(preset.eqBands.map((b, i) => ({ b, s: floats[i] }))
      .sort((a, b) => a.b.freqHz - b.b.freqHz).map(({ s }) => s), preset.preampDb, 'audible'),
    reversed: cascade([...floats].reverse(), preset.preampDb, 'audible'),
  };
  for (const [key, value] of Object.entries(orders)) {
    if (value.internalPeak.db > orderWorst[key].db) orderWorst[key] = { ...value.internalPeak, preset: id };
    if (value.internalPeak.db > 0) orderAboveZero[key]++;
  }
  result.presets[id] = { preampDb: preset.preampDb, quantizedPreampDb, sections, cascades, quantizedCascades, orders };
}
const expected = { reference: '-0.20', frequency: '4.79', reversed: '9.13' };
for (const [order, value] of Object.entries(orderWorst)) assert.equal(value.db.toFixed(2), expected[order]);
assert.deepEqual(orderAboveZero, { reference: 0, frequency: 7, reversed: 11 });
assert.equal(count, 110);
result.validation = { exactFixturePayloads: Object.keys(fixture.presets).length,
  sectionMagnitudeChecks: count * 8, publishedPeakDb: expected, measuredOrderWorst: orderWorst,
  presetsWithPositiveInternalPeak: orderAboveZero,
  cornerGrid: 'Not applicable: official UI has no editable frequency/gain/Q/preamp ranges or filter-kind selector.' };
result.aggregate = { sections: count, coefficientMaxima: maxima, quantizedCoefficientMaxima: quantizedMaxima,
  maxPole, maxQuantizedPole, maxSectionPeak: maxSection, peaks: aggregatePeaks };
const basshead = fixture.presets.basshead;
const subsonicResponse = (f) => basshead.preampDb + magnitudeDb(basshead.eqBands, f);
let crossingLo = 0, crossingHi = 20;
for (let i = 0; i < 70; i++) {
  const middle = (crossingLo + crossingHi) / 2;
  if (subsonicResponse(middle) > 0) crossingLo = middle;
  else crossingHi = middle;
}
result.aggregate.bassheadSubsonic = {
  responsesDb: Object.fromEntries([0, 1, 5, 10, 15, 20].map((f) => [f, subsonicResponse(f)])),
  zeroCrossingHz: (crossingLo + crossingHi) / 2,
};
await writeFile(new URL('./envelope.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');

const fmt = (value, places = 9) => value.toFixed(places);
const signed = (value, places = 6) => `${value >= 0 ? '+' : ''}${value.toFixed(places)}`;
const lines = [
  '# Coefficient-space envelope — reproducible numeric appendix', '',
  `Run: \`node design/analysis/envelope.mjs\`; Node ${process.version}.`,
  'Full-precision machine-readable results: [envelope.json](envelope.json).', '',
  '## Method and validation', '',
  '- Import the repository codec; assert all 11 payloads equal the fixture byte-for-byte.',
  '- For each prefix, maximize `preampDb + sum(section magnitude dB)`; stage 0 is the preamp alone.',
  '- 16,384 logarithmic intervals per domain, endpoints included; refine every detected local maximum with up to 70 golden-section iterations (1e-8 Hz termination). Full-band grid starts at 0.001 Hz and also includes DC.',
  '- Audible = 20–20,000 Hz; extended = 20–48,000 Hz; full = DC–48,000 Hz. Nyquist evaluated by continuous transfer-function limit.',
  '- Same coefficient-polynomial evaluation as `magnitudeDb`, checked at 8 frequencies for every section (880 comparisons).',
  '- Float coefficients and input preamp reproduce the documentation method. Quantized columns use actual Q27 wire coefficients and Q23 preamp.',
  '- These are sinusoidal prefix-output transfer peaks, not bounds on hidden biquad state variables, time-domain transients, broadband peaks, or firmware arithmetic.',
  '- Numerical maxima are grid-plus-refinement estimates, not an interval-arithmetic proof of a continuous global bound.', '',
  '| Order | Worst peak dB | Preset / stage | Frequency Hz | Presets > 0 dB | Published (2 decimals) |',
  '|---|---:|---|---:|---:|---:|',
];
for (const [key, value] of Object.entries(orderWorst)) lines.push(
  `| ${key} | ${signed(value.db, 9)} | ${value.preset} / ${value.stage} | ${fmt(value.frequencyHz, 6)} | ${orderAboveZero[key]} | ${expected[key]} |`);
lines.push('', '## Aggregate: all 110 sections', '',
  '| Wire coefficient position | Max absolute float | Fraction of 16 | Location | Max absolute Q27 |',
  '|---|---:|---:|---|---:|');
maxima.forEach((v, i) => lines.push(`| ${v.position} | ${fmt(v.absCoefficient, 12)} | ${fmt(v.fractionOf16, 12)} | ${v.preset} / ${v.stage} | ${fmt(quantizedMaxima[i].absCoefficient, 12)} |`));
lines.push('',
  `- Maximum float pole radius: **${fmt(maxPole.radius, 12)}**, unit-circle distance **${fmt(1 - maxPole.radius, 12)}** (${maxPole.preset}, stage ${maxPole.stage}).`,
  `- Maximum Q27 pole radius: **${fmt(maxQuantizedPole.radius, 12)}**, distance **${fmt(1 - maxQuantizedPole.radius, 12)}** (${maxQuantizedPole.preset}, stage ${maxQuantizedPole.stage}).`,
  `- Maximum single-section gain (DC–48 kHz): **${signed(maxSection.db, 9)} dB**, ${fmt(maxSection.frequencyHz, 6)} Hz (${maxSection.preset}, stage ${maxSection.stage}).`,
  '- All 110 sections pass Q27 overflow and strict quantized-stability checks.', '',
  '| Domain | Worst internal float dB | Location | Worst output float dB | Location | Internal Q27/Q23 dB | Output Q27/Q23 dB |',
  '|---|---:|---|---:|---|---:|---:|');
for (const [key, value] of Object.entries(aggregatePeaks)) lines.push(
  `| ${key} | ${signed(value.internalPeak.db, 9)} | ${value.internalPeak.preset} / ${value.internalPeak.stage} | ${signed(value.outputPeak.db, 9)} | ${value.outputPeak.preset} / ${fmt(value.outputPeak.frequencyHz, 3)} Hz | ${signed(value.quantizedInternalPeak.db, 9)} | ${signed(value.quantizedOutputPeak.db, 9)} |`);
lines.push('',
  `**Subsonic exception:** Basshead reaches ${signed(result.aggregate.peaks.full.outputPeak.db, 9)} dB at DC, crosses 0 dB at approximately ${fmt(result.aggregate.bassheadSubsonic.zeroCrossingHz, 9)} Hz, and is ${signed(result.aggregate.bassheadSubsonic.responsesDb[5], 9)} dB at 5 Hz. Thus the negative output bound applies only from 20 Hz upward, not to the entire digital bandwidth.`, '');
lines.push('', '## Per-preset prefix peaks, including preamp', '',
  'Each cell is the maximum prefix response in dB over 20 Hz–20 kHz; the peak frequency can differ between stages. S0 = preamp alone.', '',
  '| Preset | S0 | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const [id, value] of Object.entries(result.presets)) lines.push(
  `| ${id} | ${value.cascades.audible.stages.map((s) => signed(s.db)).join(' | ')} |`);
lines.push('', '### Output and internal peaks outside the audible range', '',
  '| Preset | Output 20–20k dB | Hz | Output 20–48k dB | Hz | Output DC–48k dB | Hz | Internal DC–48k dB | Stage |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const [id, value] of Object.entries(result.presets)) {
  const a = value.cascades.audible, e = value.cascades.extended, f = value.cascades.full;
  lines.push(`| ${id} | ${signed(a.outputPeak.db, 9)} | ${fmt(a.outputPeak.frequencyHz, 6)} | ${signed(e.outputPeak.db, 9)} | ${fmt(e.outputPeak.frequencyHz, 6)} | ${signed(f.outputPeak.db, 9)} | ${fmt(f.outputPeak.frequencyHz, 6)} | ${signed(f.internalPeak.db, 9)} | ${f.internalPeak.stage} |`);
}
lines.push('', '### DC–48 kHz prefix peaks', '',
  '| Preset | S0 | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const [id, value] of Object.entries(result.presets)) lines.push(
  `| ${id} | ${value.cascades.full.stages.map((s) => signed(s.db)).join(' | ')} |`);
lines.push('', '## Per-section envelope (sent order)', '',
  'Peak is the standalone section maximum over DC–48 kHz, with no preamp. `r` is the maximum pole modulus. `1−r` is the minimum radial pole distance to the unit circle. Last two columns evaluate Q27 coefficients.', '',
  '| Preset | Stage | Kind | f Hz | Gain dB | Q | Max abs coef float | /16 | r float | 1−r float | Section peak dB | Peak Hz | r Q27 | 1−r Q27 | Section peak Q27 dB |',
  '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const [id, value] of Object.entries(result.presets)) for (const s of value.sections) {
  const b = s.band;
  lines.push(`| ${id} | ${s.stage} | ${b.kind} | ${b.freqHz} | ${b.gainDb} | ${b.qFactor} | ${fmt(s.maximumAbsCoefficient, 12)} | ${fmt(s.fractionOf16, 12)} | ${fmt(s.poleRadius, 12)} | ${fmt(s.distanceToUnitCircle, 12)} | ${signed(s.singlePeak.db, 9)} | ${fmt(s.singlePeak.frequencyHz, 6)} | ${fmt(s.quantizedPoleRadius, 12)} | ${fmt(s.quantizedDistanceToUnitCircle, 12)} | ${signed(s.quantizedSinglePeak.db, 9)} |`);
}
lines.push('', '## Editable-range corners / coarse grid', '',
  '**Not applicable:** the decoded official UI exposes only fixed preset selection. Frequency/gain/Q/preamp min/max/step and filter-kind selectors are **not found**. A Cartesian product of the fixture minima/maxima would be an extrapolated test space, not combinations proven by the official tool. No such space is mislabeled as official here.', '');
await writeFile(new URL('./envelope.md', import.meta.url), lines.join('\n'));
console.log(JSON.stringify({ validation: result.validation, aggregate: result.aggregate }, null, 2));
