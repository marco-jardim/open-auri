package com.openauri.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class HidFramingTest {

    private val cb5100 = HidReportDescriptor.parse(HidDescriptorSamples.cb5100)
    private val multiOutput = HidReportDescriptor.parse(HidDescriptorSamples.multiOutput)
    private val vendorRawHid = HidReportDescriptor.parse(HidDescriptorSamples.vendorRawHid)
    private val bootKeyboard = HidReportDescriptor.parse(HidDescriptorSamples.bootKeyboard)
    private val gamepad = HidReportDescriptor.parse(HidDescriptorSamples.gamepad)
    private val implicitReportZero = HidReportDescriptor.parse(HidDescriptorSamples.implicitReportZero)

    /** Bytes 1, 2, 3, ... so that misplaced or dropped bytes are visible. */
    private fun ramp(size: Int): ByteArray = ByteArray(size) { (it + 1).toByte() }

    private fun notAnOutputReport(reportId: Int, descriptor: ParsedDescriptor) {
        val error = assertThrows(HidFramingException.NotAnOutputReport::class.java) {
            HidFraming.buildOutput(reportId, ByteArray(1), descriptor)
        }
        assertEquals(reportId, error.reportId)
    }

    private fun outOfRange(name: String, value: Int, min: Int, max: Int, block: () -> Unit) {
        val error = assertThrows(HidFramingException.ArgumentOutOfRange::class.java) { block() }
        assertEquals(name, error.name)
        assertEquals(value, error.value)
        assertEquals(min, error.min)
        assertEquals(max, error.max)
    }

    @Test
    fun cb5100FrameIsReportIdPlus31DataBytes() {
        val data = ramp(31)

        val frame = HidFraming.buildOutput(0xCB, data, cb5100)

        assertEquals(32, frame.size)
        assertEquals(32, HidFraming.paddedLength(cb5100))
        assertArrayEquals(byteArrayOf(0xCB.toByte()) + data, frame)
    }

    @Test
    fun shorterDataIsZeroPaddedTo32Bytes() {
        for (size in listOf(0, 30, 31)) {
            val data = ramp(size)

            val frame = HidFraming.buildOutput(0xCB, data, cb5100)

            assertArrayEquals("data of $size bytes", byteArrayOf(0xCB.toByte()) + data + ByteArray(31 - size), frame)
        }
    }

    @Test
    fun dataLongerThanTheDeclaredReportIsRefused() {
        val error = assertThrows(HidFramingException.DataTooLong::class.java) {
            HidFraming.buildOutput(0xCB, ramp(32), cb5100)
        }

        assertEquals(0xCB, error.reportId)
        assertEquals(32, error.length)
        assertEquals(31, error.maxLength)
    }

    @Test
    fun severalOutputReportsPadToTheLargestPlusOne() {
        assertEquals(63, multiOutput.maxOutputReportBytes)
        assertEquals(64, HidFraming.paddedLength(multiOutput))

        val data = ramp(31)
        assertArrayEquals(
            byteArrayOf(0xCB.toByte()) + data + ByteArray(32),
            HidFraming.buildOutput(0xCB, data, multiOutput),
        )
        assertArrayEquals(
            byteArrayOf(1) + ramp(8) + ByteArray(55),
            HidFraming.buildOutput(1, ramp(8), multiOutput),
        )
        assertArrayEquals(byteArrayOf(3) + ramp(63), HidFraming.buildOutput(3, ramp(63), multiOutput))

        // Each report keeps its own limit even though the buffer is longer.
        val error = assertThrows(HidFramingException.DataTooLong::class.java) {
            HidFraming.buildOutput(1, ramp(9), multiOutput)
        }
        assertEquals(8, error.maxLength)
    }

    @Test
    fun withoutReportIdsNoZeroIsPrefixed() {
        assertEquals(64, HidFraming.paddedLength(vendorRawHid))

        val data = ramp(10)
        val frame = HidFraming.buildOutput(0, data, vendorRawHid)

        assertEquals(64, frame.size)
        assertEquals(1.toByte(), frame[0])
        assertArrayEquals(data + ByteArray(54), frame)
        assertArrayEquals(ramp(64), HidFraming.buildOutput(0, ramp(64), vendorRawHid))
        assertThrows(HidFramingException.DataTooLong::class.java) {
            HidFraming.buildOutput(0, ramp(65), vendorRawHid)
        }
    }

    @Test
    fun bootKeyboardLedReportIsOneByte() {
        assertEquals(1, HidFraming.paddedLength(bootKeyboard))
        assertArrayEquals(byteArrayOf(0x02), HidFraming.buildOutput(0, byteArrayOf(0x02), bootKeyboard))
        assertArrayEquals(byteArrayOf(0x00), HidFraming.buildOutput(0, ByteArray(0), bootKeyboard))
    }

    @Test
    fun gamepadOutputReportCarriesItsId() {
        assertEquals(2, HidFraming.paddedLength(gamepad))
        assertArrayEquals(byteArrayOf(0x02, 0x0F), HidFraming.buildOutput(2, byteArrayOf(0x0F), gamepad))
    }

    @Test
    fun onlyDeclaredAndAddressableOutputReportsAreFramed() {
        notAnOutputReport(0x01, cb5100) // not declared at all
        notAnOutputReport(0x00, cb5100) // report 0 never goes on the wire with report IDs
        notAnOutputReport(0x04, multiOutput) // input only
        notAnOutputReport(0x01, gamepad) // input only
        notAnOutputReport(0x03, gamepad) // feature only
        notAnOutputReport(0xCB, vendorRawHid) // device without report IDs only has report 0
        notAnOutputReport(0x00, implicitReportZero) // declared before the first Report ID, not addressable
        notAnOutputReport(0x00, HidReportDescriptor.parse(HidDescriptorSamples.bytes("75 08 95 01 81 02")))

        assertArrayEquals(byteArrayOf(1) + ramp(4), HidFraming.buildOutput(1, ramp(4), implicitReportZero))
    }

    @Test
    fun reportIdMustBeAByte() {
        outOfRange("reportId", -1, 0, 255) { HidFraming.buildOutput(-1, ByteArray(0), cb5100) }
        outOfRange("reportId", 256, 0, 255) { HidFraming.buildOutput(256, ByteArray(0), cb5100) }
    }

    @Test
    fun buildOutputReturnsAFreshBufferAndLeavesDataUntouched() {
        val data = ramp(31)
        val before = data.copyOf()

        val first = HidFraming.buildOutput(0xCB, data, cb5100)
        val second = HidFraming.buildOutput(0xCB, data, cb5100)

        assertArrayEquals(before, data)
        assertNotSame(first, second)
        first[1] = 0
        assertEquals(1.toByte(), second[1])
    }

    @Test
    fun descriptorWithoutOutputReportsHasNoPayloadRoom() {
        assertEquals(0, HidFraming.paddedLength(HidReportDescriptor.parse(ByteArray(0))))
        val inputOnlyWithIds = HidReportDescriptor.parse(HidDescriptorSamples.bytes("85 01 75 08 95 04 81 02"))
        assertEquals(1, HidFraming.paddedLength(inputOnlyWithIds))
    }

    @Test
    fun setReportSetupForCb5100() {
        val setup = HidFraming.setReportSetup(0xCB, 3, HidFraming.paddedLength(cb5100))

        assertEquals(SetReportSetup(requestType = 0x21, request = 0x09, value = 0x02CB, index = 3, length = 32), setup)
        assertEquals(HidFraming.SET_REPORT_REQUEST_TYPE, setup.requestType)
        assertEquals(HidFraming.SET_REPORT_REQUEST, setup.request)
        assertEquals(HidFraming.REPORT_TYPE_OUTPUT, setup.value shr 8)
    }

    @Test
    fun setReportSetupAcceptsTheRangeBounds() {
        assertEquals(SetReportSetup(0x21, 0x09, 0x0200, 0, 1), HidFraming.setReportSetup(0, 0, 1))
        assertEquals(SetReportSetup(0x21, 0x09, 0x02FF, 255, 65_535), HidFraming.setReportSetup(255, 255, 65_535))
    }

    @Test
    fun setReportSetupRejectsOutOfRangeArguments() {
        outOfRange("reportId", -1, 0, 255) { HidFraming.setReportSetup(-1, 0, 32) }
        outOfRange("reportId", 256, 0, 255) { HidFraming.setReportSetup(256, 0, 32) }
        outOfRange("interfaceId", -1, 0, 255) { HidFraming.setReportSetup(0xCB, -1, 32) }
        outOfRange("interfaceId", 256, 0, 255) { HidFraming.setReportSetup(0xCB, 256, 32) }
        outOfRange("length", 0, 1, 65_535) { HidFraming.setReportSetup(0xCB, 0, 0) }
        outOfRange("length", 65_536, 1, 65_535) { HidFraming.setReportSetup(0xCB, 0, 65_536) }
    }

    @Test
    fun paddingPolicyIsWindowsMaxOutput() {
        assertEquals(HidPaddingPolicy.WINDOWS_MAX_OUTPUT, HidFraming.PADDING_POLICY)
        assertEquals(listOf(HidPaddingPolicy.WINDOWS_MAX_OUTPUT), HidPaddingPolicy.entries)
        assertEquals(HidPaddingPolicy.WINDOWS_MAX_OUTPUT, HidPaddingPolicy.valueOf("WINDOWS_MAX_OUTPUT"))
    }

    @Test
    fun framingErrorsHaveReadableMessages() {
        val errors: List<HidFramingException> = listOf(
            HidFramingException.NotAnOutputReport(1),
            HidFramingException.DataTooLong(1, 32, 31),
            HidFramingException.ArgumentOutOfRange("length", 0, 1, 65_535),
        )
        for (error in errors) {
            assertTrue(error.message.orEmpty().isNotBlank())
        }
    }
}
