package com.openauri.usb

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class LifecycleTest {
    private val curve = ProtocolFixtureTest.neutral
    private val commit = ProtocolConstants.commitReport()
    private val harnesses = mutableListOf<UsbPluginHarness>()

    @After
    fun cleanup() {
        harnesses.forEach { it.plugin.handleOnDestroy() }
        BridgeSchema.assertNoViolations()
    }

    @Test
    fun backgroundAtEveryPointReleasesClaimsAndRefusesTheContinuingPage() {
        for (interruptOut in listOf(true, false)) {
            for (received in 1..9) {
                val harness = harness(listOf(FakeUsbBackend.cable(interruptOut = interruptOut)))
                val key = harness.connectFirst()
                sendPrefix(harness, key, received)
                assertTrue(harness.claims.diagnostics().single().claimed)
                harness.plugin.handleOnStop()
                val claim = harness.claims.diagnostics().single()
                assertFalse(claim.claimed)
                assertEquals(ClaimManager.ReleaseReason.STOP, claim.lastRelease)
                assertEquals(1, harness.fake.calls.count { it == "release 2" })
                assertTrue(harness.scheduler.delayed.isEmpty())
                val before = harness.fake.calls.size
                (received..8).forEach { index ->
                    assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, curve.reports[index]).code)
                    harness.nowMs += 16
                }
                harness.nowMs += FrameGuard.SEQUENCE_TIMEOUT_MS + 1
                assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, commit).code)
                assertEquals(received, harness.fake.sent.size)
                assertEquals(before, harness.fake.calls.size)
                assertNoCommit(harness)
                // Resuming needs a new sequence and must acquire the released interface again.
                harness.writeCurve(key, curve).forEach { assertTrue(it.resolved) }
                assertEquals(2, harness.claims.diagnostics().single().claims)
                assertEquals(received + 10, harness.fake.sent.size)
            }
        }
    }

    // A passing-gate ActivityScenario launch on SDK 36 fails in Capacitor Bridge.loadWebView:
    // ServiceWorkerController.getInstance -> WebViewFactory.getProvider throws
    // UnsupportedOperationException. Exercise the permitted plugin-level rotation equivalent.
    @Test
    fun aFreshPluginAfterRotationHasNoSessionsAndRequiresDeviceRediscovery() {
        val old = harness()
        val oldKey = old.connectFirst()
        sendPrefix(old, oldKey, 5)
        destroy(old)
        val recreated = harness()
        assertEquals(ErrorCodes.USB_NOT_FOUND, recreated.send(oldKey, 0xCB, curve.reports[5]).code)
        assertEquals(ErrorCodes.USB_NOT_FOUND, recreated.send(oldKey, 0xCB, commit).code)
        assertEquals(ErrorCodes.USB_NOT_FOUND, recreated.open(oldKey).code)
        assertTrue(recreated.fake.sent.isEmpty())
        val rediscovered = recreated.requestDevice().deviceKeys().single()
        assertEquals(ErrorCodes.USB_NOT_OPEN, recreated.send(rediscovered, 0xCB, curve.reports[5]).code)
        assertTrue(recreated.open(rediscovered).resolved)
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, recreated.send(rediscovered, 0xCB, curve.reports[5]).code)
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, recreated.send(rediscovered, 0xCB, commit).code)
        assertNoCommit(recreated)
        recreated.writeCurve(rediscovered, curve).forEach { assertTrue(it.resolved) }
        assertEquals(10, recreated.fake.sent.size)
        assertNoCommit(old)
    }

    @Test
    fun processRecreationRejectsEveryOldKeyEvenWhenSystemPermissionSurvives() {
        val devices = listOf(
            FakeUsbBackend.cable(serialNumber = "A"),
            FakeUsbBackend.cable("/dev/bus/usb/001/003", serialNumber = "B"),
        )
        val old = harness(devices)
        val keys = old.requestDevice().deviceKeys()
        keys.forEach {
            assertTrue(old.open(it).resolved)
            sendPrefix(old, it, 9)
        }
        destroy(old)
        val restarted = harness(devices)
        devices.forEach { restarted.fake.grant(it) }
        keys.forEach { key ->
            assertEquals(ErrorCodes.USB_NOT_FOUND, restarted.open(key).code)
            assertEquals(ErrorCodes.USB_NOT_FOUND, restarted.send(key, 0xCB, commit).code)
            assertEquals(ErrorCodes.USB_NOT_FOUND, restarted.diagnostics(key).code)
        }
        assertTrue(restarted.fake.calls.isEmpty())
        assertTrue(restarted.fake.sent.isEmpty())
        val newKeys = restarted.call("getDevices").deviceKeys()
        assertEquals(2, newKeys.size)
        newKeys.forEach { key ->
            assertEquals(ErrorCodes.USB_NOT_OPEN, restarted.send(key, 0xCB, commit).code)
            assertTrue(restarted.open(key).resolved)
            assertEquals(ErrorCodes.USB_GUARD_REJECTED, restarted.send(key, 0xCB, commit).code)
            restarted.writeCurve(key, curve).forEach { assertTrue(it.resolved) }
        }
        assertEquals(20, restarted.fake.sent.size)
        assertNoCommit(old)
    }

    @Test
    fun permissionRevokedBetweenOpenAndSendReportIsDeniedWithoutSending() {
        // Use the real Android backend, not a transfer stub that manufactures a permission error.
        // Existing USB handles can outlive a grant, so the plugin must recheck authorization.
        for (interruptOut in listOf(true, false)) {
            val route = "interruptOut=$interruptOut"
            val device = FakeUsbBackend.cable(interruptOut = interruptOut)
            val io = FakeUsbIo().also {
                it.devices += device
                it.granted += device.key
            }
            val controlBuffers = mutableListOf<ByteArray>()
            val platform = object : UsbIo by io {
                override fun open(deviceKey: String): UsbIoConnection? {
                    val connection = io.open(deviceKey) ?: return null
                    io.connections.last().control = { setup, buffer, length, _ ->
                        if (setup.value == ControlSetup.HID_REPORT_DESCRIPTOR_VALUE) {
                            val descriptor = FakeUsbBackend.DEFAULT_REPORT_DESCRIPTOR
                            descriptor.copyInto(buffer)
                            descriptor.size
                        } else {
                            controlBuffers += buffer.copyOf()
                            length
                        }
                    }
                    return connection
                }
            }
            val backend = AndroidUsbBackend(
                context = ApplicationProvider.getApplicationContext(),
                io = platform,
                executorFactory = { TestWorker() },
                cancelExecutor = TestWorker(),
                isMainThread = { false },
                clock = { 100_000L },
            )
            val harness = UsbPluginHarness(wrap = { backend }).also { harnesses += it }
            fun wireBuffers(): List<ByteArray> =
                io.connections.flatMap { it.requests }.mapNotNull { it.queued } + controlBuffers
            val key = harness.connectFirst()
            repeat(4) { index ->
                assertTrue(route, harness.send(key, 0xCB, curve.reports[index]).resolved)
                harness.nowMs += 16
            }
            assertEquals(route, 4, wireBuffers().size)
            io.granted.remove(device.key)
            assertFalse(backend.hasPermission(device))
            val before = io.calls.size
            val denied = harness.send(key, 0xCB, curve.reports[4])
            assertEquals(route, ErrorCodes.USB_PERMISSION_DENIED, denied.code)
            // Only the session teardown touches the device: no claim, no transfer, zero bytes.
            assertEquals(route, listOf("release 2", "close"), io.calls.drop(before).map { it.name })
            assertEquals(route, 4, wireBuffers().size)
            // The session is gone: the page must reopen it, which needs the permission again.
            assertEquals(route, ErrorCodes.USB_NOT_OPEN, harness.send(key, 0xCB, curve.reports[4]).code)
            assertEquals(route, ErrorCodes.USB_NOT_OPEN, harness.diagnostics(key).code)
            assertEquals(route, ErrorCodes.USB_PERMISSION_DENIED, harness.open(key).code)
            assertEquals(route, 4, wireBuffers().size)
            io.granted += device.key
            assertTrue(route, harness.open(key).resolved)
            // The guard was reset: the interrupted sequence cannot be continued after the new grant.
            assertEquals(route, ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, curve.reports[4]).code)
            harness.writeCurve(key, curve).forEach { assertTrue(route, it.resolved) }
            val wire = wireBuffers()
            assertEquals(route, 14, wire.size)
            (curve.reports + listOf(commit)).forEachIndexed { index, report ->
                assertArrayEquals(route, UsbPluginHarness.wire(report), wire[4 + index])
            }
        }
    }

    @Test
    fun aRevokedSessionWhoseCloseFailsIsStillDeniedAndDropped() {
        val harness = UsbPluginHarness(wrap = ::RevocablePermissionBackend).also { harnesses += it }
        val backend = harness.backend as RevocablePermissionBackend
        val key = harness.connectFirst()
        sendPrefix(harness, key, 2)
        backend.revoked = true
        backend.closeError = UsbFailure.Closed("lane gone", null)
        val attempts = harness.fake.attempts
        val denied = harness.send(key, 0xCB, curve.reports[2])
        assertEquals(ErrorCodes.USB_PERMISSION_DENIED, denied.code)
        assertEquals(attempts, harness.fake.attempts)
        assertEquals(2, harness.fake.sent.size)
        assertEquals(ErrorCodes.USB_NOT_OPEN, harness.send(key, 0xCB, curve.reports[2]).code)
        backend.revoked = false
        backend.closeError = null
        assertTrue(harness.open(key).resolved)
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, curve.reports[2]).code)
        assertEquals(2, harness.fake.sent.size)
        assertTrue(harness.backgroundErrors.isEmpty())
    }

    @Test
    fun newMainFrameNavigationClosesBothSessionsAndResetsBothGuards() {
        val devices = listOf(
            FakeUsbBackend.cable(serialNumber = "A"),
            FakeUsbBackend.cable("/dev/bus/usb/001/003", interruptOut = false, serialNumber = "B"),
        )
        val harness = harness(devices)
        val keys = harness.requestDevice().deviceKeys()
        keys.forEachIndexed { index, key ->
            assertTrue(harness.open(key).resolved)
            sendPrefix(harness, key, if (index == 0) 4 else 9)
        }
        // Exercise the same listener callback as Capacitor's main-frame WebViewClient.
        val tracker = MainFrameUrlTracker { harness.plugin.onDocumentStarted() }
        val webView = android.webkit.WebView(ApplicationProvider.getApplicationContext())
        try {
            webView.loadUrl("https://open-auri.com/cabo?new-document=1")
            tracker.onPageStarted(webView)
            assertEquals("https://open-auri.com/cabo?new-document=1", tracker.url)
            assertEquals(2, harness.fake.calls.count { it == "close" })
            assertTrue(harness.claims.diagnostics().all { !it.claimed })
            val before = harness.fake.sent.size
            keys.forEach { key ->
                assertEquals(ErrorCodes.USB_NOT_OPEN, harness.send(key, 0xCB, commit).code)
                assertEquals(ErrorCodes.USB_NOT_OPEN, harness.diagnostics(key).code)
                assertTrue(harness.open(key).resolved)
                assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, curve.reports[4]).code)
                assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, commit).code)
            }
            assertEquals(before, harness.fake.sent.size)
            assertNoCommit(harness)
            keys.forEach { key -> harness.writeCurve(key, curve).forEach { assertTrue(it.resolved) } }
            assertEquals(before + 20, harness.fake.sent.size)
            assertTrue(harness.backgroundErrors.isEmpty())
        } finally {
            webView.destroy()
        }
    }

    @Test
    fun aReportQueuedByTheOldDocumentCannotEscapeNavigationCleanup() {
        val harness = harness()
        val key = harness.connectFirst()
        sendPrefix(harness, key, 9)
        harness.nowMs += 150
        harness.worker.queued = true
        val waitingCommit = harness.send(key, 0xCB, commit)
        assertFalse(waitingCommit.completed)
        harness.plugin.onDocumentStarted()
        harness.worker.runAll()
        harness.worker.queued = false
        assertEquals(ErrorCodes.USB_NOT_OPEN, waitingCommit.code)
        assertEquals(9, harness.fake.sent.size)
        assertNoCommit(harness)
        assertEquals("close", harness.fake.calls.last())
        assertTrue(harness.open(key).resolved)
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, commit).code)
    }

    private fun sendPrefix(harness: UsbPluginHarness, key: String, count: Int) {
        repeat(count) { index ->
            assertTrue(harness.send(key, 0xCB, curve.reports[index]).resolved)
            assertArrayEquals(UsbPluginHarness.wire(curve.reports[index]), harness.fake.sent.last().bytes)
            harness.nowMs += 16
        }
    }

    private fun harness(devices: List<UsbDeviceInfo> = listOf(FakeUsbBackend.cable())): UsbPluginHarness =
        UsbPluginHarness(devices = devices).also { harnesses += it }

    private fun destroy(harness: UsbPluginHarness) {
        harness.plugin.handleOnStop()
        harness.plugin.handleOnDestroy()
        harnesses.remove(harness)
    }

    private fun assertNoCommit(harness: UsbPluginHarness) {
        assertFalse(harness.fake.sent.any { it.bytes.contentEquals(UsbPluginHarness.wire(commit)) })
    }

    /** Permission can be revoked while the handle stays open; close can be made to fail. */
    private class RevocablePermissionBackend(private val fake: FakeUsbBackend) : UsbBackend by fake {
        @Volatile var revoked = false

        @Volatile var closeError: Exception? = null

        override fun hasPermission(device: UsbDeviceInfo): Boolean = !revoked && fake.hasPermission(device)

        override fun close(connection: UsbConnectionHandle) {
            closeError?.let { throw it }
            fake.close(connection)
        }
    }
}
