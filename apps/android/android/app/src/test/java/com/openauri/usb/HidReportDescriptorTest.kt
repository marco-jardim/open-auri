package com.openauri.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import kotlin.random.Random

/** Report descriptors shared by the HID parser and framing tests. Each getter returns a fresh array. */
internal object HidDescriptorSamples {

    /** Hex bytes separated by spaces, one item per argument. */
    fun bytes(vararg items: String): ByteArray =
        items.joinToString(" ")
            .split(' ')
            .filter { it.isNotEmpty() }
            .map { it.toInt(16).toByte() }
            .toByteArray()

    /** Boot protocol keyboard, HID 1.11 Appendix B.1: 8-byte input, 1-byte LED output, no report IDs. */
    val bootKeyboard: ByteArray
        get() = bytes(
            "05 01", // Usage Page (Generic Desktop)
            "09 06", // Usage (Keyboard)
            "A1 01", // Collection (Application)
            "05 07", //   Usage Page (Key Codes)
            "19 E0", //   Usage Minimum (224)
            "29 E7", //   Usage Maximum (231)
            "15 00", //   Logical Minimum (0)
            "25 01", //   Logical Maximum (1)
            "75 01", //   Report Size (1)
            "95 08", //   Report Count (8)
            "81 02", //   Input (Data, Var, Abs): modifiers, 8 bits
            "95 01", //   Report Count (1)
            "75 08", //   Report Size (8)
            "81 01", //   Input (Const): reserved byte, 8 bits
            "95 05", //   Report Count (5)
            "75 01", //   Report Size (1)
            "05 08", //   Usage Page (LEDs)
            "19 01", //   Usage Minimum (1)
            "29 05", //   Usage Maximum (5)
            "91 02", //   Output (Data, Var, Abs): LEDs, 5 bits
            "95 01", //   Report Count (1)
            "75 03", //   Report Size (3)
            "91 01", //   Output (Const): LED padding, 3 bits
            "95 06", //   Report Count (6)
            "75 08", //   Report Size (8)
            "15 00", //   Logical Minimum (0)
            "25 65", //   Logical Maximum (101)
            "05 07", //   Usage Page (Key Codes)
            "19 00", //   Usage Minimum (0)
            "29 65", //   Usage Maximum (101)
            "81 00", //   Input (Data, Array): key codes, 48 bits
            "C0", //    End Collection
        )

    /** Gamepad with report IDs: input 1 (7 bytes), LED output 2 (1 byte), vendor feature 3 (2 bytes). */
    val gamepad: ByteArray
        get() = bytes(
            "05 01", // Usage Page (Generic Desktop)
            "09 05", // Usage (Game Pad)
            "A1 01", // Collection (Application)
            "85 01", //   Report ID (1)
            "A1 00", //   Collection (Physical)
            "05 09", //     Usage Page (Button)
            "19 01", //     Usage Minimum (1)
            "29 10", //     Usage Maximum (16)
            "15 00", //     Logical Minimum (0)
            "25 01", //     Logical Maximum (1)
            "95 10", //     Report Count (16)
            "75 01", //     Report Size (1)
            "81 02", //     Input (Data, Var, Abs): 16 bits
            "05 01", //     Usage Page (Generic Desktop)
            "09 30", //     Usage (X)
            "09 31", //     Usage (Y)
            "09 32", //     Usage (Z)
            "09 35", //     Usage (Rz)
            "15 81", //     Logical Minimum (-127)
            "25 7F", //     Logical Maximum (127)
            "75 08", //     Report Size (8)
            "95 04", //     Report Count (4)
            "81 02", //     Input (Data, Var, Abs): 32 bits
            "09 39", //     Usage (Hat Switch)
            "15 00", //     Logical Minimum (0)
            "25 07", //     Logical Maximum (7)
            "35 00", //     Physical Minimum (0)
            "46 3B 01", //  Physical Maximum (315)
            "65 14", //     Unit (Degrees)
            "75 04", //     Report Size (4)
            "95 01", //     Report Count (1)
            "81 42", //     Input (Data, Var, Abs, Null): 4 bits
            "65 00", //     Unit (None)
            "75 04", //     Report Size (4)
            "95 01", //     Report Count (1)
            "81 03", //     Input (Const): 4 bits
            "C0", //      End Collection
            "85 02", //   Report ID (2)
            "05 08", //   Usage Page (LEDs)
            "19 01", //   Usage Minimum (1)
            "29 04", //   Usage Maximum (4)
            "15 00", //   Logical Minimum (0)
            "25 01", //   Logical Maximum (1)
            "75 01", //   Report Size (1)
            "95 04", //   Report Count (4)
            "91 02", //   Output (Data, Var, Abs): 4 bits
            "95 04", //   Report Count (4)
            "91 01", //   Output (Const): 4 bits
            "85 03", //   Report ID (3)
            "06 00 FF", // Usage Page (Vendor 0xFF00)
            "09 01", //   Usage (1)
            "75 08", //   Report Size (8)
            "95 02", //   Report Count (2)
            "B1 02", //   Feature (Data, Var, Abs): 16 bits
            "C0", //    End Collection
        )

