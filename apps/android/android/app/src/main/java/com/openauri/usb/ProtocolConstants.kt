package com.openauri.usb

/**
 * Constants of the 0xCB wire protocol, copied from the JavaScript core, which stays the single
 * source of truth (`src/dsp/eq0xcb.mjs`, `src/transport/webhid.mjs`, `docs/protocol-0xcb.md`).
 *
 * Each constant cites the line it was copied from. `ProtocolFixtureTest` reads those files as
 * text on every test run and fails if any value here drifts from the JavaScript.
 *
 * Byte sequences are returned as fresh copies, so no caller can change what the guard compares
 * against.
 */
object ProtocolConstants {

    /** HID report ID of every 0xCB output report: `src/dsp/eq0xcb.mjs:47` (`HID_REPORT_ID = 0xcb`). */
    const val HID_REPORT_ID: Int = 0xCB

    /** Data bytes per output report, report ID excluded: `src/dsp/eq0xcb.mjs:66` (`REPORT_SIZE = 31`). */
    const val REPORT_SIZE: Int = 31

    /** Data reports per write, before the commit: `src/dsp/eq0xcb.mjs:67` (`REPORT_COUNT = 9`). */
    const val REPORT_COUNT: Int = 9

    /**
     * Payload bytes carried by the 9 data reports (14 preamble, 4 preamp, 200 coefficients,
     * 2 CRC): `src/dsp/eq0xcb.mjs:64` (`PAYLOAD_SIZE = 220`).
     */
    const val PAYLOAD_SIZE: Int = 220

    /**
     * Offset of the report index inside a data report: `docs/protocol-0xcb.md:120-123`
     * (`pacote[i] = [ i, blob[30*i .. 30*i+29] ]`), as built at `src/dsp/eq0xcb.mjs:541`.
     */
    const val REPORT_INDEX_OFFSET: Int = 0

    /**
     * Offset of the payload slice inside a data report: `docs/protocol-0xcb.md:120-123`, as built
     * at `src/dsp/eq0xcb.mjs:542`.
     */
    const val REPORT_DATA_OFFSET: Int = 1

    /**
     * Payload bytes per data report: report `i` carries payload bytes `30*i until 30*i+30`, and the
     * bytes past the payload's end are zero (`docs/protocol-0xcb.md:120-123`,
     * `src/dsp/eq0xcb.mjs:85`: `REPORT_DATA_SIZE = REPORT_SIZE - 1`).
     */
    const val REPORT_DATA_SIZE: Int = REPORT_SIZE - 1

    /**
     * Offset of the CRC-16 in the payload: the CRC of payload bytes `0 until 218` is appended as
     * two little-endian bytes (`src/dsp/eq0xcb.mjs:509-510`).
     */
    const val CRC_OFFSET: Int = PAYLOAD_SIZE - 2

    /**
     * Minimum time between two commits (flash writes) on the same device:
     * `src/transport/webhid.mjs:116` (`WRITE_SPACING_MS = 2000`).
     */
    const val WRITE_SPACING_MS: Long = 2000L

    /** `src/dsp/eq0xcb.mjs:56`; never handed out, only copied. */
    private val preambleBytes: ByteArray = bytesOf(
        0x45, 0x51, 0x31, 0x23, 0xD6, 0x00, 0x00, 0x0A, 0x04, 0x05, 0x01, 0x0A, 0x00, 0x00,
    )

    /** `src/dsp/eq0xcb.mjs:61`; never handed out, only copied. */
    private val commitCommandBytes: ByteArray = bytesOf(0x01, 0x65, 0x00, 0x01, 0xFF)

    /**
     * The 14-byte payload preamble (ASCII `EQ1#`, length and layout bytes):
     * `src/dsp/eq0xcb.mjs:56` (`PREAMBLE`). Returns a new array on every call.
     */
    fun preamble(): ByteArray = preambleBytes.copyOf()

    /**
     * The bare 5-byte commit command that persists the preset to flash:
     * `src/dsp/eq0xcb.mjs:61` (`COMMIT_COMMAND`). Returns a new array on every call.
     */
    fun commitCommand(): ByteArray = commitCommandBytes.copyOf()

    /**
     * The commit report exactly as the transport sends it: the commit command zero-padded to
     * [REPORT_SIZE] bytes, `src/dsp/eq0xcb.mjs:562` (`commitReport()`). Returns a new array on
     * every call.
     */
    fun commitReport(): ByteArray = commitCommandBytes.copyOf(REPORT_SIZE)

    private fun bytesOf(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }
}
