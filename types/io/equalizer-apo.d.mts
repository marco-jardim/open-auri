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
export function parseEqualizerApo(text: string): {
    preampDb: number;
    bands: Band[];
    warnings: EqualizerApoWarning[];
};
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
export function serializeEqualizerApo({ preampDb, bands }: EqualizerApoPreset): string;
/** A format error, with a stable code/message and a one-based source line. */
export class EqualizerApoError extends Error {
    /**
     * @param {EqualizerApoErrorCode} code
     * @param {number} line Source line, or the canonical output line when serializing.
     */
    constructor(code: EqualizerApoErrorCode, line: number);
    code: "apo:lsq-hsq" | "apo:pass-gain" | "apo:too-many-filters" | "apo:malformed" | "apo:unknown-type" | "apo:number" | "apo:missing-field";
    line: number;
}
export type Band = import("../dsp/eq0xcb.mjs").Band;
export type EqualizerApoPreset = {
    preampDb: number;
    bands: readonly Band[];
};
export type EqualizerApoWarning = {
    line: number;
    text: string;
};
export type EqualizerApoErrorCode = keyof typeof ERROR_MESSAGES;
/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} Band
 * @typedef {{preampDb: number, bands: readonly Band[]}} EqualizerApoPreset
 * @typedef {{line: number, text: string}} EqualizerApoWarning
 * @typedef {keyof typeof ERROR_MESSAGES} EqualizerApoErrorCode
 */
declare const ERROR_MESSAGES: Readonly<{
    'apo:lsq-hsq': "LSQ and HSQ are not supported: their Q semantics differ from the codec.";
    'apo:pass-gain': "Pass filters cannot represent non-zero gain.";
    'apo:too-many-filters': "At most 10 filters are supported; no filters were truncated.";
    'apo:malformed': "Malformed EqualizerAPO directive.";
    'apo:unknown-type': "Unsupported EqualizerAPO filter type.";
    'apo:number': "Expected a finite decimal number.";
    'apo:missing-field': "A required EqualizerAPO field is missing.";
}>;
export {};