    /** Vendor page 0xFF00 raw HID device without report IDs: 64-byte input and 64-byte output. */
    val vendorRawHid: ByteArray
        get() = bytes(
            "06 00 FF", // Usage Page (Vendor 0xFF00)
            "09 01", //   Usage (1)
            "A1 01", //   Collection (Application)
            "15 00", //     Logical Minimum (0)
            "26 FF 00", //  Logical Maximum (255)
            "75 08", //     Report Size (8)
            "95 40", //     Report Count (64)
            "09 01", //     Usage (1)
            "81 02", //     Input (Data, Var, Abs): 64 bytes
            "95 40", //     Report Count (64)
            "09 01", //     Usage (1)
            "91 02", //     Output (Data, Var, Abs): 64 bytes
            "C0", //      End Collection
        )

    /**
     * Synthetic CB5100 descriptor following the hypothesis of src/transport/fake-device.mjs:172-185:
     * one collection with usage page 0 and usage 0, one Output report 0xCB of 8 x 31 bits.
     */
    val cb5100: ByteArray
        get() = bytes(
            "A1 01", // Collection (Application)
            "85 CB", //   Report ID (0xCB)
            "75 08", //   Report Size (8)
            "95 1F", //   Report Count (31)
            "91 02", //   Output (Data, Var, Abs): 31 bytes
            "C0", //    End Collection
        )

    /** Output reports of 8, 31 and 63 bytes, plus a 100-byte input-only report that must not count. */
    val multiOutput: ByteArray
        get() = bytes(
            "06 00 FF", // Usage Page (Vendor 0xFF00)
            "09 01", //   Usage (1)
            "A1 01", //   Collection (Application)
            "75 08", //     Report Size (8)
            "85 01", //     Report ID (1)
            "95 08", //     Report Count (8)
            "91 02", //     Output: 8 bytes
            "85 CB", //     Report ID (0xCB)
            "95 1F", //     Report Count (31)
            "91 02", //     Output: 31 bytes
            "85 03", //     Report ID (3)
            "95 3F", //     Report Count (63)
            "91 02", //     Output: 63 bytes
            "85 04", //     Report ID (4)
            "95 64", //     Report Count (100)
            "81 02", //     Input: 100 bytes
            "C0", //      End Collection
        )

    /** Output items before the first Report ID land on implicit report 0 (2 bytes), then report 1 (4 bytes). */
    val implicitReportZero: ByteArray
        get() = bytes(
            "75 08", // Report Size (8)
            "95 02", // Report Count (2)
            "91 02", // Output: 2 bytes on report 0
            "85 01", // Report ID (1)
            "95 04", // Report Count (4)
            "91 02", // Output: 4 bytes on report 1
        )

    /** Every sample above, by name. */
    val all: Map<String, ByteArray>
        get() = mapOf(
            "bootKeyboard" to bootKeyboard,
            "gamepad" to gamepad,
            "vendorRawHid" to vendorRawHid,
            "cb5100" to cb5100,
            "multiOutput" to multiOutput,
        )
}

class HidReportDescriptorTest {

    private fun parse(vararg items: String): ParsedDescriptor =
        HidReportDescriptor.parse(HidDescriptorSamples.bytes(*items))

