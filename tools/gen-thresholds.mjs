// Generates src/safety/thresholds.mjs from design/analysis/envelope.json.
//
// Usage: node tools/gen-thresholds.mjs
//
// The values are computed exactly as the reference analysis does
// (design/analysis/gate.mjs, THRESHOLDS) and written as a frozen object
// literal, so the library never imports JSON (Workers compatibility). The
// output is deterministic: no timestamps, relative paths only. The SHA-256 is
// taken over the source text with line endings normalized to LF, so it does not
// depend on how git checked the file out.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_PATH = 'design/analysis/envelope.json';
export const OUTPUT_PATH = 'src/safety/thresholds.mjs';
export const GENERATED_BY = 'tools/gen-thresholds.mjs';

const PRINT_WIDTH = 100;

/**
 * @typedef {{db: number}} DbPoint
 * @typedef {{
 *   metadata: {coefficientOrder: string[]},
 *   presets: Record<string, {preampDb: number, sections: {quantizedSinglePeak: DbPoint}[]}>,
 *   aggregate: {
 *     quantizedCoefficientMaxima: {word: number, absCoefficient: number}[],
 *     maxQuantizedPole: {radius: number},
 *     peaks: {
 *       audible: {quantizedInternalPeak: DbPoint, quantizedOutputPeak: DbPoint},
 *       extended: {quantizedInternalPeak: DbPoint, quantizedOutputPeak: DbPoint},
 *       full: {quantizedInternalPeak: DbPoint, quantizedOutputPeak: DbPoint},
 *     },
 *   },
 * }} Envelope
 * @typedef {{
 *   coefficientPositions: string[],
 *   coefficientAbsWords: number[],
 *   coefficientAbs: number[],
 *   poleRadius: number,
 *   sectionPeakDb: number,
 *   internalAudibleDb: number,
 *   outputAudibleDb: number,
 *   outputFullDb: number,
 *   preampMaxDb: number,
 *   preampMinDb: number,
 *   dbNumericalTolerance: number,
 *   radiusNumericalTolerance: number,
 * }} ThresholdValues
 * @typedef {{
 *   internalFullDb: number,
 *   internalExtendedDb: number,
 *   outputExtendedDb: number,
 * }} YoloThresholdValues
 */

/**
 * SHA-256 (hex) of `text` with CRLF normalized to LF.
 * @param {string} text
 * @returns {string}
 */
export function sourceSha256(text) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Thresholds exactly as design/analysis/gate.mjs derives them.
 * @param {Envelope} envelope
 * @returns {ThresholdValues}
 */
export function computeThresholds(envelope) {
  const presets = Object.values(envelope.presets);
  const allSections = presets.flatMap((p) => p.sections);
  const maxima = envelope.aggregate.quantizedCoefficientMaxima;
  return {
    coefficientPositions: [...envelope.metadata.coefficientOrder],
    coefficientAbsWords: maxima.map((m) => Math.abs(m.word)),
    coefficientAbs: maxima.map((m) => m.absCoefficient),
    poleRadius: envelope.aggregate.maxQuantizedPole.radius,
    sectionPeakDb: Math.max(...allSections.map((s) => s.quantizedSinglePeak.db)),
    internalAudibleDb: envelope.aggregate.peaks.audible.quantizedInternalPeak.db,
    outputAudibleDb: envelope.aggregate.peaks.audible.quantizedOutputPeak.db,
    outputFullDb: envelope.aggregate.peaks.full.quantizedOutputPeak.db,
    preampMaxDb: Math.max(...presets.map((p) => p.preampDb)),
    preampMinDb: -25.5,
    dbNumericalTolerance: 1e-8,
    radiusNumericalTolerance: 2e-15,
  };
}

/**
 * Limits only the YOLO gate profile adds (separate from THRESHOLDS, so the
 * standard gate, its version hash and every cached verdict stay unchanged).
 * `internalFullDb` is the largest quantized prefix peak with preamp over
 * DC–48 kHz in the 11 presets, as design/analysis/envelope.mjs computes it
 * (`aggregate.peaks.full.quantizedInternalPeak`): the `d:prefix-peak-full` limit
 * that bounds out-of-band energy once `c:section-peak` is waived.
 * `internalExtendedDb` and `outputExtendedDb` are the largest quantized prefix
 * and output peaks with preamp over 20 Hz–48 kHz
 * (`aggregate.peaks.extended.quantizedInternalPeak` and `quantizedOutputPeak`):
 * the `d:prefix-peak-extended` and `e:output-extended` limits, checked once
 * `d7:boost-above-20k` is waived.
 * @param {Envelope} envelope
 * @returns {YoloThresholdValues}
 */
export function computeYoloThresholds(envelope) {
  const { extended, full } = envelope.aggregate.peaks;
  return {
    internalFullDb: full.quantizedInternalPeak.db,
    internalExtendedDb: extended.quantizedInternalPeak.db,
    outputExtendedDb: extended.quantizedOutputPeak.db,
  };
}

