package com.openauri.usb

import com.openauri.usb.ProtocolConstants.CRC_OFFSET
import com.openauri.usb.ProtocolConstants.PAYLOAD_SIZE
import com.openauri.usb.ProtocolConstants.REPORT_COUNT
import com.openauri.usb.ProtocolConstants.REPORT_DATA_OFFSET
import com.openauri.usb.ProtocolConstants.REPORT_DATA_SIZE
import com.openauri.usb.ProtocolConstants.REPORT_INDEX_OFFSET
import com.openauri.usb.ProtocolConstants.REPORT_SIZE
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Drift test between [ProtocolConstants] and the JavaScript core.
 *
 * `src/dsp/eq0xcb.mjs`, `src/transport/webhid.mjs` and `docs/protocol-0xcb.md` are read as text
 * from the repository on every run (nothing is copied), the values are extracted with regular
 * expressions and compared with the Kotlin constants: if the JavaScript changes, this test fails.
 * The reference fixture `test/fixtures/eq0xcb.reference.json` is checked against both.
 *
 * The companion holds the repository and fixture helpers that the other tests of this package
 * share.
 */
class ProtocolFixtureTest {

    @Test
    fun scalarConstantsMatchTheCodec() {
        assertEquals(ProtocolConstants.HID_REPORT_ID, jsConstant(codecSource, "HID_REPORT_ID"))
        assertEquals(ProtocolConstants.REPORT_SIZE, jsConstant(codecSource, "REPORT_SIZE"))
        assertEquals(ProtocolConstants.REPORT_COUNT, jsConstant(codecSource, "REPORT_COUNT"))
        assertEquals(ProtocolConstants.PAYLOAD_SIZE, jsConstant(codecSource, "PAYLOAD_SIZE"))
    }

    @Test
    fun writeSpacingMatchesTheTransport() {
        val spacing = jsConstant(transportSource, "WRITE_SPACING_MS").toLong()
        assertEquals(ProtocolConstants.WRITE_SPACING_MS, spacing)
    }

    @Test
    fun preambleAndCommitCommandMatchTheCodec() {
        assertArrayEquals(jsFrozenBytes(codecSource, "PREAMBLE"), ProtocolConstants.preamble())
        assertArrayEquals(jsFrozenBytes(codecSource, "COMMIT_COMMAND"), ProtocolConstants.commitCommand())
    }

    @Test
    fun commitReportIsTheCommandZeroPaddedToTheReportSize() {
        val body = requireMatch(codecSource, """export function commitReport\(\) \{\n(.*?)\n}""").groupValues[1]
        requireMatch(body, """const report = new Uint8Array\(REPORT_SIZE\);\s+report\.set\(COMMIT_COMMAND\);\s+return report;""")

        val command = ProtocolConstants.commitCommand()
        val report = ProtocolConstants.commitReport()
        assertEquals(REPORT_SIZE, report.size)
        assertArrayEquals(command, report.copyOf(command.size))
        assertTrue(report.drop(command.size).all { it == 0.toByte() })
    }

    @Test
    fun byteSequencesAreFreshCopies() {
        val preamble = ProtocolConstants.preamble()
        val commit = ProtocolConstants.commitReport()
        assertNotSame(preamble, ProtocolConstants.preamble())
        assertNotSame(commit, ProtocolConstants.commitReport())
        assertNotSame(ProtocolConstants.commitCommand(), ProtocolConstants.commitCommand())
        preamble.fill(0)
        commit.fill(0)
        ProtocolConstants.commitCommand().fill(0)
        assertArrayEquals(jsFrozenBytes(codecSource, "PREAMBLE"), ProtocolConstants.preamble())
        assertArrayEquals(jsFrozenBytes(codecSource, "COMMIT_COMMAND"), ProtocolConstants.commitCommand())
        assertEquals(0x01, ProtocolConstants.commitReport()[0].toInt())
    }

