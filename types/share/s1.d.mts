/**
 * Encodes a curve as its S1 string (68 characters). Bands keep their order. The
 * lowest version that fits: v1 (1–20000 Hz), or v2 (1–32000 Hz) if and only if a
 * non-OFF band is above 20000 Hz.
 * Throws an S1Error (`s1:bands`, `s1:kind`, `s1:range`, `s1:grid`) for anything
 * that is not exactly representable; values are never rounded.
 * @param {S1Input} curve
 * @returns {string}
 */
export function encodeS1(curve: S1Input): string;
/**
 * Decodes and validates an S1 string (v1 or v2). Throws an S1Error with one of the
 * codes `s1:charset`, `s1:length`, `s1:version`, `s1:variant`, `s1:crc`, `s1:kind`,
 * `s1:range`, `s1:noncanonical` (including a v2 code without a band above 20000 Hz).
 * @param {string} s1
 * @returns {S1Curve}
 */
export function decodeS1(s1: string): S1Curve;
/**
 * Order-independent canonical key for deduplication and similarity: equal for
 * every permutation of the same bands. Integer units (Hz, 0.1 dB, 0.01 Q),
 * bands sorted by frequency, kind code, Q and gain, OFF bands last as `OFF`.
 * Prefixed by the curve's version (`v1;` or, for a band above 20000 Hz, `v2;`).
 * Validates like encodeS1. Never use this order on the wire.
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @returns {string}
 */
export function canonKey(bands: readonly Band[], preampDb: number): string;
/**
 * Stable short id of a curve in wire order: the first 12 characters of the
 * lowercase, unpadded RFC 4648 base32 of SHA-256 over the 51 S1 bytes (v1 or v2).
 * Validates the string first (same errors as decodeS1).
 * @param {string} s1
 * @returns {Promise<string>}
 */
export function curveId(s1: string): Promise<string>;
/** @import { Band } from '../dsp/eq0xcb.mjs' */
/**
 * @typedef {'s1:charset' | 's1:length' | 's1:version' | 's1:variant' | 's1:crc' | 's1:kind'
 *   | 's1:range' | 's1:noncanonical' | 's1:grid' | 's1:bands'} S1ErrorCode
 * @typedef {1 | 2} S1Version
 * @typedef {{version: S1Version, variant: number, bands: Band[], preampDb: number}} S1Curve
 * @typedef {{bands: readonly Band[], preampDb: number}} S1Input
 * @typedef {{code: number, freq: number, gain: number, q: number}} WireBand
 */
/** Value of the version field for S1 v1 (a v2 code carries 2; see S1_VERSIONS). */
export const S1_VERSION: 1;
/**
 * Versions readers accept, oldest first. Writers emit the lowest one that fits
 * the curve: v2 if and only if a non-OFF band is above S1_FREQ_MAX[1].
 */
export const S1_VERSIONS: readonly [1, 2];
/** Highest band frequency (Hz) of each version; the lowest is 1 Hz in both. */
export const S1_FREQ_MAX: Readonly<{
    readonly 1: 20000;
    readonly 2: 32000;
}>;
/** Value of the variant field for the parametric variant (the only one defined in v1 and v2). */
export const S1_VARIANT_PARAMETRIC: 0;
/** Size of an S1 code in bytes (v1 and v2). */
export const S1_BYTES: 51;
/** Size of an S1 code in base64url characters, no padding (v1 and v2). */
export const S1_LENGTH: 68;
/**
 * Kind codes on the wire (3 bits). Frozen by the format: this table is owned by
 * S1, not derived from the codec, so the codec may reorder its list freely.
 */
export const S1_KIND_CODES: readonly ["PK", "LS", "HS", "LP", "HP", "OFF"];
/** Typed error with a stable `code` (see docs/s1-format.md). */
export class S1Error extends Error {
    /**
     * @param {S1ErrorCode} code
     * @param {string} message
     */
    constructor(code: S1ErrorCode, message: string);
    /** @type {S1ErrorCode} */
    code: S1ErrorCode;
}
export type S1ErrorCode = "s1:charset" | "s1:length" | "s1:version" | "s1:variant" | "s1:crc" | "s1:kind" | "s1:range" | "s1:noncanonical" | "s1:grid" | "s1:bands";
export type S1Version = 1 | 2;
export type S1Curve = {
    version: S1Version;
    variant: number;
    bands: Band[];
    preampDb: number;
};
export type S1Input = {
    bands: readonly Band[];
    preampDb: number;
};
export type WireBand = {
    code: number;
    freq: number;
    gain: number;
    q: number;
};
import type { Band } from '../dsp/eq0xcb.mjs';
