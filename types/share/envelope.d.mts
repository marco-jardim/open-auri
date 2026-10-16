import type { Band } from '../dsp/eq0xcb.mjs';
export type Primitive = string | number | boolean | null;
export type Measurement = {
    source: string;
    name: string;
    sha256?: string;
};
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
export type Envelope = {
    format: 'open-auri/preset@1';
    name: string;
    description: string;
    author?: string | null;
    source: string;
    license: 'CC0-1.0' | 'CC-BY-4.0';
    code: string;
    preampDb: number;
    bands: Band[];
    recipe?: Recipe;
    lang: 'pt-BR' | 'en-US';
    createdAt: string;
};
export type EnvelopeErrorCode = 'env:type' | 'env:required' | 'env:extra' | 'env:length' | 'env:enum' | 'env:pattern' | 'env:range' | 'env:url' | 'env:url-like' | 'env:code-mismatch' | 'env:s1' | 'env:bands' | 'env:json' | 'env:size';
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
/** A thrown normalization/serialization error; validation APIs return these issues instead. */
export declare class EnvelopeError extends Error {
    errors: EnvelopeIssue[];
    /** @param {EnvelopeIssue[]} errors */
    constructor(errors: EnvelopeIssue[]);
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
export declare function normalizeText(text: string, { multiline, path }?: {
    multiline?: boolean;
    path?: string;
}): string;
/**
 * Returns a new object, normalizing free text and defaulting description to ''.
 * Does not repair structural errors or regenerate code. Throws EnvelopeError for
 * forbidden text; use validateEnvelope for collected text AND structural errors.
 * @param {unknown} obj
 * @returns {unknown}
 */
export declare function normalizeEnvelope(obj: unknown): unknown;
/**
 * Validate and normalize without mutating the input. Paths are JSON Pointers
 * ('' means root). All independent field errors are collected. S1 must describe
 * EXACTLY the supplied numbers and wire order, not merely round to the same code.
 * The safety gate is intentionally NOT checked here.
 * @param {unknown} obj
 * @returns {EnvelopeResult}
 */
export declare function validateEnvelope(obj: unknown): EnvelopeResult;
/**
 * Validate/normalize, then emit deterministic compact JSON. Throws EnvelopeError
 * with the same issues as validateEnvelope, including the UTF-8 8 KiB limit.
 * @param {unknown} value
 * @returns {string}
 */
export declare function serializeEnvelope(value: unknown): string;
/**
 * Refuse raw text above 65536 UTF-16 units before JSON.parse, then normalize and
 * validate (one collected-error pass). The separate 8 KiB cap applies to
 * deterministic normalized serialization, not insignificant whitespace.
 * @param {string} json
 * @returns {EnvelopeResult}
 */
export declare function parseEnvelope(json: string): EnvelopeResult;