    @Test
    fun reportLayoutMatchesTheCodec() {
        val dataSize = requireMatch(codecSource, """const REPORT_DATA_SIZE = REPORT_SIZE - (\d+);""")
        assertEquals(REPORT_SIZE - dataSize.groupValues[1].toInt(), REPORT_DATA_SIZE)
        val split = requireMatch(
            codecSource,
            """return Array\.from\(\{ length: REPORT_COUNT \}, \(_, index\) => \{\s+""" +
                """const report = new Uint8Array\(REPORT_SIZE\);\s+""" +
                """report\[(\d+)\] = index;\s+""" +
                """report\.set\(bytes\.subarray\(index \* REPORT_DATA_SIZE, \(index \+ 1\) \* REPORT_DATA_SIZE\), (\d+)\);""",
        )
        assertEquals(REPORT_INDEX_OFFSET, split.groupValues[1].toInt())
        assertEquals(REPORT_DATA_OFFSET, split.groupValues[2].toInt())
    }

    @Test
    fun reportLayoutMatchesTheSpec() {
        val sizes = requireMatch(specSource, """O blob de (\d+) bytes é dividido em \*\*(\d+) relatórios de (\d+) bytes\*\*""")
        assertEquals(PAYLOAD_SIZE, sizes.groupValues[1].toInt())
        assertEquals(REPORT_COUNT, sizes.groupValues[2].toInt())
        assertEquals(REPORT_SIZE, sizes.groupValues[3].toInt())

        val layout = requireMatch(
            specSource,
            """pacote\[i] = \[ i, blob\[(\d+)\*i \.\. (\d+)\*i\+(\d+)] ]\s+// i = (\d+)\.\.(\d+)""",
        )
        val (from, to, last, firstIndex, lastIndex) = layout.destructured
        assertEquals(REPORT_DATA_SIZE, from.toInt())
        assertEquals(REPORT_DATA_SIZE, to.toInt())
        assertEquals(REPORT_DATA_SIZE - 1, last.toInt())
        assertEquals(0, firstIndex.toInt())
        assertEquals(REPORT_COUNT - 1, lastIndex.toInt())
    }

    @Test
    fun crcParametersAndPlacementMatchTheCodec() {
        val crcBody = requireMatch(codecSource, """export function crc16Ccitt\(data\) \{\n(.*?)\n}""").groupValues[1]
        val initial = requireMatch(crcBody, """let register = (0x[0-9a-fA-F]+);""").groupValues[1]
        val polynomial = requireMatch(crcBody, """\(\(register << 1\) \^ (0x[0-9a-fA-F]+)\)""").groupValues[1]
        assertEquals(Crc16Ccitt.INITIAL, parseJsInteger(initial))
        assertEquals(Crc16Ccitt.POLYNOMIAL, parseJsInteger(polynomial))
        // No final XOR and no reflection: the register is returned as is.
        requireMatch(crcBody, """\n\s+return register;$""")

        // Computed over everything before it, then appended low byte first.
        requireMatch(codecSource, """const checksum = crc16Ccitt\(payload\);\s+payload\.push\(checksum & 0xff, checksum >>> 8\);""")
        requireMatch(codecSource, """const crc = bytes\[PAYLOAD_SIZE - 2] \| \(bytes\[PAYLOAD_SIZE - 1] << 8\);""")
        requireMatch(codecSource, """crc16Ccitt\(bytes\.subarray\(0, PAYLOAD_SIZE - 2\)\)""")
        assertEquals(PAYLOAD_SIZE - 2, CRC_OFFSET)
    }

    @Test
    fun transportSendsTheReportIdApartAndFitsTheGuardTimeout() {
        requireMatch(transportSource, """device\.sendReport\(HID_REPORT_ID, report\)""")
        requireMatch(transportSource, """device\.sendReport\(HID_REPORT_ID, commitReport\(\)\)""")
        // The longest gap of a real write (last data report to commit) must fit the guard's timeout.
        assertTrue(reportGapMs < FrameGuard.SEQUENCE_TIMEOUT_MS)
        assertTrue(reportGapMs + settleMs < FrameGuard.SEQUENCE_TIMEOUT_MS)
    }

    @Test
    fun fixtureConstantsMatchTheKotlinConstants() {
        val constants = fixture.getJSONObject("constants")
        assertEquals(ProtocolConstants.HID_REPORT_ID, constants.getInt("hidReportId"))
        assertArrayEquals(ProtocolConstants.preamble(), bytesOf(constants.getJSONArray("preamble")))
        assertArrayEquals(ProtocolConstants.commitCommand(), bytesOf(constants.getJSONArray("commitCommand")))
    }

