// Experimental observed-envelope gate, NOT a firmware safety certification.
// Pure API: gate(bands, preamp), levelDb(bands, preamp), analyseSection(band).
import envelope from './envelope.json' with { type: 'json' };
import { designSection, encodeSection, encodePayload, preampWord, SAMPLE_RATE } from '../../src/dsp/eq0xcb.mjs';

export const Q27 = 2 ** 27;
const allSections = Object.values(envelope.presets).flatMap((p) => p.sections);
export const THRESHOLDS = Object.freeze({
  coefficientPositions: Object.freeze([...envelope.metadata.coefficientOrder]),
  coefficientAbsWords: Object.freeze(envelope.aggregate.quantizedCoefficientMaxima.map((m) => Math.abs(m.word))),
  coefficientAbs: Object.freeze(envelope.aggregate.quantizedCoefficientMaxima.map((m) => m.absCoefficient)),
  poleRadius: envelope.aggregate.maxQuantizedPole.radius,
  sectionPeakDb: Math.max(...allSections.map((s) => s.quantizedSinglePeak.db)),
  internalAudibleDb: envelope.aggregate.peaks.audible.quantizedInternalPeak.db,
  outputAudibleDb: envelope.aggregate.peaks.audible.quantizedOutputPeak.db,
  outputFullDb: envelope.aggregate.peaks.full.quantizedOutputPeak.db,
  preampMaxDb: Math.max(...Object.values(envelope.presets).map((p) => p.preampDb)),
  preampMinDb: -25.5,
  dbNumericalTolerance: 1e-8,
  radiusNumericalTolerance: 2e-15,
});
export const MEAN_FREQUENCIES = Object.freeze(Array.from({ length: 280 }, (_, i) =>
  Math.round(20 * 1000 ** (i / 279) * 100) / 100).filter((f) => f >= 300 && f <= 3000));

export function fromWords(w) {
  return { b0: w[0] / Q27, b2: w[1] / Q27, a1: -w[2] / Q27, b1: w[3] / Q27, a2: -w[4] / Q27 };
}
export function poleRadius(s) {
  const d = s.a1 * s.a1 - 4 * s.a2;
  return d < 0 ? Math.sqrt(s.a2)
    : Math.max(Math.abs((-s.a1 + Math.sqrt(d)) / 2), Math.abs((-s.a1 - Math.sqrt(d)) / 2));
}
export function sectionDb(s, f) {
  // Exact transfer identities avoid unnecessary cancellation/noisy flat peaks.
  if (s.b0 === 1 && s.b1 === s.a1 && s.b2 === s.a2) return 0;
  const w = 2 * Math.PI * f / SAMPLE_RATE;
  const re = 2 * Math.sin(w / 2) ** 2, im = Math.sin(w);
  const u2re = re * re - im * im, u2im = 2 * re * im;
  const power = (p0, p1, p2) => {
    const r = p0 + p1 + p2 - (p1 + 2 * p2) * re + p2 * u2re;
    const i = -(p1 + 2 * p2) * im + p2 * u2im;
    return r * r + i * i;
  };
  return 10 * Math.log10(power(s.b0, s.b1, s.b2) / power(1, s.a1, s.a2));
}

// |p(e^jw)|^2 is quadratic in t=sin²(w/2). The ratio's derivative is
// quadratic too. Evaluate endpoints and every real stationary point.
// Factored linear coefficient avoids cancellation near low-frequency poles.
function powerPolynomial(p0, p1, p2) {
  const sum = p0 + p1 + p2;
  return [sum * sum, 4 * ((p0 - p2) ** 2 - sum * (p0 + p2)), 16 * p0 * p2];
}
export function sectionPeaks(s) {
  const n = powerPolynomial(s.b0, s.b1, s.b2), d = powerPolynomial(1, s.a1, s.a2);
  const a = n[2] * d[1] - n[1] * d[2];
  const b = 2 * (n[2] * d[0] - n[0] * d[2]);
  const c = n[1] * d[0] - n[0] * d[1];
  const roots = [];
  if (a === 0) { if (b !== 0) roots.push(-c / b); }
  else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const q = -0.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(discriminant));
      if (q !== 0) roots.push(q / a, c / q);
      else roots.push(-b / (2 * a));
    }
  }
  const stationaryHz = roots.filter((t) => t > 0 && t < 1)
    .map((t) => Math.asin(Math.sqrt(t)) * SAMPLE_RATE / Math.PI);
  const maximum = (frequencies) => frequencies.map((f) => ({ db: sectionDb(s, f), frequencyHz: f }))
    .reduce((best, p) => p.db > best.db ? p : best);
  return {
    full: maximum([0, 48000, ...stationaryHz]),
    audible: maximum([20, 20000, ...stationaryHz.filter((f) => f >= 20 && f <= 20000)]),
  };
}
export function analyseSection(band) {
  const words = encodeSection(designSection(band));
  const section = fromWords(words), radius = poleRadius(section), peaks = sectionPeaks(section);
  const reasons = [];
  words.forEach((word, i) => {
    if (Math.abs(word) > THRESHOLDS.coefficientAbsWords[i]) reasons.push(`a:${THRESHOLDS.coefficientPositions[i]}`);
  });
  if (radius > THRESHOLDS.poleRadius + THRESHOLDS.radiusNumericalTolerance) reasons.push('b:pole-radius');
  if (peaks.full.db > THRESHOLDS.sectionPeakDb + THRESHOLDS.dbNumericalTolerance) reasons.push('c:section-peak');
  return { words, section, poleRadius: radius, fullPeak: peaks.full, audiblePeak: peaks.audible, reasons };
}

