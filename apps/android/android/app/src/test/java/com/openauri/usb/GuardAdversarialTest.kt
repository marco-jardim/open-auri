package com.openauri.usb

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.random.Random

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class GuardAdversarialTest {
    private val curve = ProtocolFixtureTest.neutral
    private val commit = ProtocolConstants.commitReport()
    private val harnesses = mutableListOf<UsbPluginHarness>()

    @After
    fun cleanup() {
        harnesses.forEach { it.plugin.handleOnDestroy() }
        BridgeSchema.assertNoViolations()
    }

    @Test
    fun everyPermutationOfFourReportsAndEveryAdjacentSwapRefusesTheCommit() {
        val ordered = (0..8).toList()
        val permutations = permutations((0..3).toList()).map { it + (4..8).toList() }
        assertEquals(24, permutations.size)
        val swaps = (0..7).map { index ->
            ordered.toMutableList().also { order ->
                order[index] = index + 1
                order[index + 1] = index
            }
        }
        (permutations.filter { it != ordered } + swaps).distinct().forEach(::assertOrderCannotCommit)
    }

    @Test
    fun seededRandomShufflesCannotCommit() {
        val random = Random(0xCB51)
        val ordered = (0..8).toList()
        val orders = List(64) { ordered.shuffled(random) }
        assertEquals(64, orders.distinct().size)
        assertTrue(orders.none { it == ordered })
        orders.forEach(::assertOrderCannotCommit)
    }

    @Test
    fun duplicatingAnyOfTheNineReportsInvalidatesTheWholeSequence() {
        // A repeated report 0 is not a duplicate but a new sequence (a live apply restarting), so
        // the first one is dropped and only the second can lead to a commit.
        val restarted = harness()
        val restartKey = restarted.connectFirst()
        assertTrue(restarted.send(restartKey, 0xCB, curve.reports[0]).resolved)
        restarted.writeCurve(restartKey, curve).forEach { assertTrue(it.resolved) }
        assertEquals(11, restarted.fake.sent.size)
        assertEquals(1, restarted.fake.sent.count { isCommit(it) })
        for (duplicate in 1..8) {
            val harness = harness()
            val key = harness.connectFirst()
            (0..duplicate).forEach { assertTrue(harness.send(key, 0xCB, curve.reports[it]).resolved) }
            val before = harness.fake.sent.size
            assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, curve.reports[duplicate]).code)
            (duplicate + 1..8).forEach {
                assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, curve.reports[it]).code)
            }
            assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, commit).code)
            assertEquals(before, harness.fake.sent.size)
            assertNoCommit(harness)
        }
    }

    @Test
    fun aForgedPayloadWithARecomputedValidCrcButWrongPreambleIsRefusedAtReportZero() {
        val payload = curve.payload.copyOf()
        payload[0] = (payload[0].toInt() xor 1).toByte()
        val crc = Crc16Ccitt.compute(payload, 0, ProtocolConstants.CRC_OFFSET)
        payload[ProtocolConstants.CRC_OFFSET] = crc.toByte()
        payload[ProtocolConstants.CRC_OFFSET + 1] = (crc ushr 8).toByte()
        val stored = (payload[218].toInt() and 0xFF) or ((payload[219].toInt() and 0xFF) shl 8)
        assertEquals(Crc16Ccitt.compute(payload, 0, 218), stored)
        assertFalse(payload.copyOf(ProtocolConstants.preamble().size).contentEquals(ProtocolConstants.preamble()))
        val reports = ProtocolFixtureTest.reportsFromPayload(payload)
        val harness = harness()
        val key = harness.connectFirst()
        val before = harness.fake.calls.size
        reports.forEachIndexed { index, report ->
            val call = harness.send(key, 0xCB, report)
            assertEquals("report $index", ErrorCodes.USB_GUARD_REJECTED, call.code)
            if (index == 0) assertEquals(FrameGuard.RejectReason.BAD_PREAMBLE.message, call.message)
            harness.nowMs += 16
        }
        harness.nowMs += 150
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, commit).code)
        assertTrue(harness.fake.sent.isEmpty())
        assertEquals(before, harness.fake.calls.size)
        assertEquals(0, harness.fake.attempts)
    }

    @Test
    fun fiftyCompleteSequencesInTenSecondsCannotCommitMoreThanOncePerTwoSeconds() {
        val harness = harness()
        val key = harness.connectFirst()
        val started = harness.nowMs
        val commitTimes = mutableListOf<Long>()
        repeat(50) { attempt ->
            harness.nowMs = started + attempt * 200L
            // An attacker need not honor writeCurve's 16 ms gaps; every payload is still valid.
            curve.reports.forEach {
                assertTrue(harness.send(key, 0xCB, it).resolved)
                harness.nowMs++
            }
            harness.nowMs += 150
            val before = harness.fake.sent.size
            val call = harness.send(key, 0xCB, commit)
            if (attempt % 10 == 0) {
                assertTrue(call.resolved)
                assertEquals(before + 1, harness.fake.sent.size)
                assertArrayEquals(UsbPluginHarness.wire(commit), harness.fake.sent.last().bytes)
                commitTimes += harness.nowMs
            } else {
                assertEquals(ErrorCodes.USB_GUARD_REJECTED, call.code)
                assertEquals(FrameGuard.RejectReason.COMMIT_TOO_SOON.message, call.message)
                assertEquals(before, harness.fake.sent.size)
            }
        }
        assertTrue(harness.nowMs - started < 10_000)
        assertEquals(5, commitTimes.size)
        assertTrue(commitTimes.zipWithNext().all { (first, second) -> second - first >= 2000 })
        assertEquals(450 + 5, harness.fake.sent.size)
        assertEquals(5, harness.fake.sent.count { isCommit(it) })
    }

    @Test
    fun twoDifferentPayloadsInterleavedReportByReportBothCommitAtTheSameInstant() {
        val harness = twoCables()
        val keys = harness.requestDevice().deviceKeys()
        keys.forEach { assertTrue(harness.open(it).resolved) }
        val curves = listOf(ProtocolFixtureTest.presets.first(), ProtocolFixtureTest.presets.last())
        repeat(9) { report ->
            keys.forEachIndexed { index, key -> assertTrue(harness.send(key, 0xCB, curves[index].reports[report]).resolved) }
            harness.nowMs += 16
        }
        harness.nowMs += 150
        keys.forEach { assertTrue(harness.send(it, 0xCB, commit).resolved) }
        assertEquals(20, harness.fake.sent.size)
        keys.forEachIndexed { index, key -> assertStream(harness, key, curves[index]) }
        assertEquals(2, harness.fake.sent.count { isCommit(it) })
    }

    @Test
    fun rejectionOnDeviceADoesNotResetDeviceBsSequenceOrCommitSpacing() {
        val harness = twoCables()
        val keys = harness.requestDevice().deviceKeys()
        keys.forEach { assertTrue(harness.open(it).resolved) }
        repeat(4) { report ->
            keys.forEach { assertTrue(harness.send(it, 0xCB, curve.reports[report]).resolved) }
            harness.nowMs += 16
        }
        val before = harness.fake.sent.size
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(keys[0], 0xCB, curve.reports[3]).code)
        assertEquals(before, harness.fake.sent.size)
        (4..8).forEach { report ->
            assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(keys[0], 0xCB, curve.reports[report]).code)
            assertTrue(harness.send(keys[1], 0xCB, curve.reports[report]).resolved)
            harness.nowMs += 16
        }
        harness.nowMs += 150
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(keys[0], 0xCB, commit).code)
        assertTrue(harness.send(keys[1], 0xCB, commit).resolved)
        assertStream(harness, keys[1], curve)
        assertEquals(4, harness.fake.sent.count { it.deviceKey == keys[0].substringBeforeLast('#') })
        // B's just-completed commit does not impose a cooldown on A's first valid sequence.
        harness.writeCurve(keys[0], curve).forEach { assertTrue(it.resolved) }
        assertEquals(2, harness.fake.sent.count { isCommit(it) })
    }

    private fun assertOrderCannotCommit(order: List<Int>) {
        val harness = harness()
        val key = harness.connectFirst()
        var rejected = false
        order.forEach { index ->
            val before = harness.fake.sent.size
            val call = harness.send(key, 0xCB, curve.reports[index])
            if (!call.resolved) {
                rejected = true
                assertEquals(order.toString(), ErrorCodes.USB_GUARD_REJECTED, call.code)
                assertEquals(before, harness.fake.sent.size)
            } else {
                assertEquals(before + 1, harness.fake.sent.size)
                assertArrayEquals(UsbPluginHarness.wire(curve.reports[index]), harness.fake.sent.last().bytes)
            }
            harness.nowMs += 16
        }
        harness.nowMs += 150
        assertTrue("order $order", rejected)
        val before = harness.fake.sent.size
        assertEquals(order.toString(), ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, commit).code)
        assertEquals(before, harness.fake.sent.size)
        assertNoCommit(harness)
    }

    private fun assertStream(harness: UsbPluginHarness, key: String, expected: ProtocolFixtureTest.Curve) {
        val sent = harness.fake.sent.filter { it.deviceKey == key.substringBeforeLast('#') }
        assertEquals(10, sent.size)
        (expected.reports + listOf(commit)).forEachIndexed { index, report ->
            assertArrayEquals(UsbPluginHarness.wire(report), sent[index].bytes)
        }
    }

    private fun assertNoCommit(harness: UsbPluginHarness) {
        assertFalse(harness.fake.sent.any { isCommit(it) })
    }

    private fun isCommit(sent: FakeUsbBackend.SentReport): Boolean = sent.bytes.contentEquals(UsbPluginHarness.wire(commit))

    private fun harness(devices: List<UsbDeviceInfo> = listOf(FakeUsbBackend.cable())): UsbPluginHarness =
        UsbPluginHarness(devices = devices).also { harnesses += it }

    private fun twoCables(): UsbPluginHarness = harness(
        listOf(
            FakeUsbBackend.cable("/dev/bus/usb/001/002", serialNumber = "A"),
            FakeUsbBackend.cable("/dev/bus/usb/001/003", interruptOut = false, serialNumber = "B"),
        ),
    )

    private fun permutations(values: List<Int>): List<List<Int>> = if (values.isEmpty()) {
        listOf(emptyList())
    } else {
        values.flatMap { first -> permutations(values - first).map { listOf(first) + it } }
    }
}
