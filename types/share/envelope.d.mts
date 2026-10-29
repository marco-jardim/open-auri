/**
 * NFKC, invisible-control removal, whitespace collapse and trim. Description keeps
 * LF line boundaries (at most five lines); all other C0/C1 controls are refused
 * BEFORE whitespace collapse, so tabs/newlines cannot be laundered into a name.
 * Text that is not well-formed UTF-16 (a lone surrogate) is refused (env:pattern).
 * Throws EnvelopeError for invalid input, controls, ill-formed text, line count or
 * URL-like text. Length bounds belong to the field validator and count Unicode code points.
 * @param {string} text
 * @param {{multiline?: boolean, path?: string}} [options]
 * @returns {string}
 */
export function normalizeText(text: string, { multiline, path }?: {
    multiline?: boolean;
    path?: string;
}): string;
/**
 * Filter labels by wire index, as `open-auri/preset@2` stores them: each entry goes
 * through the same normalization as `name` (NFKC, invisibles stripped, controls, lone
 * surrogates and URL/domain/IP text refused), empty text becomes null, then exactly LABEL_COUNT
 * entries of 1–LABEL_MAX code points or null. Returns null when every entry is null
 * (the key is omitted). Strict by default: throws EnvelopeError with every issue
 * (env:type, env:labels, env:length, env:pattern, env:url, env:url-like; paths
 * `/labels/i`). `lenient` never throws: a refused entry becomes null and a list that
 * is not an array of LABEL_COUNT entries becomes null (local state, old records).
 * Labels never take part in S1, curveId, canonKey or the safety gate.
 * @param {unknown} input
 * @param {{lenient?: boolean}} [options]
 * @returns {Labels | null}
 */
export function normalizeLabels(input: unknown, { lenient }?: {
    lenient?: boolean;
}): Labels | null;
/**
 * The lowest envelope format that carries this curve, the one writers emit:
 * `open-auri/preset@2` when filter labels are set or a non-OFF band is above
 * 20000 Hz (an S1 v2 curve), `open-auri/preset@1` otherwise. Labels are set unless
 * null, undefined or LABEL_COUNT entries that all normalize to null (an envelope
 * then omits the key). Only picks the format: validate the envelope afterwards.
 * @param {{bands?: unknown, labels?: unknown}} curve
 * @returns {EnvelopeFormat}
 */
export function envelopeFormat(curve: {
    bands?: unknown;
    labels?: unknown;
}): EnvelopeFormat;
/**
 * Returns a new object, normalizing free text and defaulting description to ''.
 * Does not repair structural errors or regenerate code. Throws EnvelopeError for
 * forbidden text; use validateEnvelope for collected text AND structural errors.
 * @param {unknown} obj
 * @returns {unknown}
 */
export function normalizeEnvelope(obj: unknown): unknown;
/**
 * Validate and normalize without mutating the input. Paths are JSON Pointers
 * ('' means root). All independent field errors are collected. S1 must describe
 * EXACTLY the supplied numbers and wire order, not merely round to the same code.
 * Bands go up to 20000 Hz in `@1` and 32000 Hz in `@2` (env:range); an S1 v2 code
 * needs `@2` (env:s1). The safety gate is intentionally NOT checked here.
 * @param {unknown} obj
 * @returns {EnvelopeResult}
 */
export function validateEnvelope(obj: unknown): EnvelopeResult;
/**
 * Validate/normalize, then emit deterministic compact JSON. Throws EnvelopeError
 * with the same issues as validateEnvelope, including the UTF-8 8 KiB limit.
 * @param {unknown} value
 * @returns {string}
 */
export function serializeEnvelope(value: unknown): string;
/**
 * Refuse raw text above 65536 UTF-16 units before JSON.parse, then normalize and
 * validate (one collected-error pass). The separate 8 KiB cap applies to
 * deterministic normalized serialization, not insignificant whitespace.
 * @param {string} json
 * @returns {EnvelopeResult}
 */
export function parseEnvelope(json: string): EnvelopeResult;
/** Filter labels by wire index (`open-auri/preset@2`). */
export const LABEL_COUNT: 10;
/** Longest filter label, in normalized code points. */
export const LABEL_MAX: 24;
/** A thrown normalization/serialization error; validation APIs return these issues instead. */
export class EnvelopeError extends Error {
    /** @param {EnvelopeIssue[]} errors */
    constructor(errors: EnvelopeIssue[]);
    errors: EnvelopeIssue[];
}
export type Primitive = string | number | boolean | null;
export type Measurement = {
    source: string;
    name: string;
    sha256?: string;
};
/**
 * Recipe limits (normalized code points): source/solver name 64, measurement or
 * target filename 120, solver SemVer version 32; at most 32 params with ASCII keys of 1–32
 * characters and primitive values (strings at most 128, numbers finite).
 */
export type Recipe = {
    measurement?: Measurement;
    target?: {
        source: string;
        name: string;
    };
    solver?: {
        name: string;
        version: string;
    };
    params?: Record<string, Primitive>;
};
/**
 * Filter labels (`open-auri/preset@2` only): exactly LABEL_COUNT entries by wire
 * index, each 1–LABEL_MAX normalized code points or null (automatic name). An
 * all-null list is omitted. Labels are presentation only: never part of S1,
 * curveId, canonKey or the safety gate.
 */
export type Labels = (string | null)[];
/**
 * `open-auri/preset@1`: S1 v1, bands up to 20000 Hz, no labels. `open-auri/preset@2`:
 * `@1` plus optional labels, bands up to 32000 Hz and an S1 v1 or v2 code. Writers
 * emit the lowest format that fits (envelopeFormat).
 */
export type EnvelopeFormat = "open-auri/preset@1" | "open-auri/preset@2";
/**
 * Fields shared by every envelope format.
 */
export type EnvelopeFields = {
    name: string;
    description: string;
    author?: string | null;
    source: string;
    license: "CC0-1.0" | "CC-BY-4.0";
    code: string;
    preampDb: number;
    bands: Band[];
    recipe?: Recipe;
    lang: "pt-BR" | "en-US";
    createdAt: string;
};
/**
 * `open-auri/preset@1`: an S1 v1 code, bands up to 20000 Hz, never labels (a
 * `labels` key is env:extra).
 */
export type EnvelopeV1 = EnvelopeFields & {
    format: "open-auri/preset@1";
    labels?: never;
};
/**
 * `open-auri/preset@2`: an S1 v1 or v2 code, bands up to 32000 Hz and optional
 * filter labels (omitted when every entry is null).
 */
export type EnvelopeV2 = EnvelopeFields & {
    format: "open-auri/preset@2";
    labels?: Labels;
};
/**
 * A validated envelope, discriminated by `format`.
 */
export type Envelope = EnvelopeV1 | EnvelopeV2;
export type EnvelopeErrorCode = "env:type" | "env:required" | "env:extra" | "env:length" | "env:enum" | "env:pattern" | "env:range" | "env:url" | "env:url-like" | "env:code-mismatch" | "env:s1" | "env:bands" | "env:labels" | "env:json" | "env:size";
export type EnvelopeIssue = {
    path: string;
    code: EnvelopeErrorCode;
    message: string;
};
export type EnvelopeResult = {
    ok: true;
    value: Envelope;
} | {
    ok: false;
    errors: EnvelopeIssue[];
};
import type { Band } from '../dsp/eq0xcb.mjs';
