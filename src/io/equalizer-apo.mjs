import { BAND_COUNT } from '../dsp/eq0xcb.mjs';

/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} Band
 * @typedef {{preampDb: number, bands: readonly Band[]}} EqualizerApoPreset
 * @typedef {{line: number, text: string}} EqualizerApoWarning
 * @typedef {keyof typeof ERROR_MESSAGES} EqualizerApoErrorCode
 */

const ERROR_MESSAGES = Object.freeze({
  'apo:lsq-hsq': 'LSQ and HSQ are not supported: their Q semantics differ from the codec.',
  'apo:pass-gain': 'Pass filters cannot represent non-zero gain.',
  'apo:too-many-filters': 'At most 10 filters are supported; no filters were truncated.',
  'apo:malformed': 'Malformed EqualizerAPO directive.',
  'apo:unknown-type': 'Unsupported EqualizerAPO filter type.',
  'apo:number': 'Expected a finite decimal number.',
  'apo:missing-field': 'A required EqualizerAPO field is missing.',
});

/** A format error, with a stable code/message and a one-based source line. */
export class EqualizerApoError extends Error {
  /**
   * @param {EqualizerApoErrorCode} code
   * @param {number} line Source line, or the canonical output line when serializing.
   */
  constructor(code, line) {
    super(ERROR_MESSAGES[code]);
    this.name = 'EqualizerApoError';
    this.code = code;
    this.line = line;
  }
}

/** @type {ReadonlyMap<string, Exclude<Band['kind'], 'OFF'>>} */
const IMPORT_TYPES = new Map([
  ['PK', 'PK'],
  ['LSC', 'LS'],
  ['HSC', 'HS'],
  ['LS', 'LS'],
  ['HS', 'HS'],
  ['LPQ', 'LP'],
  ['LP', 'LP'],
  ['HPQ', 'HP'],
  ['HP', 'HP'],
]);

const DEFAULT_Q_TYPES = new Set(['LS', 'HS', 'LP', 'HP']);

/** @type {ReadonlyMap<string, string>} */
const EXPORT_TYPES = new Map([
  ['PK', 'PK'],
  ['LS', 'LSC'],
  ['HS', 'HSC'],
  ['LP', 'LPQ'],
  ['HP', 'HPQ'],
]);

/**
 * @param {string[]} tokens
 * @param {number} line
 */
function take(tokens, line) {
  const token = tokens.shift();
  if (token === undefined) throw new EqualizerApoError('apo:missing-field', line);
  return token;
}

/**
 * @param {string[]} tokens
 * @param {string} expected
 * @param {number} line
 */
function keyword(tokens, expected, line) {
  if (take(tokens, line).toUpperCase() !== expected) {
    throw new EqualizerApoError('apo:malformed', line);
  }
}

/**
 * @param {string} token
 * @param {number} line
 */
function decimal(token, line) {
  const value = Number(token.replace(',', '.'));
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(token) || !Number.isFinite(value)) {
    throw new EqualizerApoError('apo:number', line);
  }
  return value;
}

/**
 * @param {ReadonlyMap<string, number>} fields
 * @param {string} name
 * @param {number} line
 */
function requiredField(fields, name, line) {
  const value = fields.get(name);
  if (value === undefined) throw new EqualizerApoError('apo:missing-field', line);
  return value;
}

/**
 * @param {string} text
 * @param {number} line
 * @returns {Band}
 */
function parseFilter(text, line) {
  const header = /^Filter\s+[1-9]\d*:\s*(.*)$/i.exec(text);
  if (!header) throw new EqualizerApoError('apo:malformed', line);
  const tokens = header[1].match(/\S+/g) ?? [];
  const status = take(tokens, line).toUpperCase();
  if (status !== 'ON' && status !== 'OFF') {
    throw new EqualizerApoError('apo:malformed', line);
  }
  const type = take(tokens, line).toUpperCase();
  if (type === 'LSQ' || type === 'HSQ') throw new EqualizerApoError('apo:lsq-hsq', line);
  const kind = IMPORT_TYPES.get(type);
  if (!kind) throw new EqualizerApoError('apo:unknown-type', line);

  /** @type {Map<string, number>} */
  const fields = new Map();
  while (tokens.length > 0) {
    const field = take(tokens, line).toUpperCase();
    if (!['FC', 'GAIN', 'Q'].includes(field) || fields.has(field)) {
      throw new EqualizerApoError('apo:malformed', line);
    }
    fields.set(field, decimal(take(tokens, line), line));
    if (field !== 'Q') keyword(tokens, field === 'FC' ? 'HZ' : 'DB', line);
  }

  const freqHz = requiredField(fields, 'FC', line);
  const qFactor =
    fields.get('Q') ?? (DEFAULT_Q_TYPES.has(type) ? 0.7071 : requiredField(fields, 'Q', line));
  if (kind === 'LP' || kind === 'HP') {
    const gainDb = fields.get('GAIN');
    if (gainDb !== undefined && gainDb !== 0) {
      throw new EqualizerApoError('apo:pass-gain', line);
    }
    return status === 'OFF' ? { kind: 'OFF' } : { kind, freqHz, qFactor };
  }
  const gainDb = requiredField(fields, 'GAIN', line);
  return status === 'OFF' ? { kind: 'OFF' } : { kind, freqHz, gainDb, qFactor };
}

