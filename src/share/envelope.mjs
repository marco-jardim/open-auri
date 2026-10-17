// S5 publication envelope. Pure ESM: no schema import, DOM or Node dependencies.
// This validates publication data, NOT the safety gate; run the gate separately.

import { decodeS1, encodeS1 } from './s1.mjs';

/** @import { Band } from '../dsp/eq0xcb.mjs' */

/**
 * @typedef {string | number | boolean | null} Primitive
 * @typedef {{source: string, name: string, sha256?: string}} Measurement
 * Recipe limits (normalized code points): source/solver name 64, measurement or
 * target filename 120, solver SemVer version 32; at most 32 params with ASCII keys of 1–32
 * characters and primitive values (strings at most 128, numbers finite).
 * @typedef {{measurement?: Measurement, target?: {source: string, name: string},
 *   solver?: {name: string, version: string}, params?: Record<string, Primitive>}} Recipe
 * @typedef {{format: 'open-auri/preset@1', name: string, description: string,
 *   author?: string | null, source: string, license: 'CC0-1.0' | 'CC-BY-4.0',
 *   code: string, preampDb: number, bands: Band[], recipe?: Recipe,
 *   lang: 'pt-BR' | 'en-US', createdAt: string}} Envelope
 * @typedef {'env:type' | 'env:required' | 'env:extra' | 'env:length' | 'env:enum'
 *   | 'env:pattern' | 'env:range' | 'env:url' | 'env:url-like' | 'env:code-mismatch' | 'env:s1'
 *   | 'env:bands' | 'env:json' | 'env:size'} EnvelopeErrorCode
 * @typedef {{path: string, code: EnvelopeErrorCode, message: string}} EnvelopeIssue
 * @typedef {{ok: true, value: Envelope} | {ok: false, errors: EnvelopeIssue[]}} EnvelopeResult
 */

