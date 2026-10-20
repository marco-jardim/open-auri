package com.openauri.usb

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ClaimManagerTest {

    /**
     * Virtual clock: tasks run on the thread that calls [advanceBy], in due order. Without
     * [honourCancel] a cancelled task still runs, like a ScheduledFuture that already started.
     */
    private class ManualScheduler(private val honourCancel: Boolean = true) : ClaimManager.Scheduler {
        private class Task(val at: Long, val runnable: Runnable) {
            @Volatile var cancelled = false
        }

        private val tasks = mutableListOf<Task>()
        private var now = 0L

        val pending: Int
            get() = synchronized(tasks) { tasks.count { !it.cancelled } }

        override fun schedule(delayMs: Long, task: Runnable): ClaimManager.Scheduled {
            val entry = synchronized(tasks) { Task(now + delayMs, task).also { tasks += it } }
            return ClaimManager.Scheduled { if (honourCancel) entry.cancelled = true }
        }

        fun advanceBy(ms: Long) {
            val target = synchronized(tasks) { now + ms }
            while (true) {
                val next = synchronized(tasks) {
                    tasks.removeAll { it.cancelled }
                    tasks.filter { it.at <= target }.minByOrNull { it.at }?.also {
                        tasks.remove(it)
                        now = it.at
                    }
                } ?: break
                next.runnable.run()
            }
            synchronized(tasks) { now = target }
        }
    }

    private val fake = FakeUsbBackend()
    private val scheduler = ManualScheduler()
    private val claims = ClaimManager(fake, scheduler, ClaimManager.IDLE_RELEASE_MS)
    private val device = fake.list(emptyList()).single()
    private val hid: UsbInterfaceInfo = UsbBackend.selectHidInterface(device)
        ?: throw AssertionError("the cable has a HID interface")
    private val out: UsbEndpointInfo = hid.interruptOut ?: throw AssertionError("the cable has an interrupt OUT")
    private lateinit var connection: UsbConnectionHandle

    @Before
    fun openCable() {
        fake.grant(device)
        connection = fake.open(device)
    }

    private fun send(): Int = claims.withClaim(connection, hid) {
        fake.transferInterrupt(connection, out, ByteArray(32), UsbBackend.DEFAULT_TIMEOUT_MS)
    }

    private fun claimCalls() = fake.calls.filter { it.startsWith("claim") }

    private fun releaseCalls() = fake.calls.filter { it.startsWith("release") }

    private fun diagnostics() = claims.diagnostics().single()

    @Test
    fun claimsOnTheFirstSendOfASequenceOnly() {
        repeat(3) { assertEquals(32, send()) }

        assertEquals(listOf("claim 2 force=false"), claimCalls())
        assertTrue(fake.isClaimed(connection, hid.id))
        val state = diagnostics()
        assertEquals(device.key, state.deviceKey)
        assertEquals(hid.id, state.interfaceId)
        assertTrue(state.claimed)
        assertFalse(state.kernelDriverDetached)
        assertEquals(1, state.claims)
        assertNull(state.lastRelease)
        assertNull(state.lastError)
    }

    @Test
    fun anIdleClaimIsReleasedAt1500Ms() {
        send()

        scheduler.advanceBy(1499)
        assertTrue(fake.isClaimed(connection, hid.id))
        assertTrue(releaseCalls().isEmpty())

        scheduler.advanceBy(1)
        assertFalse(fake.isClaimed(connection, hid.id))
        assertEquals(listOf("release 2"), releaseCalls())
        assertEquals(ClaimManager.ReleaseReason.IDLE, diagnostics().lastRelease)
        assertFalse(diagnostics().claimed)
    }

    @Test
    fun eachSendRestartsTheIdleWindowAndAReleasedInterfaceIsClaimedAgain() {
        send()
        scheduler.advanceBy(1000)
        send()
        scheduler.advanceBy(1000)
        assertTrue(releaseCalls().isEmpty())

        scheduler.advanceBy(500)
        assertEquals(listOf("release 2"), releaseCalls())

        send()
        assertEquals(listOf("claim 2 force=false", "claim 2 force=false"), claimCalls())
        assertEquals(2, diagnostics().claims)
    }

    @Test
    fun anIdleTimerThatStillFiresAfterANewSendDoesNotRelease() {
        val racy = ManualScheduler(honourCancel = false)
        val manager = ClaimManager(fake, racy, ClaimManager.IDLE_RELEASE_MS)

        manager.withClaim(connection, hid) { Unit }
        racy.advanceBy(1000)
        manager.withClaim(connection, hid) { Unit }
        racy.advanceBy(500)

        assertTrue(releaseCalls().isEmpty())
        assertTrue(fake.isClaimed(connection, hid.id))
        racy.advanceBy(1000)
        assertEquals(listOf("release 2"), releaseCalls())
    }

    @Test
    fun nestedSendsShareOneClaimAndOnlyTheLastOneArmsTheIdleRelease() {
        claims.withClaim(connection, hid) {
            claims.withClaim(connection, hid) {
                fake.transferInterrupt(connection, out, ByteArray(32), UsbBackend.DEFAULT_TIMEOUT_MS)
            }
            scheduler.advanceBy(5000)
            assertTrue(fake.isClaimed(connection, hid.id))
        }

        assertEquals(1, scheduler.pending)
        scheduler.advanceBy(ClaimManager.IDLE_RELEASE_MS)
        assertEquals(listOf("claim 2 force=false"), claimCalls())
        assertEquals(listOf("release 2"), releaseCalls())
    }

    @Test
    fun detachAndCloseOnlyForgetTheirOwnDevice() {
        val second = FakeUsbBackend.cable("/dev/bus/usb/001/003")
        val third = FakeUsbBackend.cable("/dev/bus/usb/001/004")
        listOf(second, third).forEach {
            fake.attach(it)
            fake.grant(it)
        }
        val secondConnection = fake.open(second)
        val thirdConnection = fake.open(third)
        listOf(connection, secondConnection, thirdConnection).forEach { handle ->
            claims.withClaim(handle, hid) {
                fake.transferInterrupt(handle, out, ByteArray(32), UsbBackend.DEFAULT_TIMEOUT_MS)
            }
        }

        fake.detach(second.key)
        claims.onClosed(thirdConnection)

        val states = claims.diagnostics().associateBy { it.deviceKey }
        assertTrue(states.getValue(device.key).claimed)
        assertNull(states.getValue(device.key).lastRelease)
        assertEquals(ClaimManager.ReleaseReason.DETACHED, states.getValue(second.key).lastRelease)
        assertEquals(ClaimManager.ReleaseReason.CLOSED, states.getValue(third.key).lastRelease)
    }

    @Test
    fun releaseAllOnStopReleasesAtOnceAndCancelsTheIdleTimer() {
        send()

        claims.releaseAll()
        scheduler.advanceBy(0)

        assertFalse(fake.isClaimed(connection, hid.id))
        assertEquals(ClaimManager.ReleaseReason.STOP, diagnostics().lastRelease)
        scheduler.advanceBy(5000)
        assertEquals(listOf("release 2"), releaseCalls())
        assertEquals(0, scheduler.pending)
    }

    @Test
    fun aBoundKernelDriverNeedsAForcedClaimWhichIsRecorded() {
        fake.faults.kernelDriverBound = true

        send()

        assertEquals(listOf("claim 2 force=false", "claim 2 force=true"), claimCalls())
        assertTrue(diagnostics().kernelDriverDetached)
        assertTrue(diagnostics().claimed)
    }

    @Test
    fun aBusyInterfaceFailsWithBusyAndSkipsTheSend() {
        fake.faults.claimBusy = true

        val failure = assertThrows(UsbFailure.Busy::class.java) { send() }

        assertEquals(device.key, failure.deviceKey)
        assertEquals(0, fake.attempts)
        assertEquals(listOf("claim 2 force=false", "claim 2 force=true"), claimCalls())
        scheduler.advanceBy(5000)
        assertTrue(releaseCalls().isEmpty())
        assertFalse(diagnostics().claimed)
    }

    @Test
    fun detachForgetsTheClaimsWithoutIo() {
        send()

        fake.detach(device.key)
        scheduler.advanceBy(5000)

        assertTrue(releaseCalls().isEmpty())
        assertFalse(diagnostics().claimed)
        assertEquals(ClaimManager.ReleaseReason.DETACHED, diagnostics().lastRelease)
    }

    @Test
    fun aDetachDuringASendLeavesNothingToRelease() {
        val failure = assertThrows(UsbFailure.Detached::class.java) {
            claims.withClaim(connection, hid) {
                fake.attach(FakeUsbBackend.cable("/dev/bus/usb/001/099"))
                fake.detach(device.key)
                fake.transferInterrupt(connection, out, ByteArray(32), UsbBackend.DEFAULT_TIMEOUT_MS)
            }
        }
        scheduler.advanceBy(5000)

        assertEquals(device.key, failure.deviceKey)
        assertTrue(releaseCalls().isEmpty())
        assertEquals(ClaimManager.ReleaseReason.DETACHED, diagnostics().lastRelease)
    }

    @Test
    fun aFailedBackgroundReleaseIsRecordedForDiagnostics() {
        send()
        val error = UsbFailure.NotOpen(device.key)
        fake.faults.releaseError = error

        scheduler.advanceBy(ClaimManager.IDLE_RELEASE_MS)

        assertEquals(error, diagnostics().lastError)
        assertFalse(diagnostics().claimed)
    }

    @Test
    fun onClosedForgetsTheConnection() {
        send()

        claims.onClosed(connection)
        fake.close(connection)
        scheduler.advanceBy(5000)

        assertTrue(releaseCalls().isEmpty())
        assertEquals(ClaimManager.ReleaseReason.CLOSED, diagnostics().lastRelease)
    }

    @Test
    fun onlyClaimAndReleaseEverReachTheDevice() {
        fake.faults.kernelDriverBound = true
        send()
        scheduler.advanceBy(1500)
        send()
        claims.releaseAll()
        scheduler.advanceBy(0)

        val allowed = setOf("open", "INTERRUPT", "claim 2 force=false", "claim 2 force=true", "release 2")
        assertTrue(fake.calls.toString(), fake.calls.all { it in allowed })
    }

    @Test
    fun disposeStopsListeningAndCancelsIdleReleases() {
        send()

        claims.dispose()
        scheduler.advanceBy(5000)
        fake.detach(device.key)

        assertTrue(releaseCalls().isEmpty())
        assertTrue(diagnostics().claimed)
    }

    @Test
    fun theDefaultSchedulerRunsDelayedTasksOnABackgroundThread() {
        val scheduler = ClaimManager.Scheduler.background()
        val ran = CountDownLatch(1)
        var onMain = true

        scheduler.schedule(10) {
            onMain = AndroidUsbBackend.mainThreadCheck()
            ran.countDown()
        }
        scheduler.schedule(60_000) { throw AssertionError("cancelled task ran") }.cancel()

        assertTrue(ran.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))
        assertFalse(onMain)
        ClaimManager(fake).dispose()
    }

    @Test
    fun withTheAndroidBackendClaimAndReleaseRunOffTheMainThread() {
        val app: Application = ApplicationProvider.getApplicationContext()
        val io = FakeUsbIo()
        val cable = FakeUsbBackend.cable()
        io.devices += cable
        io.granted += cable.key
        val backend = AndroidUsbBackend(
            app,
            io,
            { key -> AndroidUsbBackend.newLaneExecutor("claims-test $key") },
            AndroidUsbBackend.newLaneExecutor("claims-test-cancel"),
            AndroidUsbBackend.mainThreadCheck,
            AndroidUsbBackend.monotonicClock,
        )
        val manager = ClaimManager(backend, scheduler, ClaimManager.IDLE_RELEASE_MS)
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val hidInterface = backend.findHidInterface(cable) ?: throw AssertionError("HID interface")
        val endpoint = hidInterface.interruptOut ?: throw AssertionError("interrupt OUT")

        val sent = UsbTestSupport.offMain {
            manager.withClaim(handle, hidInterface) {
                backend.transferInterrupt(handle, endpoint, ByteArray(32), UsbBackend.DEFAULT_TIMEOUT_MS)
            }
        }
        UsbTestSupport.offMain { scheduler.advanceBy(ClaimManager.IDLE_RELEASE_MS) }
        UsbTestSupport.offMain { manager.withClaim(handle, hidInterface) { Unit } }
        manager.releaseAll()
        UsbTestSupport.offMain { scheduler.advanceBy(0) }
        backend.dispose()

        assertEquals(32, sent)
        assertEquals(
            listOf("claim 2 force=false", "release 2", "claim 2 force=false", "release 2"),
            io.calls.map { it.name }.filter { it.startsWith("claim") || it.startsWith("release") },
        )
        assertTrue(io.calls.none { it.onMain })
        assertEquals(ClaimManager.ReleaseReason.STOP, manager.diagnostics().single().lastRelease)
    }
}