    private inline fun <reified T : Throwable> expectThrows(vararg items: String): T =
        assertThrows(T::class.java) { HidReportDescriptor.parse(HidDescriptorSamples.bytes(*items)) }

    @Test
    fun bootKeyboardHasEightByteInputAndOneByteOutputWithoutReportIds() {
        val parsed = HidReportDescriptor.parse(HidDescriptorSamples.bootKeyboard)

        assertFalse(parsed.usesReportIds)
        val expected = HidReportInfo(
            reportId = 0,
            inputBits = 64,
            outputBits = 8,
            featureBits = 0,
            declaresInput = true,
            declaresOutput = true,
            declaresFeature = false,
        )
        assertEquals(mapOf(0 to expected), parsed.reports)
        val report = parsed.reports.getValue(0)
        assertEquals(8, report.inputBytes)
        assertEquals(1, report.outputBytes)
        assertEquals(0, report.featureBytes)
        assertEquals(listOf(HidCollection(type = 1, usagePage = 0x01, usage = 0x06)), parsed.collections)
        assertEquals(1, parsed.maxOutputReportBytes)
        assertEquals(listOf(0), parsed.outputReportIds)
    }

    @Test
    fun gamepadSplitsInputOutputAndFeatureByReportId() {
        val parsed = HidReportDescriptor.parse(HidDescriptorSamples.gamepad)

        assertTrue(parsed.usesReportIds)
        assertEquals(
            mapOf(
                1 to HidReportInfo(1, 56, 0, 0, declaresInput = true, declaresOutput = false, declaresFeature = false),
                2 to HidReportInfo(2, 0, 8, 0, declaresInput = false, declaresOutput = true, declaresFeature = false),
                3 to HidReportInfo(3, 0, 0, 16, declaresInput = false, declaresOutput = false, declaresFeature = true),
            ),
            parsed.reports,
        )
        assertEquals(7, parsed.reports.getValue(1).inputBytes)
        assertEquals(1, parsed.reports.getValue(2).outputBytes)
        assertEquals(2, parsed.reports.getValue(3).featureBytes)
        // The nested Physical collection is not a top-level collection.
        assertEquals(listOf(HidCollection(type = 1, usagePage = 0x01, usage = 0x05)), parsed.collections)
        assertEquals(1, parsed.maxOutputReportBytes)
        assertEquals(listOf(2), parsed.outputReportIds)
    }

    @Test
    fun vendorPageDeviceWithoutReportIds() {
        val parsed = HidReportDescriptor.parse(HidDescriptorSamples.vendorRawHid)

        assertFalse(parsed.usesReportIds)
        val report = parsed.reports.getValue(0)
        assertEquals(512, report.inputBits)
        assertEquals(512, report.outputBits)
        assertEquals(64, report.outputBytes)
        assertEquals(listOf(HidCollection(type = 1, usagePage = 0xFF00, usage = 0x01)), parsed.collections)
        assertEquals(64, parsed.maxOutputReportBytes)
    }

    @Test
    fun syntheticCb5100DeclaresOneOutputReportOf31Bytes() {
        val parsed = HidReportDescriptor.parse(HidDescriptorSamples.cb5100)

        assertTrue(parsed.usesReportIds)
        assertEquals(
            mapOf(0xCB to HidReportInfo(0xCB, 0, 248, 0, false, true, false)),
            parsed.reports,
        )
        assertEquals(31, parsed.reports.getValue(0xCB).outputBytes)
        assertEquals(31, parsed.maxOutputReportBytes)
        assertEquals(listOf(0xCB), parsed.outputReportIds)
        // Mirrors the fake device: usagePage 0, usage 0.
        assertEquals(listOf(HidCollection(type = 1, usagePage = 0, usage = 0)), parsed.collections)
    }

    @Test
    fun largestOutputReportIgnoresInputOnlyReports() {
        val parsed = HidReportDescriptor.parse(HidDescriptorSamples.multiOutput)

        assertEquals(63, parsed.maxOutputReportBytes)
        assertEquals(listOf(1, 3, 0xCB), parsed.outputReportIds)
        assertEquals(8, parsed.reports.getValue(1).outputBytes)
        assertEquals(31, parsed.reports.getValue(0xCB).outputBytes)
        val inputOnly = parsed.reports.getValue(4)
        assertEquals(100, inputOnly.inputBytes)
        assertFalse(inputOnly.declaresOutput)
    }

