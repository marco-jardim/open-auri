package com.openauri.usb

import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PermissionBrokerTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val asked = CopyOnWriteArrayList<Pair<String, PendingIntent>>()

    @Volatile private var requester: (String, PendingIntent) -> Unit = { key, intent -> asked += key to intent }

    private val broker = PermissionBroker(app) { key, intent -> requester(key, intent) }

    private fun permissionReceivers() =
        shadowOf(app).registeredReceivers.filter { it.intentFilter.hasAction(PermissionBroker.ACTION_PERMISSION) }

    /** Plays the system: sends the pending intent back with the user's answer filled in. */
    private fun answer(intent: PendingIntent, granted: Boolean?) {
        val fillIn = Intent()
        if (granted != null) fillIn.putExtra(UsbManager.EXTRA_PERMISSION_GRANTED, granted)
        intent.send(app, 0, fillIn)
        UsbTestSupport.idleMain()
    }

    private fun results(): Pair<MutableList<Result<Boolean>>, PermissionCallback> {
        val results = mutableListOf<Result<Boolean>>()
        return results to { result -> results += result }
    }

    @Test
    fun grantedResolvesTrueAndReleasesTheReceiverAndPendingIntent() {
        val (results, callback) = results()

        broker.request("/dev/bus/usb/001/002", callback)

        val (key, intent) = asked.single()
        val receiver = permissionReceivers().single()
        val shadow = shadowOf(intent)
        assertEquals("/dev/bus/usb/001/002", key)
        assertEquals(1, broker.inFlightCount)
        assertEquals(
            Context.RECEIVER_NOT_EXPORTED,
            receiver.flags and (Context.RECEIVER_EXPORTED or Context.RECEIVER_NOT_EXPORTED),
        )
        assertTrue(intent.isBroadcast)
        assertEquals(PermissionBroker.ACTION_PERMISSION, shadow.savedIntent.action)
        assertEquals(app.packageName, shadow.savedIntent.`package`)
        assertTrue((shadow.flags and PendingIntent.FLAG_MUTABLE) != 0)
        assertTrue((shadow.flags and PendingIntent.FLAG_IMMUTABLE) == 0)
        assertTrue(results.isEmpty())

        answer(intent, true)

        assertEquals(listOf(true), results.map { it.getOrNull() })
        assertTrue(permissionReceivers().isEmpty())
        assertTrue(shadow.isCanceled)
        assertEquals(0, broker.inFlightCount)
    }

    @Test
    fun deniedOrMissingAnswerResolvesFalse() {
        val (results, callback) = results()

        broker.request("a", callback)
        answer(asked[0].second, false)
        broker.request("a", callback)
        answer(asked[1].second, null)

        assertEquals(listOf(false, false), results.map { it.getOrNull() })
        assertTrue(permissionReceivers().isEmpty())
    }

    @Test
    fun concurrentRequestsForOneDeviceShareOneDialog() {
        val (first, firstCallback) = results()
        val (second, secondCallback) = results()

        broker.request("a", firstCallback)
        broker.request("a", secondCallback)

        assertEquals(1, asked.size)
        assertEquals(1, permissionReceivers().size)
        answer(asked.single().second, true)
        assertEquals(listOf(true), first.map { it.getOrNull() })
        assertEquals(listOf(true), second.map { it.getOrNull() })
        assertTrue(permissionReceivers().isEmpty())
    }

    @Test
    fun answersAreRoutedByDeviceKey() {
        val (forA, callbackA) = results()
        val (forB, callbackB) = results()

        broker.request("a", callbackA)
        broker.request("b", callbackB)
        assertEquals(listOf("a", "b"), asked.map { it.first })
        assertEquals(2, permissionReceivers().size)

        answer(asked[1].second, false)
        assertTrue(forA.isEmpty())
        assertEquals(listOf(false), forB.map { it.getOrNull() })
        assertEquals(1, permissionReceivers().size)

        answer(asked[0].second, true)
        assertEquals(listOf(true), forA.map { it.getOrNull() })
        assertTrue(permissionReceivers().isEmpty())
    }

    @Test
    fun aFailingRequesterResolvesWithItsFailureAndUnregisters() {
        val (results, callback) = results()
        requester = { key, _ -> throw UsbFailure.NotFound(key) }

        broker.request("gone", callback)

        assertTrue(results.single().exceptionOrNull() is UsbFailure.NotFound)
        assertTrue(permissionReceivers().isEmpty())
        assertEquals(0, broker.inFlightCount)
    }

    @Test
    fun disposeFailsPendingRequestsOnceAndRefusesNewOnes() {
        val (pending, pendingCallback) = results()
        val (racing, racingCallback) = results()
        val (late, lateCallback) = results()
        broker.request("a", pendingCallback)
        requester = { key, _ ->
            broker.dispose()
            throw UsbFailure.NotFound(key)
        }

        broker.request("b", racingCallback)
        broker.request("c", lateCallback)

        assertTrue(pending.single().exceptionOrNull() is UsbFailure.Closed)
        assertTrue(racing.single().exceptionOrNull() is UsbFailure.Closed)
        assertTrue(late.single().exceptionOrNull() is UsbFailure.Closed)
        assertTrue(permissionReceivers().isEmpty())
        assertTrue(shadowOf(asked.single().second).isCanceled)
    }

    @Test
    fun backendGrantsAtOnceWhenPermittedAndOtherwiseAsksThroughTheBroker() {
        val io = FakeUsbIo()
        val cable = FakeUsbBackend.cable()
        io.devices += cable
        val backend = AndroidUsbBackend(
            app,
            io,
            { key -> AndroidUsbBackend.newLaneExecutor("permission-test $key") },
            AndroidUsbBackend.newLaneExecutor("permission-test-cancel"),
            AndroidUsbBackend.mainThreadCheck,
            AndroidUsbBackend.monotonicClock,
        )
        val (results, callback) = results()

        backend.requestPermission(cable, callback)
        assertTrue(results.isEmpty())
        val receiver = permissionReceivers().single()
        answer(io.permissionIntents.single(), true)
        io.granted += cable.key
        backend.requestPermission(cable, callback)
        io.granted.clear()
        io.permissionFailure = UsbFailure.NotFound(cable.key)
        backend.requestPermission(cable, callback)
        backend.dispose()

        assertEquals(Context.RECEIVER_NOT_EXPORTED, receiver.flags and Context.RECEIVER_NOT_EXPORTED)
        assertEquals(listOf(true, true), results.take(2).map { it.getOrNull() })
        assertTrue(results[2].exceptionOrNull() is UsbFailure.NotFound)
        assertTrue(permissionReceivers().isEmpty())
        assertTrue(io.calls.isEmpty())
        assertNull(results.getOrNull(3))
        assertThrows(UsbFailure.Closed::class.java) { backend.hasPermission(cable) }
    }
}