const KEYS = [
  'format',
  'name',
  'description',
  'author',
  'source',
  'license',
  'code',
  'preampDb',
  'bands',
  'recipe',
  'lang',
  'createdAt',
];
const REQUIRED = [
  'format',
  'name',
  'source',
  'license',
  'code',
  'preampDb',
  'bands',
  'lang',
  'createdAt',
];
const SOURCE = /^(?:custom|import|(?:preset|community):[A-Za-z0-9][A-Za-z0-9_-]{0,63})$(?![\s\S])/;
const SHA256 = /^[a-fA-F0-9]{64}$(?![\s\S])/;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,31}$(?![\s\S])/;
// Dataset/file names are not prose: dots are allowed, links and path syntax are not.
const RECIPE_NAME = /^(?!.*www\.)[\p{L}\p{N} ._()+,'&-]{1,120}$(?![\s\S])/iu;
// Ignore only one known file extension when checking the remaining name for links.
const RECIPE_EXTENSION = /\.(?:csv|txt|json|frd|zma|mdat|wav|rew)$(?![\s\S])/iu;
// Narrow SemVer subset: release channels, canonical numeric identifiers and git SHAs.
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc|dev|pre)(?:\.(?:0|[1-9]\d*))*)?(?:\+[0-9A-Fa-f]{1,40})?$(?![\s\S])/;
// Calendar validity is checked separately, including leap years. UTC only, no offsets.
const UTC =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$(?![\s\S])/;
const INVISIBLE =
  /[\p{Default_Ignorable_Code_Point}\p{Cf}\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;
// Protect only the RGI subdivision tag flags (gbeng, gbsct, gbwls): two tag letters,
// then three tag letters and CANCEL TAG. Other tag runs cannot hide arbitrary ASCII.
// Also protect pictographic ZWJ chains (including skin tones) and selectors after
// pictographs or keycap bases. Detection never uses these invisible exemptions.
const EMOJI_SEQUENCE =
  /\u{1f3f4}\u{e0067}\u{e0062}(?:\u{e0065}\u{e006e}\u{e0067}|\u{e0073}\u{e0063}\u{e0074}|\u{e0077}\u{e006c}\u{e0073})\u{e007f}|\p{Extended_Pictographic}[\ufe0e\ufe0f]?\p{Emoji_Modifier}?(?:\u200d\p{Extended_Pictographic}[\ufe0e\ufe0f]?\p{Emoji_Modifier}?)*|[0-9#*][\ufe0e\ufe0f]/gu;
// Detection only: retain the normalized punctuation in published text.
const URL_DOTS = /[\u3002\uff0e\uff61\u2024\ufe52]/gu;
// Consume scheme candidates BEFORE checking their suffix: a failed suffix must
// not retry every dotted suffix of a long token (quadratic backtracking).
// No leading boundary (`\b` is ASCII-only and a lookbehind on letters or digits
// would still skip `1http`): a candidate starts at the first ASCII letter of a
// run of scheme characters and consumes the whole run, so whatever is glued
// before a scheme (`1http://`, `_http://`, `xhttps://`, `çhttp://`) cannot hide
// it, and each character is still scanned once (non-overlapping matches).
const SCHEME_CANDIDATE = /[a-z][a-z0-9+.-]*/giu;
// Same reason: nothing glued before `hxxp` exempts it (`1hxxp`, `_hxxp`).
const URL_PREFIX = /hxxps?\b|www\./iu;
// Accepted false positive: dotted four-part versions in prose ("firmware
// 1.2.3.4") read as an IPv4 address and are refused (env:url). Shared text must
// not carry links (plan §0.12), so the detector stays on the safe side.
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/u;
const DOMAIN =
  /(?:^|[^\p{L}\p{N}])([\p{L}\p{N}-]{1,63}\.(?:xn--[a-z0-9-]{1,59}|\p{L}{2,24}))(?=$|[^\p{L}\p{N}])/giu;
// Case-insensitive prose allowlist: pt-BR p.ex., p. ex., a.C., d.C., S.A.,
// Ltda.; English e.g., i.e., a.m., p.m., vs. Never mask a domain component.
const ABBREVIATION =
  /(^|[^\p{L}\p{N}_.-])(?:p\. ?ex\.|a\.c\.|d\.c\.|s\.a\.|ltda\.|e\.g\.|i\.e\.|a\.m\.|p\.m\.|vs\.)(?=$|[^\p{L}\p{N}_.-])/giu;
const MAX_BYTES = 8192;
const MAX_RAW_UNITS = 65536;

/** A thrown normalization/serialization error; validation APIs return these issues instead. */
export class EnvelopeError extends Error {
  /** @param {EnvelopeIssue[]} errors */
  constructor(errors) {
    super(errors.map(({ path, code, message }) => `${path}: ${code}: ${message}`).join('; '));
    this.name = 'EnvelopeError';
    this.errors = errors;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} path @param {EnvelopeErrorCode} code @param {string} message */
function issue(path, code, message) {
  return { path, code, message };
}

/** @param {string} text @returns {string} */
function stripInvisibles(text) {
  const parts = [];
  let end = 0;
  for (const match of text.matchAll(EMOJI_SEQUENCE)) {
    parts.push(text.slice(end, match.index).replace(INVISIBLE, ''), match[0]);
    end = match.index + match[0].length;
  }
  parts.push(text.slice(end).replace(INVISIBLE, ''));
  return parts.join('');
}

/** @param {string} text @returns {'env:url' | 'env:url-like' | undefined} */
function urlCode(text) {
  const detection = text.replace(INVISIBLE, '').replace(/\p{M}/gu, '').replace(URL_DOTS, '.');
  if (URL_PREFIX.test(detection) || IPV4.test(detection)) return 'env:url';
  for (const match of detection.matchAll(SCHEME_CANDIDATE)) {
    if (detection.startsWith('://', match.index + match[0].length)) return 'env:url';
  }
  const prose = detection.replace(ABBREVIATION, '$1 ');
  const matches = [...prose.matchAll(DOMAIN)];
  if (!matches.length) return undefined;
  const match = matches[0];
  const word = match[1];
  const start = match.index + match[0].length - word.length;
  // An isolated letter-only word.Word with an uppercase initial after the dot,
  // or any non-ASCII letter, may be missing sentence spacing (grave.Agudo,
  // Sr.João). Still refuse it, but suggest adding a space. Schemes, www, IPs,
  // subdomains and multiple matches always retain the unambiguous env:url code.
  if (
    matches.length === 1 &&
    /^[\p{L}]+\.[\p{L}]+$/u.test(word) &&
    /\.\p{Lu}|\P{ASCII}/u.test(word) &&
    prose[start - 1] !== '.' &&
    prose[start + word.length] !== '.'
  ) {
    return 'env:url-like';
  }
  return 'env:url';
}

/**
 * NFKC, invisible-control removal, whitespace collapse and trim. Description keeps
 * LF line boundaries (at most five lines); all other C0/C1 controls are refused
 * BEFORE whitespace collapse, so tabs/newlines cannot be laundered into a name.
 * Throws EnvelopeError for invalid input, controls, line count or URL-like text.
 * Length bounds belong to the field validator and count Unicode code points.
 * @param {string} text
 * @param {{multiline?: boolean, path?: string}} [options]
 * @returns {string}
 */
export function normalizeText(text, { multiline = false, path = '' } = {}) {
  return normalizeFieldText(text, multiline, path, 'prose');
}

/**
 * Recipe names check URLs after removing one known file extension. Versions rely
 * on their narrow structural pattern. Neither exception applies to public prose.
 * @param {string} text @param {boolean} multiline @param {string} path
 * @param {'prose' | 'recipe-name' | 'version'} kind @returns {string}
 */
function normalizeFieldText(text, multiline, path, kind) {
  if (typeof text !== 'string') {
    throw new EnvelopeError([issue(path, 'env:type', 'Expected text')]);
  }
  const clean = stripInvisibles(text.normalize('NFKC'));
  const hasControl = [...clean].some((character) => {
    const point = character.charCodeAt(0);
    return (point <= 0x1f || (point >= 0x7f && point <= 0x9f)) && !(multiline && point === 10);
  });
  const value = multiline
    ? clean
        .split('\n')
        .map((line) => line.replace(/\s+/gu, ' ').trim())
        .join('\n')
        .trim()
    : clean.replace(/\s+/gu, ' ').trim();
  const errors = [];
  if (hasControl) errors.push(issue(path, 'env:pattern', 'Control characters are forbidden'));
  if (multiline && value.split('\n').length > 5) {
    errors.push(issue(path, 'env:length', 'Description must have at most five lines'));
  }
  const detection = kind === 'recipe-name' ? value.replace(RECIPE_EXTENSION, '') : value;
  const code = kind === 'version' ? undefined : urlCode(detection);
  if (code) {
    errors.push(
      issue(
        path,
        code,
        code === 'env:url-like'
          ? 'Domain-like text is forbidden; try adding a space after the period'
          : 'URLs and domain-like text are forbidden',
      ),
    );
  }
  if (errors.length) throw new EnvelopeError(errors);
  return value;
}

/**
 * Clone the known object levels, retaining unknown keys for env:extra checks.
 * Malformed values are retained for validation, not silently discarded/coerced.
 * @param {unknown} input
 * @param {EnvelopeIssue[]} errors
 * @returns {unknown}
 */
function normalize(input, errors) {
  if (!isObject(input)) return input;
  const value = { ...input };
  /** @param {Record<string, unknown>} object @param {string} key @param {string} path */
  const text = (object, key, path) => {
    if (typeof object[key] !== 'string') return;
    try {
      const kind =
        path === '/recipe/solver/version'
          ? 'version'
          : path === '/recipe/measurement/name' || path === '/recipe/target/name'
            ? 'recipe-name'
            : 'prose';
      object[key] = normalizeFieldText(object[key], path === '/description', path, kind);
    } catch (error) {
      if (!(error instanceof EnvelopeError)) throw error;
      errors.push(...error.errors);
    }
  };
  for (const key of ['name', 'description', 'author']) text(value, key, `/${key}`);
  if (!Object.hasOwn(value, 'description')) value.description = '';
  if (Array.isArray(value.bands)) {
    value.bands = value.bands.map((band) => (isObject(band) ? { ...band } : band));
  }
  if (isObject(value.recipe)) {
    const recipe = { ...value.recipe };
    value.recipe = recipe;
    for (const key of ['measurement', 'target', 'solver', 'params']) {
      if (!isObject(recipe[key])) continue;
      const part = { ...recipe[key] };
      recipe[key] = part;
      const fields =
        key === 'params'
          ? Object.keys(part)
          : key === 'solver'
            ? ['name', 'version']
            : ['source', 'name'];
      for (const field of fields) text(part, field, `/recipe/${key}/${field}`);
    }
  }
  return value;
}

/**
 * Returns a new object, normalizing free text and defaulting description to ''.
 * Does not repair structural errors or regenerate code. Throws EnvelopeError for
 * forbidden text; use validateEnvelope for collected text AND structural errors.
 * @param {unknown} obj
 * @returns {unknown}
 */
export function normalizeEnvelope(obj) {
  /** @type {EnvelopeIssue[]} */
  const errors = [];
  const value = normalize(obj, errors);
  if (errors.length) throw new EnvelopeError(errors);
  return value;
}

/**
 * Deterministic JSON: fixed envelope/band/recipe key order, sorted params keys.
 * Called only after structural validation. Optional fields stay absent.
 * @param {Envelope} value
 */
function stringify(value) {
  /** @param {object} obj @param {string[]} keys */
  const ordered = (obj, keys) => {
    const record = /** @type {Record<string, unknown>} */ (obj);
    return Object.fromEntries(
      keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]),
    );
  };
  const result = ordered(value, KEYS);
  result.bands = value.bands.map((band) => ordered(band, ['kind', 'freqHz', 'gainDb', 'qFactor']));
  if (value.recipe) {
    const recipe = ordered(value.recipe, ['measurement', 'target', 'solver', 'params']);
    for (const key of ['measurement', 'target', 'solver', 'params']) {
      const part = recipe[key];
      if (isObject(part)) {
        recipe[key] = ordered(
          part,
          key === 'params'
            ? Object.keys(part).sort()
            : key === 'solver'
              ? ['name', 'version']
              : ['source', 'name', 'sha256'],
        );
      }
    }
    result.recipe = recipe;
  }
  return JSON.stringify(result);
}

/**
 * Validate and normalize without mutating the input. Paths are JSON Pointers
 * ('' means root). All independent field errors are collected. S1 must describe
 * EXACTLY the supplied numbers and wire order, not merely round to the same code.
 * The safety gate is intentionally NOT checked here.
 * @param {unknown} obj
 * @returns {EnvelopeResult}
 */
export function validateEnvelope(obj) {
  /** @type {EnvelopeIssue[]} */
  const errors = [];
  const value = normalize(obj, errors);
  /** @param {string} path @param {EnvelopeErrorCode} code @param {string} message */
  const add = (path, code, message) => errors.push(issue(path, code, message));
  /**
   * @param {unknown} input
   * @param {string} path
   * @param {string[]} keys
   * @param {string[]} required
   * @returns {input is Record<string, unknown>}
   */
  const object = (input, path, keys, required) => {
    if (!isObject(input)) {
      add(path, 'env:type', 'Expected an object');
      return false;
    }
    for (const key of required) {
      if (!Object.hasOwn(input, key)) add(`${path}/${key}`, 'env:required', 'Required property');
    }
    for (const key of Object.keys(input)) {
      if (!keys.includes(key)) {
        add(
          `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
          'env:extra',
          'Unknown property',
        );
      }
    }
    return true;
  };
  /** @param {unknown} input @param {string} path @param {number} min @param {number} max */
  const string = (input, path, min, max) => {
    if (typeof input !== 'string') {
      add(path, 'env:type', 'Expected a string');
      return false;
    }
    const length = [...input].length;
    if (length < min || length > max) {
      add(path, 'env:length', `Expected ${min}–${max} code points`);
    }
    return true;
  };
  /** @param {unknown} input @param {string} path @param {readonly string[]} choices */
  const enumeration = (input, path, choices) => {
    if (typeof input !== 'string') add(path, 'env:type', 'Expected a string');
    else if (!choices.includes(input)) {
      add(path, 'env:enum', `Expected one of ${choices.join(', ')}`);
    }
  };
  /** @param {unknown} input @param {string} path @param {RegExp} regex */
  const pattern = (input, path, regex) => {
    if (typeof input !== 'string') add(path, 'env:type', 'Expected a string');
    else if (!regex.test(input)) add(path, 'env:pattern', 'Invalid string pattern');
  };
  /** @param {unknown} input @param {string} path @param {number} min @param {number} max @param {number} scale */
  const number = (input, path, min, max, scale) => {
    if (typeof input !== 'number' || !Number.isFinite(input)) {
      add(path, 'env:type', 'Expected a finite number');
    } else if (
      input < min ||
      input > max ||
      Math.abs(input * scale - Math.round(input * scale)) > 1e-8
    ) {
      add(path, 'env:range', `Expected [${min}, ${max}] on the ${1 / scale} grid`);
    }
  };
  if (!object(value, '', KEYS, REQUIRED)) return { ok: false, errors };
  enumeration(value.format, '/format', ['open-auri/preset@1']);
  string(value.name, '/name', 1, 48);
  string(value.description, '/description', 0, 280);
  if (Object.hasOwn(value, 'author') && value.author !== null) {
    string(value.author, '/author', 0, 24);
  }
  pattern(value.source, '/source', SOURCE);
  enumeration(value.license, '/license', ['CC0-1.0', 'CC-BY-4.0']);
  enumeration(value.lang, '/lang', ['pt-BR', 'en-US']);
  pattern(value.code, '/code', /^[A-Za-z0-9_-]{68}$(?![\s\S])/);
  number(value.preampDb, '/preampDb', -25.5, 0, 10);
  pattern(value.createdAt, '/createdAt', UTC);
  if (typeof value.createdAt === 'string' && UTC.test(value.createdAt)) {
    const date = new Date(value.createdAt);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 19) !== value.createdAt.slice(0, 19)
    ) {
      add('/createdAt', 'env:pattern', 'Expected a valid UTC calendar date');
    }
  }
  const curveStart = errors.length;
  if (!Array.isArray(value.bands)) add('/bands', 'env:type', 'Expected an array');
  else {
    if (value.bands.length !== 10) add('/bands', 'env:bands', 'Expected exactly ten bands');
    for (let index = 0; index < value.bands.length; index++) {
      const band = value.bands[index];
      const path = `/bands/${index}`;
      if (!isObject(band)) {
        add(path, 'env:bands', 'Expected a band object');
        continue;
      }
      const off = band.kind === 'OFF';
      const pass = band.kind === 'LP' || band.kind === 'HP';
      const keys = off
        ? ['kind']
        : pass
          ? ['kind', 'freqHz', 'qFactor']
          : ['kind', 'freqHz', 'gainDb', 'qFactor'];
      object(band, path, keys, keys);
      enumeration(band.kind, `${path}/kind`, ['PK', 'LS', 'HS', 'LP', 'HP', 'OFF']);
      if (!off) {
        number(band.freqHz, `${path}/freqHz`, 1, 20000, 1);
        number(band.qFactor, `${path}/qFactor`, 0.01, 20.47, 100);
        if (!pass) number(band.gainDb, `${path}/gainDb`, -25.6, 12.7, 10);
      }
    }
  }
  if (typeof value.code === 'string') {
    try {
      const decoded = decodeS1(value.code);
      if (
        errors.length === curveStart &&
        Array.isArray(value.bands) &&
        typeof value.preampDb === 'number'
      ) {
        const bands = /** @type {Band[]} */ (value.bands);
        const sameBands = decoded.bands.every((band, index) => {
          const other = bands[index];
          return Object.entries(band).every(
            ([key, entry]) => entry === /** @type {Record<string, unknown>} */ (other)[key],
          );
        });
        if (
          decoded.preampDb !== value.preampDb ||
          !sameBands ||
          encodeS1({ bands, preampDb: value.preampDb }) !== value.code
        ) {
          add(
            '/code',
            'env:code-mismatch',
            'S1 differs from bands or preampDb (wire order matters)',
          );
        }
      }
    } catch (error) {
      add('/code', 'env:s1', error instanceof Error ? error.message : String(error));
    }
  }
  if (Object.hasOwn(value, 'recipe')) {
    const recipe = value.recipe;
    if (object(recipe, '/recipe', ['measurement', 'target', 'solver', 'params'], [])) {
      for (const key of ['measurement', 'target', 'solver']) {
        if (!Object.hasOwn(recipe, key)) continue;
        const part = recipe[key];
        const path = `/recipe/${key}`;
        const required = key === 'solver' ? ['name', 'version'] : ['source', 'name'];
        const keys = key === 'measurement' ? [...required, 'sha256'] : required;
        if (!object(part, path, keys, required)) continue;
        for (const field of required) {
          const max = field === 'version' ? 32 : field === 'name' && key !== 'solver' ? 120 : 64;
          string(part[field], `${path}/${field}`, 1, max);
          if (field === 'version') pattern(part[field], `${path}/${field}`, SEMVER);
          else if (field === 'name' && key !== 'solver') {
            pattern(part[field], `${path}/${field}`, RECIPE_NAME);
          }
        }
        if (key === 'measurement' && Object.hasOwn(part, 'sha256')) {
          pattern(part.sha256, `${path}/sha256`, SHA256);
        }
      }
      if (Object.hasOwn(recipe, 'params')) {
        if (!isObject(recipe.params)) {
          add('/recipe/params', 'env:type', 'Expected an object of primitives');
        } else {
          if (Object.keys(recipe.params).length > 32) {
            add('/recipe/params', 'env:length', 'At most 32 parameters');
          }
          for (const [key, entry] of Object.entries(recipe.params)) {
            const path = `/recipe/params/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
            pattern(key, path, PARAM_KEY);
            if (typeof entry === 'string') string(entry, path, 0, 128);
            else if (
              entry !== null &&
              typeof entry !== 'boolean' &&
              !(typeof entry === 'number' && Number.isFinite(entry))
            ) {
              add(path, 'env:type', 'Expected a finite JSON primitive');
            }
          }
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  const envelope = /** @type {Envelope} */ (/** @type {unknown} */ (value));
  if (new TextEncoder().encode(stringify(envelope)).length > MAX_BYTES) {
    return { ok: false, errors: [issue('', 'env:size', 'Serialized envelope exceeds 8 KiB')] };
  }
  return { ok: true, value: envelope };
}

/**
 * Validate/normalize, then emit deterministic compact JSON. Throws EnvelopeError
 * with the same issues as validateEnvelope, including the UTF-8 8 KiB limit.
 * @param {unknown} value
 * @returns {string}
 */
export function serializeEnvelope(value) {
  const result = validateEnvelope(value);
  if (!result.ok) throw new EnvelopeError(result.errors);
  return stringify(result.value);
}

/**
 * Refuse raw text above 65536 UTF-16 units before JSON.parse, then normalize and
 * validate (one collected-error pass). The separate 8 KiB cap applies to
 * deterministic normalized serialization, not insignificant whitespace.
 * @param {string} json
 * @returns {EnvelopeResult}
 */
export function parseEnvelope(json) {
  if (typeof json !== 'string') {
    return { ok: false, errors: [issue('', 'env:type', 'Expected JSON text')] };
  }
  if (json.length > MAX_RAW_UNITS) {
    return { ok: false, errors: [issue('', 'env:size', 'Raw JSON exceeds 65536 UTF-16 units')] };
  }
  let value;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      errors: [issue('', 'env:json', error instanceof Error ? error.message : String(error))],
    };
  }
  return validateEnvelope(value);
}