    @Test
    fun emptyDescriptorParsesToNothing() {
        val parsed = HidReportDescriptor.parse(ByteArray(0))

        assertEquals(ParsedDescriptor(usesReportIds = false, reports = emptyMap(), collections = emptyList()), parsed)
        assertEquals(0, parsed.maxOutputReportBytes)
        assertEquals(emptyList<Int>(), parsed.outputReportIds)
    }

    @Test
    fun bitsRoundUpToBytesAndZeroBitItemsStillDeclareTheReport() {
        val parsed = parse(
            "75 01", "95 09", "91 02", // Output: 9 bits
            "94", "81 02", //             Report Count (0, no data byte), Input: 0 bits
        )

        val report = parsed.reports.getValue(0)
        assertEquals(9, report.outputBits)
        assertEquals(2, report.outputBytes)
        assertTrue(report.declaresInput)
        assertEquals(0, report.inputBits)
        assertEquals(0, report.inputBytes)
    }

    @Test
    fun shortItemsCarryZeroOneTwoOrFourDataBytes() {
        val parsed = parse(
            "75 01", //             Report Size (1)
            "94", "81 02", //       Report Count, 0 data bytes: 0 bits
            "95 03", "81 02", //    Report Count, 1 data byte: 3 bits
            "96 04 00", "81 02", // Report Count, 2 data bytes: 4 bits
            "97 05 00 00 00", "81 02", // Report Count, bSize 3 = 4 data bytes: 5 bits
            "97 01 00 00 00", "B1 00", // Report Count (1) then Feature with 1 data byte: 1 bit
        )

        assertEquals(12, parsed.reports.getValue(0).inputBits)
        assertEquals(2, parsed.reports.getValue(0).inputBytes)
        assertEquals(1, parsed.reports.getValue(0).featureBits)
    }

    @Test
    fun fourByteDataIsReadUnsignedLittleEndian() {
        val withId = parse("87 CB 00 00 00", "75 08", "95 1F", "91 02")
        assertEquals(31, withId.reports.getValue(0xCB).outputBytes)

        val huge = expectThrows<HidDescriptorException.ItemTooLarge>(
            "77 FF FF FF FF", // Report Size (4294967295)
            "97 FF FF FF FF", // Report Count (4294967295)
            "91 02", //         Output
        )
        assertEquals(0xFFFF_FFFFL, huge.reportSize)
        assertEquals(0xFFFF_FFFFL, huge.reportCount)
        assertEquals(10, huge.offset)

        val bigId = expectThrows<HidDescriptorException.InvalidReportId>("87 00 00 00 01")
        assertEquals(0x0100_0000L, bigId.reportId)
    }

    @Test
    fun extendedUsageCarriesItsOwnUsagePage() {
        val parsed = parse(
            "05 01", //          Usage Page (Generic Desktop), overridden below
            "0B 01 00 0D 00", // Usage (4 bytes): page 0x000D, usage 0x0001
            "A1 01", "C0",
            "07 00 FF 01 00", // Usage Page with 4 data bytes: only the low 16 bits are a page
            "09 02", "A1 01", "C0",
        )

        assertEquals(
            listOf(
                HidCollection(type = 1, usagePage = 0x0D, usage = 0x01),
                HidCollection(type = 1, usagePage = 0xFF00, usage = 0x02),
            ),
            parsed.collections,
        )
    }

    @Test
    fun firstUsageWinsAndLocalsAreClearedAfterEveryMainItem() {
        val parsed = parse(
            "09 07", "09 08", "A1 01", "C0", // two usages: the first names the collection
            "09 05", "81 00", //                 usage consumed by the Input item
            "A1 02", "C0", //                    collection without its own usage
        )

        assertEquals(
            listOf(
                HidCollection(type = 1, usagePage = 0, usage = 0x07),
                HidCollection(type = 2, usagePage = 0, usage = 0),
            ),
            parsed.collections,
        )
    }