const intentionalPreampDb = (db) => 20 * Math.log10(preampWord(db) / 2 ** 23);
// Q23 must not round ABOVE the gain cap. Return the greatest representable
// attenuation word satisfying every gain cap, expressed back in dB.
export function autoPreampForSection(metrics) {
  const cap = Math.min(THRESHOLDS.internalAudibleDb - Math.max(0, metrics.audiblePeak.db),
    THRESHOLDS.outputAudibleDb - metrics.audiblePeak.db,
    THRESHOLDS.outputFullDb - metrics.fullPeak.db);
  const maximumWord = preampWord(THRESHOLDS.preampMaxDb);
  const word = Math.min(maximumWord, Math.floor(10 ** (cap / 20) * 2 ** 23));
  if (word < preampWord(THRESHOLDS.preampMinDb)) return null;
  if (word === maximumWord) return THRESHOLDS.preampMaxDb;
  const db = 20 * Math.log10(word / 2 ** 23);
  return Math.max(THRESHOLDS.preampMinDb, db);
}

function refine(fn, a, b) {
  const r = (Math.sqrt(5) - 1) / 2;
  let c = b - r * (b - a), d = a + r * (b - a), fc = fn(c), fd = fn(d);
  for (let i = 0; i < 70 && b - a > 1e-8; i++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - r * (b - a); fc = fn(c); }
    else { a = c; c = d; fc = fd; d = a + r * (b - a); fd = fn(d); }
  }
  return fc > fd ? { db: fc, frequencyHz: c } : { db: fd, frequencyHz: d };
}
function responsePeak(sections, minHz, maxHz) {
  if (!sections.length) return { db: 0, frequencyHz: minHz };
  if (sections.length === 1) {
    const p = sectionPeaks(sections[0]);
    return minHz === 0 ? p.full : p.audible;
  }
  const fn = (f) => sections.reduce((db, section) => db + sectionDb(section, f), 0);
  const intervals = 16384, lo = minHz || 0.001;
  const fs = Array.from({ length: intervals + 1 }, (_, i) => lo * (maxHz / lo) ** (i / intervals));
  fs[0] = lo; fs[intervals] = maxHz;
  if (minHz === 0) fs.unshift(0);
  const values = fs.map(fn);
  let best = { db: values[0], frequencyHz: fs[0] };
  for (let i = 1; i < fs.length; i++) {
    if (values[i] > best.db) best = { db: values[i], frequencyHz: fs[i] };
    if (i < fs.length - 1 && values[i] > values[i - 1] && values[i] >= values[i + 1]) {
      const candidate = refine(fn, fs[i - 1], fs[i + 1]);
      if (candidate.db > best.db) best = candidate;
    }
  }
  return best;
}
export function levelDb(eqBands, preampDb) {
  const sections = eqBands.map((b) => fromWords(encodeSection(designSection(b))));
  return intentionalPreampDb(preampDb) + MEAN_FREQUENCIES.reduce((sum, f) =>
    sum + sections.reduce((db, s) => db + sectionDb(s, f), 0), 0) / MEAN_FREQUENCIES.length;
}

export function gate(eqBands, preampDb) {
  const reasons = [], metrics = { thresholds: THRESHOLDS };
  let payload;
  try { payload = encodePayload(eqBands, preampDb); }
  catch (error) { return { ok: false, reasons: [`f:codec:${error.message}`], metrics }; }
  metrics.payloadCrc = `0x${payload.at(-1).toString(16).padStart(2, '0')}${payload.at(-2).toString(16).padStart(2, '0')}`;
  if (preampDb < THRESHOLDS.preampMinDb || preampDb > THRESHOLDS.preampMaxDb) reasons.push('g:preamp-range');
  metrics.preampDb = preampDb;
  metrics.quantizedPreampDb = intentionalPreampDb(preampDb);
  metrics.sections = eqBands.map((b, i) => {
    const s = analyseSection(b);
    reasons.push(...s.reasons.map((r) => `${r}:stage-${i + 1}`));
    return s;
  });
  const active = [];
  metrics.prefixAudible = [{ stage: 0, db: metrics.quantizedPreampDb, frequencyHz: null }];
  for (const [i, item] of metrics.sections.entries()) {
    const s = item.section;
    if (!(s.b0 === 1 && s.b1 === s.a1 && s.b2 === s.a2)) active.push(s);
    const peak = responsePeak(active, 20, 20000);
    metrics.prefixAudible.push({ stage: i + 1, db: peak.db + metrics.quantizedPreampDb, frequencyHz: peak.frequencyHz });
  }
  metrics.internalAudible = metrics.prefixAudible.reduce((a, b) => b.db > a.db ? b : a);
  metrics.outputAudible = metrics.prefixAudible.at(-1);
  const full = responsePeak(active, 0, 48000);
  metrics.outputFull = { db: full.db + metrics.quantizedPreampDb, frequencyHz: full.frequencyHz };
  if (metrics.internalAudible.db > THRESHOLDS.internalAudibleDb + THRESHOLDS.dbNumericalTolerance) reasons.push('d:internal-audible');
  if (metrics.outputAudible.db > THRESHOLDS.outputAudibleDb + THRESHOLDS.dbNumericalTolerance) reasons.push('e:output-audible');
  if (metrics.outputFull.db > THRESHOLDS.outputFullDb + THRESHOLDS.dbNumericalTolerance) reasons.push('e:output-full');
  return { ok: reasons.length === 0, reasons, metrics };
}
