export type GainBand = {
    kind: 'PK' | 'LS' | 'HS';
    freqHz: number;
    gainDb: number;
    qFactor: number;
};
export type PassBand = {
    kind: 'LP' | 'HP';
    freqHz: number;
    gainDb?: number;
    qFactor: number;
};
export type Band = GainBand | PassBand | {
    kind: 'OFF';
};
export type Section = {
    b0: number;
    b1: number;
    b2: number;
    a1: number;
    a2: number;
};
/**
 * @typedef {{kind: 'PK' | 'LS' | 'HS', freqHz: number, gainDb: number, qFactor: number}} GainBand
 * @typedef {{kind: 'LP' | 'HP', freqHz: number, gainDb?: number, qFactor: number}} PassBand
 * @typedef {GainBand | PassBand | {kind: 'OFF'}} Band
 * @typedef {{b0: number, b1: number, b2: number, a1: number, a2: number}} Section
 */
export declare const USB_VID = 13058;
export declare const USB_PID = 35074;
export declare const HID_REPORT_ID = 203;
/** Sample rate the coefficients are designed for. */
export declare const SAMPLE_RATE = 96000;
/** Number of biquad sections the firmware stores. */
export declare const BAND_COUNT = 10;
/** Fixed 14-byte prologue: ASCII "EQ1#", then (hypothesis) a u16 LE length and layout bytes. */
export declare const PREAMBLE: readonly number[];
/** Commit command as the reference sends it (5 bytes): persists the preset to flash. */
export declare const COMMIT_COMMAND: readonly number[];
/** Payload size in bytes: 14 preamble + 4 preamp + 10*5*4 coefficients + 2 CRC. */
export declare const PAYLOAD_SIZE = 220;
export declare const REPORT_SIZE = 31;
export declare const REPORT_COUNT = 9;
/**
 * Supported filter kinds. `OFF` is an exact pass-through section
 * (wire words [1, 0, 0, 0, 0]); prefer it to a 0 dB peaking band, which still
 * runs poles close to the unit circle.
 */
export declare const FILTER_KINDS: readonly string[];
/** @type {Readonly<{kind: 'OFF'}>} */
export declare const OFF: Readonly<{
    kind: 'OFF';
}>;
/** Ten exact pass-through sections: the known-good neutral preset. */
export declare const NEUTRAL_BANDS: readonly Readonly<{
    kind: 'OFF';
}>[];
/**
 * Peaking EQ — AutoEq `Peaking.biquad_coefficients`.
 * @param {number} freqHz
 * @param {number} gainDb
 * @param {number} qFactor
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export declare function designPeaking(freqHz: number, gainDb: number, qFactor: number, sampleRate?: number): Section;
/**
 * Low shelf — AutoEq `LowShelf.biquad_coefficients`.
 * @param {number} freqHz
 * @param {number} gainDb
 * @param {number} qFactor
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export declare function designLowShelf(freqHz: number, gainDb: number, qFactor: number, sampleRate?: number): Section;
/**
 * High shelf — AutoEq `HighShelf.biquad_coefficients`.
 * @param {number} freqHz
 * @param {number} gainDb
 * @param {number} qFactor
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export declare function designHighShelf(freqHz: number, gainDb: number, qFactor: number, sampleRate?: number): Section;
/**
 * 2nd-order low pass — RBJ Audio EQ Cookbook.
 * @param {number} freqHz
 * @param {number} qFactor
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export declare function designLowPass(freqHz: number, qFactor: number, sampleRate?: number): Section;
/**
 * 2nd-order high pass — RBJ Audio EQ Cookbook.
 * @param {number} freqHz
 * @param {number} qFactor
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export declare function designHighPass(freqHz: number, qFactor: number, sampleRate?: number): Section;
/**
 * Section coefficients for a band `{ kind, freqHz, gainDb, qFactor }`. Throws on
 * an unknown kind: codes such as `LSQ`/`HSQ` (EqualizerAPO, hangout.audio) must
 * be mapped explicitly by the caller, never guessed.
 * @param {Band} band
 * @param {number} [sampleRate]
 * @returns {Section}
 */
export declare function designSection(band: Band, sampleRate?: number): Section;
/**
 * One-read copy of a band list, taken before any check, so every later check and
 * the encoded bytes see the same values whatever the caller passes (getters,
 * Proxies, objects mutated in between).
 *
 * Reads `bands.length` once, then each index 0..length−1 once, in order, and of
 * each element `kind`, `freqHz`, `gainDb` and `qFactor` exactly once each, in
 * that order, even for OFF. Each element becomes a new frozen plain object:
 * `{kind: 'OFF'}` for OFF, otherwise `kind` plus the other three fields as read,
 * omitting those that read as `undefined`. LP/HP carry no gain: a `gainDb` that
 * reads as exactly 0 (or −0) is dropped, so an accepted LP/HP snapshot never
 * has `gainDb`; any other LP/HP gain is kept so that {@link checkBand} refuses
 * it. Nothing is coerced or validated here: the codec rejects invalid values,
 * including non-primitive ones (kept by reference, never converted; consumers
 * such as the S1 codec map them to their own errors).
 *
 * Throws a TypeError for a non-array (`bands must be an array`), for a hole
 * (`band <i>: missing (hole in a sparse array)`; holes are never skipped) and for
 * a non-object element (`band <i>: not an object`, the codec's own message).
 * With `expectedLength`, a different length throws `RangeError('expected <n>
 * bands')` before any element is read. Errors thrown by getters or Proxy traps
 * propagate unchanged.
 * @param {unknown} bands
 * @param {number} [expectedLength]
 * @returns {readonly Readonly<Band>[]} A frozen array of frozen bands.
 */