    @Test
    fun unknownButValidTagsAreSkipped() {
        val noise = arrayOf(
            "00", //    main tag 0x0 (reserved)
            "D0", //    main tag 0xD (reserved)
            "F1 00", // main tag 0xF (reserved) with data
            "C4", //    global tag 0xC (reserved)
            "F5 01", // global tag 0xF (reserved) with data
            "15 80", // Logical Minimum
            "39 01", // Designator Index (local)
            "A9 01", // Delimiter (local)
            "F8", //    local tag 0xF (reserved)
        )
        val parsed = HidReportDescriptor.parse(
            HidDescriptorSamples.bytes(*noise) + HidDescriptorSamples.cb5100,
        )

        assertEquals(HidReportDescriptor.parse(HidDescriptorSamples.cb5100), parsed)
    }

    @Test
    fun longItemsAreSkippedWhole() {
        val parsed = parse(
            "FE 00 10", //                 long item without data
            "A1 01",
            "FE 03 10 C0 C0 C0", //        data that looks like End Collection items is not parsed
            "85 CB", "75 08", "95 1F", "91 02",
            "FE FF 20 " + "B4 ".repeat(255), // 255 data bytes that look like Pop items
            "C0",
        )

        assertEquals(HidReportDescriptor.parse(HidDescriptorSamples.cb5100), parsed)
    }

    @Test
    fun truncatedLongItemsAreTyped() {
        val noSize = expectThrows<HidDescriptorException.Truncated>("FE")
        assertEquals(0, noSize.offset)
        assertEquals(3, noSize.needed)
        assertEquals(1, noSize.available)

        val noTag = expectThrows<HidDescriptorException.Truncated>("A1 01", "FE 02")
        assertEquals(2, noTag.offset)
        assertEquals(5, noTag.needed)
        assertEquals(2, noTag.available)

        val shortData = expectThrows<HidDescriptorException.Truncated>("FE 02 10 AA")
        assertEquals(5, shortData.needed)
        assertEquals(4, shortData.available)
    }

    @Test
    fun truncatedShortItemsAreTyped() {
        val oneByte = expectThrows<HidDescriptorException.Truncated>("95")
        assertEquals(0, oneByte.offset)
        assertEquals(2, oneByte.needed)
        assertEquals(1, oneByte.available)

        val twoBytes = expectThrows<HidDescriptorException.Truncated>("75 08", "96 01")
        assertEquals(2, twoBytes.offset)
        assertEquals(3, twoBytes.needed)
        assertEquals(2, twoBytes.available)

        val fourBytes = expectThrows<HidDescriptorException.Truncated>("77 01 02 03")
        assertEquals(5, fourBytes.needed)
        assertEquals(4, fourBytes.available)
    }

    @Test
    fun everyTruncationOfARealDescriptorIsTypedOrValid() {
        for ((name, descriptor) in HidDescriptorSamples.all) {
            var parsed = 0
            var truncated = 0
            var leftOpen = 0
            for (length in 0 until descriptor.size) {
                val error = runCatching { HidReportDescriptor.parse(descriptor.copyOf(length)) }.exceptionOrNull()
                assertTrue("$name cut to $length bytes threw untyped $error", error == null || error is HidDescriptorException)
                when (error) {
                    null -> parsed++
                    is HidDescriptorException.Truncated -> truncated++
                    is HidDescriptorException.UnbalancedCollection.LeftOpen -> leftOpen++
                    else -> fail("$name cut to $length bytes threw unexpected $error")
                }
            }
            assertTrue("$name: no prefix parsed", parsed > 0)
            assertTrue("$name: no prefix cut an item", truncated > 0)
            assertTrue("$name: no prefix left a collection open", leftOpen > 0)
            assertTrue(HidReportDescriptor.parse(descriptor).reports.isNotEmpty())
        }
    }

