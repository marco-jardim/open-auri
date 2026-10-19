package com.openauri.usb

/**
 * CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no input or output reflection,
 * no final XOR. Check value: `"123456789"` gives [CHECK] (0x29B1).
 *
 * A bit-by-bit port of `crc16Ccitt` in `src/dsp/eq0xcb.mjs:462-471`. The payload CRC is computed
 * over payload bytes `0 until ProtocolConstants.CRC_OFFSET` and stored little-endian in the last
 * two bytes (`src/dsp/eq0xcb.mjs:509-510`).
 */
object Crc16Ccitt {

    /** Generator polynomial (`src/dsp/eq0xcb.mjs:467`). */
    const val POLYNOMIAL: Int = 0x1021

    /** Initial register value (`src/dsp/eq0xcb.mjs:463`). */
    const val INITIAL: Int = 0xFFFF

    /** CRC of the ASCII bytes of `"123456789"` (`docs/protocol-0xcb.md:104-105`). */
    const val CHECK: Int = 0x29B1

    /** CRC of every byte of [data], in `0..0xFFFF`. */
    fun compute(data: ByteArray): Int = compute(data, 0, data.size)

    /**
     * CRC of `data[fromIndex until toIndex]`, in `0..0xFFFF`.
     *
     * @throws IllegalArgumentException unless `0 <= fromIndex <= toIndex <= data.size`.
     */
    fun compute(data: ByteArray, fromIndex: Int, toIndex: Int): Int {
        require(fromIndex >= 0 && fromIndex <= toIndex && toIndex <= data.size) {
            "invalid range $fromIndex until $toIndex for ${data.size} bytes"
        }
        var register = INITIAL
        for (index in fromIndex until toIndex) {
            register = register xor ((data[index].toInt() and 0xFF) shl 8)
            repeat(Byte.SIZE_BITS) {
                register = if ((register and 0x8000) != 0) {
                    ((register shl 1) xor POLYNOMIAL) and 0xFFFF
                } else {
                    (register shl 1) and 0xFFFF
                }
            }
        }
        return register
    }
}
