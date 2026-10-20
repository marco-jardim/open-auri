package com.openauri.usb

import com.openauri.usb.ProtocolConstants.CRC_OFFSET
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** CRC-16/CCITT-FALSE, checked against the standard vectors and the codec's reference payloads. */
class Crc16CcittTest {

    @Test
    fun parametersAreCcittFalse() {
        assertEquals(0x1021, Crc16Ccitt.POLYNOMIAL)
        assertEquals(0xFFFF, Crc16Ccitt.INITIAL)
        assertEquals(0x29B1, Crc16Ccitt.CHECK)
    }

    @Test
    fun checkValueOf123456789() {
        assertEquals(Crc16Ccitt.CHECK, Crc16Ccitt.compute("123456789".toByteArray(Charsets.US_ASCII)))
    }

    @Test
    fun standardVectors() {
        // No final XOR: the CRC of nothing is the initial value.
        assertEquals(0xFFFF, Crc16Ccitt.compute(ByteArray(0)))
        assertEquals(0xB915, Crc16Ccitt.compute("A".toByteArray(Charsets.US_ASCII)))
    }

    @Test
    fun matchesAnIndependentBitSerialImplementation() {
        val random = Random(0x1021)
        repeat(500) {
            val data = random.nextBytes(random.nextInt(0, 300))
            val crc = Crc16Ccitt.compute(data)
            assertEquals(bitSerialCrc(data), crc)
            assertTrue(crc in 0..0xFFFF)
        }
        // Every byte value, so the sign of bytes 0x80..0xFF never leaks into the register.
        val everyByte = ByteArray(256) { it.toByte() }
        assertEquals(bitSerialCrc(everyByte), Crc16Ccitt.compute(everyByte))
    }

    @Test
    fun rangeOverloadCoversOnlyTheRange() {
        val data = Random(7).nextBytes(64)
        assertEquals(Crc16Ccitt.compute(data.copyOfRange(3, 40)), Crc16Ccitt.compute(data, 3, 40))
        assertEquals(Crc16Ccitt.compute(data), Crc16Ccitt.compute(data, 0, data.size))
        assertEquals(Crc16Ccitt.INITIAL, Crc16Ccitt.compute(data, 64, 64))
    }

    @Test
    fun invalidRangesAreRefused() {
        val data = ByteArray(8)
        assertThrows(IllegalArgumentException::class.java) { Crc16Ccitt.compute(data, -1, 4) }
        assertThrows(IllegalArgumentException::class.java) { Crc16Ccitt.compute(data, 5, 4) }
        assertThrows(IllegalArgumentException::class.java) { Crc16Ccitt.compute(data, 0, 9) }
    }

    @Test
    fun matchesTheCrcTheCodecPlacesInEveryReferencePayload() {
        // encodePayload (src/dsp/eq0xcb.mjs:509-510): the CRC of bytes 0 until 218, appended
        // little-endian as bytes 218 and 219.
        var bigEndianMismatches = 0
        for (preset in ProtocolFixtureTest.presets) {
            val payload = preset.payload
            val low = payload[CRC_OFFSET].toInt() and 0xFF
            val high = payload[CRC_OFFSET + 1].toInt() and 0xFF
            val crc = Crc16Ccitt.compute(payload, 0, CRC_OFFSET)
            assertEquals(preset.name, low or (high shl 8), crc)
            if ((high or (low shl 8)) != crc) bigEndianMismatches++
        }
        assertTrue("byte order not pinned down by the fixture", bigEndianMismatches > 0)
    }

    /** CRC-16/CCITT-FALSE fed one message bit at a time, most significant bit first. */
    private fun bitSerialCrc(data: ByteArray): Int {
        var crc = 0xFFFF
        for (byte in data) {
            for (bit in 7 downTo 0) {
                val messageBit = (byte.toInt() shr bit) and 1
                val topBit = (crc shr 15) and 1
                crc = (crc shl 1) and 0xFFFF
                if ((messageBit xor topBit) == 1) crc = crc xor 0x1021
            }
        }
        return crc
    }
}