    @Test
    fun arbitraryBytesNeverThrowUntypedExceptions() {
        val random = Random(0x0CB5100)
        val inputs = buildList {
            for (prefix in 0..0xFF) {
                add(byteArrayOf(prefix.toByte()))
                add(byteArrayOf(prefix.toByte(), 0, 0, 0, 0))
                add(byteArrayOf(prefix.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte()))
            }
            repeat(3000) { add(random.nextBytes(random.nextInt(1, 64))) }
        }
        for (input in inputs) {
            val error = runCatching { HidReportDescriptor.parse(input) }.exceptionOrNull()
            assertTrue(
                "${input.joinToString(" ") { "%02X".format(it) }} threw untyped $error",
                error == null || error is HidDescriptorException,
            )
        }
    }

    @Test
    fun nestedPushAndPopRestoreGlobals() {
        val parsed = parse(
            "05 01", "75 08", "95 04", "85 01", // page 1, size 8, count 4, report 1
            "A4", //                               Push
            "06 00 FF", "75 10", "95 02", "85 02", // page 0xFF00, size 16, count 2, report 2
            "A4", //                               Push
            "75 01", "95 03", "85 03", //          size 1, count 3, report 3
            "91 02", //                            Output on report 3: 3 bits
            "B4", //                               Pop: back to size 16, count 2, report 2
            "91 02", //                            Output on report 2: 32 bits
            "09 01", "A1 01", "C0", //             collection sees page 0xFF00
            "B4", //                               Pop: back to size 8, count 4, report 1
            "91 02", //                            Output on report 1: 32 bits
            "09 02", "A1 01", "C0", //             collection sees page 1
        )

        assertEquals(3, parsed.reports.getValue(3).outputBits)
        assertEquals(1, parsed.reports.getValue(3).outputBytes)
        assertEquals(32, parsed.reports.getValue(2).outputBits)
        assertEquals(32, parsed.reports.getValue(1).outputBits)
        assertEquals(
            listOf(
                HidCollection(type = 1, usagePage = 0xFF00, usage = 1),
                HidCollection(type = 1, usagePage = 0x01, usage = 2),
            ),
            parsed.collections,
        )
    }

    @Test
    fun popWithoutPushIsTyped() {
        assertEquals(0, expectThrows<HidDescriptorException.PopWithoutPush>("B4").offset)
        assertEquals(2, expectThrows<HidDescriptorException.PopWithoutPush>("A4", "B4", "B4").offset)
        // Pop with a data byte is still a Pop.
        assertEquals(0, expectThrows<HidDescriptorException.PopWithoutPush>("B5 00").offset)
    }

    @Test
    fun unbalancedCollectionsAreTyped() {
        assertEquals(0, expectThrows<HidDescriptorException.UnbalancedCollection.EndWithoutCollection>("C0").offset)
        assertEquals(
            3,
            expectThrows<HidDescriptorException.UnbalancedCollection.EndWithoutCollection>("A1 01", "C0", "C0").offset,
        )

        val oneOpen = expectThrows<HidDescriptorException.UnbalancedCollection.LeftOpen>("A1 01", "A1 00", "C0")
        assertEquals(5, oneOpen.offset)
        assertEquals(1, oneOpen.openCollections)

        val twoOpen = expectThrows<HidDescriptorException.UnbalancedCollection>("A1 01", "A1 00")
        assertTrue(twoOpen is HidDescriptorException.UnbalancedCollection.LeftOpen)
        assertEquals(4, twoOpen.offset)
    }

    @Test
    fun itemOf65535BitsIsAcceptedAndOneMoreIsRejected() {
        val atLimit = parse("75 FF", "96 01 01", "91 02") // 255 x 257 = 65535 bits
        assertEquals(65_535, atLimit.reports.getValue(0).outputBits)
        assertEquals(8_192, atLimit.reports.getValue(0).outputBytes)

        val over = expectThrows<HidDescriptorException.ItemTooLarge>("75 FF", "96 02 01", "91 02") // 255 x 258
        assertEquals(5, over.offset)
        assertEquals(255L, over.reportSize)
        assertEquals(258L, over.reportCount)

        val inputOver = expectThrows<HidDescriptorException.ItemTooLarge>("75 01", "97 00 00 01 00", "81 02")
        assertEquals(65_536L, inputOver.reportCount)
        val featureOver = expectThrows<HidDescriptorException.ItemTooLarge>("77 00 00 01 00", "95 01", "B1 02")
        assertEquals(65_536L, featureOver.reportSize)

        val zeroCount = parse("77 FF FF FF FF", "94", "91 02")
        assertTrue(zeroCount.reports.getValue(0).declaresOutput)
        assertEquals(0, zeroCount.reports.getValue(0).outputBits)
    }