export declare function snapshotBands(bands: unknown, expectedLength?: number): readonly Readonly<Band>[];
/**
 * Rejects bands whose parameters cannot describe a valid filter at SAMPLE_RATE.
 *
 * Throws a TypeError for a non-object band, an unknown kind or a field that is
 * not a primitive (object, function, symbol), and a RangeError for out-of-range
 * or non-finite values. LP/HP take no gain: `gainDb` must be absent or exactly
 * 0 (−0 included); anything else (non-zero, NaN, a string) is a RangeError.
 * Each field is read once; values are never coerced, not even for messages.
 * @param {Band} band
 * @param {number} [index]
 */
export declare function checkBand(band: Band, index?: number): void;
/**
 * Jury criterion for 1 + a1 z^-1 + a2 z^-2: both poles strictly inside the unit circle.
 * @param {number} a1
 * @param {number} a2
 */
export declare function isStable(a1: number, a2: number): boolean;
/**
 * Quantizes one section to its 5 wire words `[b0, b2, -a1, b1, -a2]` (Q27).
 * Stability is checked on the quantized feedback words, which is what the chip
 * will actually run.
 * @param {Section} section
 * @param {number} [index]
 */
export declare function encodeSection(section: Section, index?: number): number[];
/**
 * Q23 linear-gain word for a preamp in dB. The preamp runs before the bands,
 * so a positive value clips full-scale content: it is refused.
 */
export declare function preampWord(preampDb?: number): number;
/**
 * CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no final XOR).
 * @param {Iterable<number>} data
 */
export declare function crc16Ccitt(data: Iterable<number>): number;
/**
 * Builds the 220-byte payload for 10 bands and a preamp. Bands are written in
 * the order given: keep cuts before boosts (see docs/protocol-0xcb.md), the
 * ordering the reference uses to avoid internal clipping.
 *
 * The bands are copied once with {@link snapshotBands} before anything else, so
 * every check and every byte comes from the same read of each field. Throws a
 * RangeError for a non-array or a count other than 10, a TypeError for holes,
 * non-object elements and unknown kinds, and a RangeError for invalid values;
 * it never returns anything but a 220-byte payload.
 * @param {readonly Band[]} eqBands
 * @param {number} [preampDb] Must be a finite number <= 0 (nothing is coerced).
 * @returns {number[]}
 */
export declare function encodePayload(eqBands: readonly Band[], preampDb?: number): number[];
/**
 * Splits an already encoded payload into the 9 HID reports: byte 0 is the report
 * index, bytes 1..30 carry 30 bytes of the payload (the last report is
 * zero-padded). Throws a RangeError unless `payload` holds exactly 220 bytes
 * (integers 0..255) whose last two are the little-endian CRC-16 of the rest, so
 * a transport can send exactly the bytes a gate approved, without re-encoding.
 * @param {ArrayLike<number>} payload
 * @returns {Uint8Array[]}
 */
export declare function reportsFromPayload(payload: ArrayLike<number>): Uint8Array[];
/**
 * The 9 HID reports for 10 bands and a preamp:
 * `reportsFromPayload(encodePayload(eqBands, preampDb))`.
 * @param {readonly Band[]} eqBands
 * @param {number} [preampDb]
 */
export declare function encodeReports(eqBands: readonly Band[], preampDb?: number): Uint8Array<ArrayBufferLike>[];
/**
 * The commit command zero-padded to the 31-byte report size, so every transport
 * sends the same bytes. The reference sends the bare 5 bytes; whether the
 * firmware distinguishes the two is unverified.
 */
export declare function commitReport(): Uint8Array<ArrayBuffer>;
/**
 * Magnitude response (dB) of `eqBands` at `freqHz`, summed across sections.
 *
 * Each polynomial p0 + p1 z^-1 + p2 z^-2 is evaluated around z^-1 = 1, with
 * u = 1 - e^-jw = 2 sin^2(w/2) + j sin w, as S - T u + p2 u^2 where
 * S = p0 + p1 + p2 and T = p1 + 2 p2. Near DC, where low-frequency poles and
 * zeros cluster, this avoids the cancellation that costs other forms precision.
 * Worst error against an exact (200-bit) evaluation of the same coefficients,
 * measured on ~27 000 cases: 6e-14 dB, against 4e-9 dB for the direct form and
 * 1.5e-7 dB for AutoEq's phi form (PEQFilter.fr), which is why that one is not
 * used here.
 * @param {readonly Band[]} eqBands
 * @param {number} freqHz
 * @param {number} [sampleRate]
 */
export declare function magnitudeDb(eqBands: readonly Band[], freqHz: number, sampleRate?: number): number;
