package com.openauri.usb

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Replays the JavaScript transport through the base64 bridge, not directly through the guard. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class EndToEndFixtureTest {
    @After
    fun bridgeResponsesMatchTheSchema() {
        BridgeSchema.assertNoViolations()
    }

    @Test
    fun allTwelveCurvesUseInterruptOutWithExactTransportTiming() {
        replayFixtures(interruptOut = true, largeOutput = false)
    }

    @Test
    fun allTwelveCurvesUseSetReportWithExactTransportTiming() {
        replayFixtures(interruptOut = false, largeOutput = false)
    }

    @Test
    fun allTwelveCurvesAreZeroPaddedToTheLargestOutputOnInterruptOut() {
        replayFixtures(interruptOut = true, largeOutput = true)
    }

    @Test
    fun allTwelveCurvesAreZeroPaddedToTheLargestOutputOnControl() {
        replayFixtures(interruptOut = false, largeOutput = true)
    }

    @Test
    fun writeManySpacesTwoKeysAndKeepsTheirWireStreamsIndependent() {
        val devices = listOf(
            FakeUsbBackend.cable("/dev/bus/usb/001/002"),
            FakeUsbBackend.cable("/dev/bus/usb/001/003", interruptOut = false),
        )
        val harness = UsbPluginHarness(devices = devices, isDebug = true)
        try {
            val keys = harness.requestDevice().deviceKeys()
            assertEquals(2, keys.toSet().size)
            keys.forEach { assertTrue(harness.open(it).resolved) }
            val curve = ProtocolFixtureTest.presets.first()
            val firstStart = harness.nowMs
            harness.writeCurve(keys[0], curve).forEach { assertTrue(it.resolved) }
            val firstCommit = harness.nowMs
            harness.nowMs += ProtocolConstants.WRITE_SPACING_MS
            val secondStart = harness.nowMs
            harness.writeCurve(keys[1], curve).forEach { assertTrue(it.resolved) }
            assertEquals(2000L, secondStart - firstCommit)
            assertEquals(20, harness.fake.sent.size)
            devices.forEachIndexed { index, device ->
                val sent = harness.fake.sent.filter { it.deviceKey == device.key }
                assertCurve(curve, sent, interruptOut = index == 0, paddedLength = 32)
                assertTiming(harness, keys[index], if (index == 0) firstStart else secondStart, 0)
            }
            assertEquals(List(10) { devices[0].key } + List(10) { devices[1].key }, harness.fake.sent.map { it.deviceKey })
        } finally {
            harness.plugin.handleOnDestroy()
        }
    }

    private fun replayFixtures(interruptOut: Boolean, largeOutput: Boolean) {
        val harness = UsbPluginHarness(
            devices = listOf(FakeUsbBackend.cable(interruptOut = interruptOut)),
            isDebug = true,
        )
        try {
            if (largeOutput) harness.fake.faults.reportDescriptor = DiagnosticsTest.twoOutputReports
            val key = harness.connectFirst()
            val paddedLength = if (largeOutput) 64 else 32
            assertEquals(11, ProtocolFixtureTest.presets.size)
            assertEquals(12, ProtocolFixtureTest.allCurves.size)
            assertEquals(16L, ProtocolFixtureTest.reportGapMs)
            assertEquals(150L, ProtocolFixtureTest.settleMs)
            ProtocolFixtureTest.allCurves.forEachIndexed { curveIndex, curve ->
                val before = harness.fake.sent.size
                val started = harness.nowMs
                harness.writeCurve(key, curve).forEachIndexed { report, call ->
                    assertTrue("${curve.name} report $report: ${call.code}", call.resolved)
                }
                assertCurve(curve, harness.fake.sent.drop(before), interruptOut, paddedLength)
                assertTiming(harness, key, started, curveIndex * 10)
                harness.nowMs += ProtocolConstants.WRITE_SPACING_MS
            }
            assertEquals(120, harness.fake.sent.size)
            assertTrue(harness.backgroundErrors.isEmpty())
        } finally {
            harness.plugin.handleOnDestroy()
        }
    }

    private fun assertCurve(
        curve: ProtocolFixtureTest.Curve,
        sent: List<FakeUsbBackend.SentReport>,
        interruptOut: Boolean,
        paddedLength: Int,
    ) {
        val reports = curve.reports + listOf(ProtocolConstants.commitReport())
        assertEquals(curve.name, 10, sent.size)
        reports.forEachIndexed { index, data ->
            // Anexo D: the ID is separate at the bridge and prepended exactly once on the wire.
            val expected = ByteArray(paddedLength)
            expected[0] = 0xCB.toByte()
            data.copyInto(expected, 1)
            val actual = sent[index]
            assertArrayEquals("${curve.name} buffer $index", expected, actual.bytes)
            assertEquals(1000, actual.timeoutMs)
            if (interruptOut) {
                assertEquals(FakeUsbBackend.Route.INTERRUPT, actual.route)
                assertEquals(FakeUsbBackend.INTERRUPT_OUT_ADDRESS, actual.endpointAddress)
                assertNull(actual.setup)
            } else {
                assertEquals(FakeUsbBackend.Route.CONTROL, actual.route)
                assertNull(actual.endpointAddress)
                val setup = checkNotNull(actual.setup)
                assertEquals(0x21, setup.requestType)
                assertEquals(0x09, setup.request)
                assertEquals(0x02CB, setup.value)
                assertEquals(FakeUsbBackend.HID_INTERFACE_ID, setup.index)
                // ControlSetup has no length field; the backend transfers the entire supplied buffer.
                assertEquals(paddedLength, actual.bytes.size)
            }
        }
    }

    private fun assertTiming(harness: UsbPluginHarness, key: String, started: Long, offset: Int) {
        val log = checkNotNull(harness.diagnostics(key).payload).getJSONArray("wireLog")
        repeat(9) { index ->
            assertEquals(started + index * 16L, log.getJSONObject(offset + index).getLong("atMs"))
        }
        assertEquals(started + 9 * 16L + 150L, log.getJSONObject(offset + 9).getLong("atMs"))
    }
}