    @Test
    fun reportAboveMaxReportBytesIsRejected() {
        val item = "91 02" // Output of 8 x 8191 = 65528 bits
        val eight = Array(8) { item }
        val atEight = parse("75 08", "96 FF 1F", *eight, "81 02", "B1 02")
        assertEquals(8 * 65_528, atEight.reports.getValue(0).outputBits)
        assertEquals(65_528, atEight.reports.getValue(0).inputBits)

        val over = expectThrows<HidDescriptorException.ReportTooLarge>("75 08", "96 FF 1F", *eight, item)
        assertEquals(21, over.offset)
        assertEquals(0, over.reportId)
        assertEquals(9 * 65_528, over.bits)
        assertTrue(over.bits > HidReportDescriptor.MAX_REPORT_BYTES * 8)
    }

    @Test
    fun reservedShortItemsAreTyped() {
        // bType 3 with every bSize, including tag 0xF prefixes next to the long item prefix 0xFE.
        for (prefix in listOf(0x0C, 0x0D, 0x3F, 0x8E, 0xFC, 0xFD, 0xFF)) {
            val error = assertThrows(HidDescriptorException.ReservedItem::class.java) {
                HidReportDescriptor.parse(byteArrayOf(0x05, 0x01, prefix.toByte(), 0, 0, 0, 0))
            }
            assertEquals(2, error.offset)
            assertEquals(prefix, error.prefix)
            assertTrue(error.message.orEmpty().contains("0x%02X".format(prefix)))
        }
    }

    @Test
    fun reportIdZeroAndAbove255AreRejected() {
        val zero = expectThrows<HidDescriptorException.InvalidReportId>("A1 01", "85 00")
        assertEquals(2, zero.offset)
        assertEquals(0L, zero.reportId)

        assertEquals(0L, expectThrows<HidDescriptorException.InvalidReportId>("84").reportId)
        assertEquals(256L, expectThrows<HidDescriptorException.InvalidReportId>("86 00 01").reportId)

        val maxId = parse("85 FF", "75 08", "95 01", "91 02")
        assertEquals(listOf(0xFF), maxId.outputReportIds)
    }

    @Test
    fun mainItemsBeforeTheFirstReportIdLandOnReportZero() {
        val parsed = HidReportDescriptor.parse(HidDescriptorSamples.implicitReportZero)

        assertTrue(parsed.usesReportIds)
        assertEquals(listOf(0, 1), parsed.outputReportIds)
        assertEquals(2, parsed.reports.getValue(0).outputBytes)
        assertEquals(4, parsed.reports.getValue(1).outputBytes)
        assertEquals(4, parsed.maxOutputReportBytes)
    }

    @Test
    fun errorsAreOneSealedHierarchyWithReadableMessages() {
        val errors: List<HidDescriptorException> = listOf(
            HidDescriptorException.Truncated(1, 2, 1),
            HidDescriptorException.PopWithoutPush(1),
            HidDescriptorException.UnbalancedCollection.EndWithoutCollection(1),
            HidDescriptorException.UnbalancedCollection.LeftOpen(1, 1),
            HidDescriptorException.ItemTooLarge(1, 1, 65_536),
            HidDescriptorException.ReportTooLarge(1, 1, 600_000),
            HidDescriptorException.ReservedItem(1, 0x0C),
            HidDescriptorException.InvalidReportId(1, 0),
        )
        for (error in errors) {
            assertEquals(1, error.offset)
            assertTrue(error.message.orEmpty().isNotBlank())
        }
    }

    @Test
    fun samplesAreFreshCopies() {
        val first = HidDescriptorSamples.cb5100
        first[0] = 0
        assertArrayEquals(HidDescriptorSamples.bytes("A1 01 85 CB 75 08 95 1F 91 02 C0"), HidDescriptorSamples.cb5100)
    }
}