/**
 * @param {string | number} value
 * @returns {string}
 */
function literal(value) {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/**
 * One `key: value,` property line (indent 2), wrapping arrays the way prettier
 * fills number arrays when the line is too long.
 * @param {string} key
 * @param {string | number | (string | number)[]} value
 * @returns {string}
 */
function property(key, value) {
  if (!Array.isArray(value)) return `  ${key}: ${literal(value)},`;
  const items = value.map(literal);
  const oneLine = `  ${key}: Object.freeze([${items.join(', ')}]),`;
  if (oneLine.length <= PRINT_WIDTH) return oneLine;
  const lines = [];
  let line = '';
  for (const item of items) {
    const next = line ? `${line} ${item},` : `    ${item},`;
    if (line && next.length > PRINT_WIDTH) {
      lines.push(line);
      line = `    ${item},`;
    } else {
      line = next;
    }
  }
  lines.push(line);
  return [`  ${key}: Object.freeze([`, ...lines, '  ]),'].join('\n');
}

/**
 * Source text of src/safety/thresholds.mjs for the given envelope.json text.
 * @param {string} envelopeText
 * @returns {string}
 */
export function renderThresholdsModule(envelopeText) {
  const envelope = JSON.parse(envelopeText);
  const t = computeThresholds(envelope);
  const yolo = computeYoloThresholds(envelope);
  const sha256 = sourceSha256(envelopeText);
  return `// GENERATED by ${GENERATED_BY} from ${SOURCE_PATH}. Do not edit by hand:
// run \`node ${GENERATED_BY}\` instead.
//
// Gate v2 ("observed envelope") thresholds: the largest values the 11 official
// presets already make the chip compute (quantized Q27 coefficients and Q23
// preamp). A similarity policy, not a hardware safety proof.

/**
 * @typedef {object} Thresholds
 * @property {readonly string[]} coefficientPositions Wire order of the section words.
 * @property {readonly number[]} coefficientAbsWords Largest |Q27 word| per wire position.
 * @property {readonly number[]} coefficientAbs Same limits as normalized coefficients.
 * @property {number} poleRadius Largest quantized pole radius.
 * @property {number} sectionPeakDb Largest single-section peak, DC–48 kHz (dB).
 * @property {number} internalAudibleDb Largest prefix peak with preamp, 20 Hz–20 kHz (dB).
 * @property {number} outputAudibleDb Largest output peak with preamp, 20 Hz–20 kHz (dB).
 * @property {number} outputFullDb Largest output peak with preamp, DC–48 kHz (dB).
 * @property {number} preampMaxDb Highest nominal preamp (dB).
 * @property {number} preampMinDb Lowest nominal preamp (dB).
 * @property {number} dbNumericalTolerance Computation tolerance on dB limits.
 * @property {number} radiusNumericalTolerance Computation tolerance on the pole radius.
 */

/**
 * @typedef {object} Provenance
 * @property {string} source Repository-relative path of the source data.
 * @property {string} sha256 SHA-256 of the source text, line endings normalized to LF.
 * @property {string} generatedBy Repository-relative path of the generator.
 */

/** @type {Readonly<Thresholds>} */
export const THRESHOLDS = Object.freeze({
${Object.entries(t)
  .map(([key, value]) => property(key, value))
  .join('\n')}
});

/** @type {Readonly<Provenance>} */
export const PROVENANCE = Object.freeze({
  source: '${SOURCE_PATH}',
  sha256: '${sha256}',
  generatedBy: '${GENERATED_BY}',
});

// YOLO gate profile only. A separate export: THRESHOLDS above (and so the gate
// version) do not change when this one does.

/**
 * @typedef {object} YoloThresholds
 * @property {number} internalFullDb Largest prefix peak with preamp, DC–48 kHz (dB): the
 *   \`d:prefix-peak-full\` limit.
 * @property {number} internalExtendedDb Largest prefix peak with preamp, 20 Hz–48 kHz (dB):
 *   the \`d:prefix-peak-extended\` limit.
 * @property {number} outputExtendedDb Largest output peak with preamp, 20 Hz–48 kHz (dB): the
 *   \`e:output-extended\` limit.
 */

/** @type {Readonly<YoloThresholds>} */
export const YOLO_THRESHOLDS = Object.freeze({
${Object.entries(yolo)
  .map(([key, value]) => property(key, value))
  .join('\n')}
});
`;
}

/** Repository root, resolved from this file's location. */
const ROOT = new URL('../', import.meta.url);

async function main() {
  const text = await readFile(new URL(SOURCE_PATH, ROOT), 'utf8');
  await writeFile(new URL(OUTPUT_PATH, ROOT), renderThresholdsModule(text), 'utf8');
  console.log(`wrote ${OUTPUT_PATH} from ${SOURCE_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
