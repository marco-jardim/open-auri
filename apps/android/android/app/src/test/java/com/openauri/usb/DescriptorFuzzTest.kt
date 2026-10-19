package com.openauri.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class DescriptorFuzzTest {
    @Test(timeout = 10_000)
    fun tenThousandSeededDescriptorsOnlyProduceTypedFailuresAndBoundedFrames() {
        val random = Random(0x0CB2026)
        val samples = listOf(
            FakeUsbBackend.DEFAULT_REPORT_DESCRIPTOR,
            HidDescriptorSamples.bootKeyboard,
            HidDescriptorSamples.gamepad,
            HidDescriptorSamples.vendorRawHid,
        )
        val casesByKind = IntArray(8)
        var parsedCount = 0
        var rejectedCount = 0
        var framedCount = 0
        var framingRejectedCount = 0
        repeat(10_000) { iteration ->
            val kind = iteration % casesByKind.size
            casesByKind[kind]++
            val source = samples[random.nextInt(samples.size)]
            val bytes = descriptor(kind, source, random)
            val parsed = try {
                HidReportDescriptor.parse(bytes)
            } catch (malformed: HidDescriptorException) {
                assertTrue("case $iteration offset", malformed.offset in 0..bytes.size)
                rejectedCount++
                null
            }
            if (parsed != null) {
                parsedCount++
                // No broad catch: any non-domain exception fails with the seed and case in the stack.
                val length = try {
                    HidFraming.paddedLength(parsed)
                } catch (invalid: HidFramingException) {
                    framingRejectedCount++
                    assertTrue(invalid.message.orEmpty().isNotBlank())
                    null
                }
                if (length != null) assertTrue("case $iteration length $length", length in 0..65_536)
                for (reportId in parsed.outputReportIds) {
                    val size = checkNotNull(parsed.reports[reportId]).outputBytes
                    // Empty, partial, full and oversized data also exercise framing's typed errors.
                    for (dataSize in listOf(0, size / 2, size, size + 1).distinct()) {
                        val data = random.nextBytes(dataSize)
                        val snapshot = data.copyOf()
                        try {
                            val wire = HidFraming.buildOutput(reportId, data, parsed)
                            assertTrue("case $iteration report $reportId", wire.size <= 65_536)
                            assertEquals(length, wire.size)
                            val prefix = if (parsed.usesReportIds) 1 else 0
                            if (prefix == 1) assertEquals(reportId.toByte(), wire[0])
                            assertArrayEquals(data, wire.copyOfRange(prefix, prefix + data.size))
                            assertTrue(wire.drop(prefix + data.size).all { it == 0.toByte() })
                            framedCount++
                        } catch (invalid: HidFramingException) {
                            framingRejectedCount++
                            assertTrue(invalid.message.orEmpty().isNotBlank())
                        }
                        assertArrayEquals("case $iteration input must not change", snapshot, data)
                    }
                }
            }
        }
        assertEquals(10_000, parsedCount + rejectedCount)
        assertTrue(casesByKind.all { it == 1250 })
        assertTrue("successful parses must exercise framing", framedCount > 1000)
        assertTrue("malformed descriptors must be exercised", rejectedCount > 1000)
        assertTrue("typed framing rejections must be exercised", framingRejectedCount > 0)
    }

    private fun descriptor(kind: Int, source: ByteArray, random: Random): ByteArray = when (kind) {
        0, 1 -> random.nextBytes(random.nextInt(513))
        2 -> source.copyOf().also { bytes ->
            repeat(random.nextInt(1, 5)) {
                val offset = random.nextInt(bytes.size)
                bytes[offset] = (bytes[offset].toInt() xor (1 shl random.nextInt(8))).toByte()
            }
        }
        3 -> source.copyOf(random.nextInt(source.size + 1))
        4 -> insert(source, random.nextInt(source.size + 1), random.nextBytes(random.nextInt(1, 17)))
        5 -> {
            val length = random.nextInt(256)
            val longItem = byteArrayOf(0xFE.toByte(), length.toByte(), random.nextInt(256).toByte()) +
                random.nextBytes(length)
            val mutated = insert(source, random.nextInt(source.size + 1), longItem)
            if (random.nextBoolean()) mutated else mutated.copyOf(random.nextInt(mutated.size + 1))
        }
        6 -> {
            // Override Size and Count immediately before a real Output main item, using uint32s.
            val output = source.indices.first { source[it] == 0x91.toByte() }
            val huge = listOf(65_536L, 0x7FFFFFFFL, 0x80000000L, 0xFFFFFFFFL)
            val size = if (random.nextBoolean()) 8L else huge[random.nextInt(huge.size)]
            val count = huge[random.nextInt(huge.size)]
            insert(source, output, uint32Item(0x77, size) + uint32Item(0x97, count))
        }
        else -> {
            // A valid long item at an item boundary guarantees a substantial successful corpus.
            val length = random.nextInt(32)
            byteArrayOf(0xFE.toByte(), length.toByte(), random.nextInt(256).toByte()) +
                random.nextBytes(length) + source
        }
    }

    private fun uint32Item(prefix: Int, value: Long): ByteArray =
        byteArrayOf(prefix.toByte()) + ByteArray(4) { (value ushr (it * 8)).toByte() }

    private fun insert(source: ByteArray, offset: Int, extra: ByteArray): ByteArray =
        source.copyOfRange(0, offset) + extra + source.copyOfRange(offset, source.size)
}