/**
 * Parse the parametric subset of EqualizerAPO/AutoEq text, without safety validation.
 * Missing Preamp defaults to 0 dB; the last Preamp wins. Filter numbers are labels:
 * bands retain source order, including disabled filters, and are padded to ten OFFs.
 * PK, LSC/HSC and LPQ/HPQ require Q; LS/HS and LP/HP default it to 0.7071.
 * Gain is required for peaking/shelves; pass filters accept only zero gain and omit it.
 * Disabled filters must still be syntactically valid; their parameters are discarded.
 * Directives/keywords are case-insensitive. Unknown lines are returned after stripping
 * comments/whitespace, with their original one-based line numbers.
 *
 * @param {string} text
 * @returns {{preampDb: number, bands: Band[], warnings: EqualizerApoWarning[]}}
 * @throws {EqualizerApoError}
 */
export function parseEqualizerApo(text) {
  let preampDb = 0;
  /** @type {Band[]} */
  const bands = [];
  /** @type {EqualizerApoWarning[]} */
  const warnings = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const [index, source] of lines.entries()) {
    const line = index + 1;
    const content = source.split('#', 1)[0].trim();
    if (!content) continue;
    if (/^Preamp\b/i.test(content)) {
      const header = /^Preamp:\s*(.*)$/i.exec(content);
      if (!header) throw new EqualizerApoError('apo:malformed', line);
      const tokens = header[1].match(/\S+/g) ?? [];
      preampDb = decimal(take(tokens, line), line);
      keyword(tokens, 'DB', line);
      if (tokens.length > 0) throw new EqualizerApoError('apo:malformed', line);
    } else if (/^Filter\b/i.test(content)) {
      if (bands.length === BAND_COUNT) {
        throw new EqualizerApoError('apo:too-many-filters', line);
      }
      bands.push(parseFilter(content, line));
    } else {
      warnings.push({ line, text: content });
    }
  }
  while (bands.length < BAND_COUNT) bands.push({ kind: 'OFF' });
  return { preampDb, bands, warnings };
}

/**
 * Shortest round-trippable decimal, expanding the exponent used by Number#toString
 * outside [1e-6, 1e21). No rounding, locale dependence or trailing fractional zeros.
 * @param {number | undefined} value
 * @param {number} line
 */
function formatNumber(value, line) {
  if (value === undefined) throw new EqualizerApoError('apo:missing-field', line);
  if (!Number.isFinite(value)) throw new EqualizerApoError('apo:number', line);
  if (Object.is(value, -0)) return '-0';
  const text = String(value);
  const [mantissa, exponent] = Math.abs(value).toString().split('e');
  if (exponent === undefined) return text;
  const digits = mantissa.replace('.', '');
  const point = 1 + Number(exponent);
  const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : digits.padEnd(point, '0');
  return value < 0 ? `-${expanded}` : expanded;
}

/**
 * @param {Band} band
 * @param {number} index Zero-based band index.
 */
function serializeBand(band, index) {
  const prefix = `Filter ${index + 1}:`;
  if (band.kind === 'OFF') return `${prefix} OFF PK Fc 1000 Hz Gain 0 dB Q 1`;
  const line = index + 2;
  const type = EXPORT_TYPES.get(band.kind);
  if (!type) throw new EqualizerApoError('apo:unknown-type', line);
  const gain =
    (band.kind === 'LP' || band.kind === 'HP') && band.gainDb === undefined
      ? ''
      : ` Gain ${formatNumber(band.gainDb, line)} dB`;
  const freqHz = formatNumber(band.freqHz, line);
  const qFactor = formatNumber(band.qFactor, line);
  return `${prefix} ON ${type} Fc ${freqHz} Hz${gain} Q ${qFactor}`;
}

/**
 * Serialize without safety validation, padding to ten filters and refusing more.
 * Uses LF (including a final LF), point decimals, LSC/HSC and LPQ/HPQ. The canonical
 * disabled line is `Filter N: OFF PK Fc 1000 Hz Gain 0 dB Q 1`. Error line numbers
 * refer to canonical output lines (Preamp is line 1, filter N is line N + 1).
 *
 * @param {EqualizerApoPreset} preset
 * @returns {string}
 * @throws {EqualizerApoError}
 */
export function serializeEqualizerApo({ preampDb, bands }) {
  if (bands.length > BAND_COUNT) {
    throw new EqualizerApoError('apo:too-many-filters', BAND_COUNT + 2);
  }
  const lines = [`Preamp: ${formatNumber(preampDb, 1)} dB`];
  for (let index = 0; index < BAND_COUNT; index++) {
    lines.push(serializeBand(bands[index] ?? { kind: 'OFF' }, index));
  }
  return `${lines.join('\n')}\n`;
}