    @Test
    fun fixtureReportsAreTheirPayloadSplitByTheLayout() {
        assertEquals(REFERENCE_PRESET_COUNT, presets.size)
        for (preset in presets) {
            assertEquals(preset.name, PAYLOAD_SIZE, preset.payload.size)
            assertEquals(preset.name, REPORT_COUNT, preset.reports.size)
            val split = reportsFromPayload(preset.payload)
            preset.reports.forEachIndexed { index, report ->
                assertEquals(REPORT_SIZE, report.size)
                assertEquals(index, report[REPORT_INDEX_OFFSET].toInt())
                assertArrayEquals("${preset.name} report $index", report, split[index])
            }
        }
    }

    @Test
    fun neutralIsTenIdentitySectionsAtUnityPreamp() {
        val payload = neutral.payload
        assertArrayEquals(ProtocolConstants.preamble(), payload.copyOf(ProtocolConstants.preamble().size))
        // Q23 unity gain, little-endian (src/dsp/eq0xcb.mjs:455).
        assertArrayEquals(bytesOf(0x00, 0x00, 0x80, 0x00), payload.copyOfRange(14, 18))
        // Each OFF section is [2^27, 0, 0, 0, 0] (test/dsp/eq0xcb.test.mjs:145-150).
        val identity = bytesOf(0x00, 0x00, 0x00, 0x08) + ByteArray(16)
        for (section in 0 until jsConstant(codecSource, "BAND_COUNT")) {
            assertArrayEquals(identity, payload.copyOfRange(18 + section * 20, 38 + section * 20))
        }
        val stored = (payload[CRC_OFFSET].toInt() and 0xFF) or ((payload[CRC_OFFSET + 1].toInt() and 0xFF) shl 8)
        assertEquals(Crc16Ccitt.compute(payload, 0, CRC_OFFSET), stored)
        assertEquals(REPORT_COUNT, neutral.reports.size)
    }

    /** One curve: its 220-byte payload and the 9 data reports that carry it. */
    class Curve(val name: String, val payload: ByteArray, val reports: List<ByteArray>)

    companion object {
        private const val CODEC_PATH = "src/dsp/eq0xcb.mjs"
        private const val TRANSPORT_PATH = "src/transport/webhid.mjs"
        private const val SPEC_PATH = "docs/protocol-0xcb.md"
        private const val FIXTURE_PATH = "test/fixtures/eq0xcb.reference.json"
        private const val REFERENCE_PRESET_COUNT = 11

        /**
         * The repository root: the first ancestor of the working directory (the app module under
         * Gradle) that holds the JavaScript codec.
         */
        val repoRoot: File by lazy {
            val start = File(checkNotNull(System.getProperty("user.dir")) { "user.dir is not set" }).absoluteFile
            generateSequence(start) { it.parentFile }.firstOrNull { File(it, CODEC_PATH).isFile }
                ?: throw IllegalStateException("no ancestor of $start contains $CODEC_PATH")
        }

        val codecSource: String by lazy { repoText(CODEC_PATH) }
        val transportSource: String by lazy { repoText(TRANSPORT_PATH) }
        private val specSource: String by lazy { repoText(SPEC_PATH) }
        private val fixture: JSONObject by lazy { JSONObject(repoText(FIXTURE_PATH)) }

        /** Pause after each data report in `writeCurve` (`src/transport/webhid.mjs:110`). */
        val reportGapMs: Long by lazy { jsConstant(transportSource, "REPORT_GAP_MS").toLong() }

        /** Pause between the last data report's gap and the commit (`src/transport/webhid.mjs:113`). */
        val settleMs: Long by lazy { jsConstant(transportSource, "SETTLE_MS").toLong() }

        /** The 11 reference presets of the fixture, sorted by name. */
        val presets: List<Curve> by lazy {
            val all = fixture.getJSONObject("presets")
            // keys(), not keySet(): Android's org.json API, the one on the compile classpath, has only keys().
            all.keys().asSequence().toList().sorted().map { name ->
                val preset = all.getJSONObject(name)
                val reports = preset.getJSONArray("reports")
                Curve(
                    name = name,
                    payload = bytesOf(preset.getJSONArray("payload")),
                    reports = List(reports.length()) { bytesOf(reports.getJSONArray(it)) },
                )
            }
        }

        /**
         * The Neutral preset (`NEUTRAL_BANDS` at 0 dB, `src/dsp/eq0xcb.mjs:80`), which the fixture
         * does not hold: built the way `encodePayload` builds it, with the CRC this suite checks
         * against every reference payload.
         */
        val neutral: Curve by lazy {
            val payload = ByteArray(PAYLOAD_SIZE)
            val preamble = ProtocolConstants.preamble()
            preamble.copyInto(payload)
            var offset = preamble.size
            fun appendInt32(value: Int) {
                for (shift in 0 until Int.SIZE_BITS step Byte.SIZE_BITS) payload[offset++] = (value ushr shift).toByte()
            }
            appendInt32(1 shl 23) // preampWord(0): Q23 unity (src/dsp/eq0xcb.mjs:86, :455)
            repeat(jsConstant(codecSource, "BAND_COUNT")) {
                appendInt32(1 shl 27) // OFF: b0 = 1 in Q27 (src/dsp/eq0xcb.mjs:87, :282)
                repeat(4) { appendInt32(0) }
            }
            check(offset == CRC_OFFSET) { "neutral payload is $offset bytes before the CRC" }
            sealCrc(payload)
            Curve("neutral", payload, reportsFromPayload(payload))
        }

        /** Every curve that must pass end to end: the 11 reference presets and Neutral. */
        val allCurves: List<Curve> by lazy { presets + neutral }

        /** Writes the CRC of payload bytes `0 until CRC_OFFSET` into its last two bytes, little-endian. */
        fun sealCrc(payload: ByteArray) {
            val crc = Crc16Ccitt.compute(payload, 0, CRC_OFFSET)
            payload[CRC_OFFSET] = crc.toByte()
            payload[CRC_OFFSET + 1] = (crc ushr 8).toByte()
        }

        /** The 9 data reports of [payload], as `reportsFromPayload` builds them (`src/dsp/eq0xcb.mjs:539-544`). */
        fun reportsFromPayload(payload: ByteArray): List<ByteArray> = List(REPORT_COUNT) { index ->
            val start = minOf(index * REPORT_DATA_SIZE, PAYLOAD_SIZE)
            val end = minOf(start + REPORT_DATA_SIZE, PAYLOAD_SIZE)
            ByteArray(REPORT_SIZE).also { report ->
                report[REPORT_INDEX_OFFSET] = index.toByte()
                payload.copyInto(report, REPORT_DATA_OFFSET, start, end)
            }
        }

        /** Text of a repository file, with line endings normalized to `\n`. */
        fun repoText(relativePath: String): String =
            File(repoRoot, relativePath).readText(Charsets.UTF_8).replace("\r\n", "\n")

        /** The integer `export const <name> = <literal>;` in [source]. */
        fun jsConstant(source: String, name: String): Int {
            val match = requireMatch(source, """export const ${Regex.escape(name)} = (0[xX][0-9a-fA-F]+|\d+);""")
            return parseJsInteger(match.groupValues[1])
        }

        fun bytesOf(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }

        /** The bytes of `export const <name> = Object.freeze([...]);` in [source]. */
        private fun jsFrozenBytes(source: String, name: String): ByteArray {
            val match = requireMatch(source, """export const ${Regex.escape(name)} = Object\.freeze\(\[([^\]]*)]\);""")
            val values = match.groupValues[1].split(',').map { it.trim() }.filter { it.isNotEmpty() }.map(::parseJsInteger)
            assertTrue("$name holds a non-byte value", values.all { it in 0..0xFF })
            return bytesOf(*values.toIntArray())
        }

        private fun bytesOf(array: JSONArray): ByteArray = ByteArray(array.length()) { index ->
            val value = array.getInt(index)
            check(value in 0..0xFF) { "fixture value $value is not a byte" }
            value.toByte()
        }

        private fun parseJsInteger(literal: String): Int =
            if (literal.startsWith("0x", ignoreCase = true)) literal.substring(2).toInt(16) else literal.toInt()

        private fun requireMatch(source: String, pattern: String): MatchResult =
            Regex(pattern, RegexOption.DOT_MATCHES_ALL).find(source)
                ?: throw AssertionError("the JavaScript no longer matches /$pattern/")
    }
}
