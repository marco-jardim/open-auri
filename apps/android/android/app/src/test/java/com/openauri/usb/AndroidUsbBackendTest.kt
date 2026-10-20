package com.openauri.usb

import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.usb.UsbConfiguration
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import android.os.Handler
import android.os.Looper
import android.os.Parcelable
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Proxy
import java.nio.ByteBuffer
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** Threads and waits shared by the USB tests (the Robolectric test thread is the main thread). */
internal object UsbTestSupport {
    const val WAIT_SECONDS: Long = 5

    private val workers: ExecutorService = Executors.newCachedThreadPool { task ->
        Thread(task, "usb-test-worker").apply { isDaemon = true }
    }

    /** Runs [block] on a worker thread. */
    fun <T> async(block: () -> T): Future<T> = workers.submit(Callable { block() })

    /** Runs [block] on a worker thread and returns its result, rethrowing its failure. */
    fun <T> offMain(block: () -> T): T = try {
        async(block).get(WAIT_SECONDS, TimeUnit.SECONDS)
    } catch (failure: ExecutionException) {
        throw failure.cause ?: failure
    }

    /** The failure [future] completed with. */
    fun failureOf(future: Future<*>): Throwable {
        try {
            future.get(WAIT_SECONDS, TimeUnit.SECONDS)
        } catch (failure: ExecutionException) {
            return failure.cause ?: failure
        }
        throw AssertionError("expected the call to fail")
    }

    /** The failure of [block] run on a worker thread. */
    fun failureOffMain(block: () -> Any?): Throwable = failureOf(async(block))

    /** Waits until [condition] holds. */
    fun eventually(what: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_SECONDS)
        while (!condition()) {
            if (System.nanoTime() > deadline) throw AssertionError("timed out waiting for $what")
            Thread.sleep(2)
        }
    }

    /** Delivers pending broadcasts and posts of the main looper. */
    fun idleMain() {
        shadowOf(Looper.getMainLooper()).idle()
    }

    /** Listener that appends `attached <key>` / `detached <key>` to [events]. */
    fun recordingListener(events: MutableList<String>): UsbDeviceListener = object : UsbDeviceListener {
        override fun onAttached(device: UsbDeviceInfo) {
            events += "attached ${device.key}"
        }

        override fun onDetached(device: UsbDeviceInfo) {
            events += "detached ${device.key}"
        }
    }
}

/** One call through the [UsbIo] seam and whether it ran on the main thread. */
internal class IoCall(val name: String, val onMain: Boolean)

/**
 * Scriptable [UsbIo]. Only USB I/O (open, connection and request calls) is recorded in [calls];
 * the main-thread flag of each call backs the "no USB I/O on the main thread" assertions.
 */
internal class FakeUsbIo : UsbIo {
    val calls = CopyOnWriteArrayList<IoCall>()
    val devices = CopyOnWriteArrayList<UsbDeviceInfo>()
    val granted: MutableSet<String> = ConcurrentHashMap.newKeySet()
    val permissionIntents = CopyOnWriteArrayList<PendingIntent>()
    val connections = CopyOnWriteArrayList<FakeIoConnection>()

    @Volatile var permissionFailure: UsbFailure? = null

    @Volatile var openFails = false

    fun record(name: String) {
        calls += IoCall(name, Looper.getMainLooper().isCurrentThread)
    }

    /** A system broadcast for [deviceKey] as [deviceFrom] understands it. */
    fun intent(action: String, deviceKey: String): Intent = Intent(action).putExtra(EXTRA_KEY, deviceKey)

    override fun devices(): List<UsbDeviceInfo> = devices.toList()

    override fun hasPermission(deviceKey: String): Boolean = deviceKey in granted

    override fun requestPermission(deviceKey: String, intent: PendingIntent) {
        permissionFailure?.let { throw it }
        permissionIntents += intent
    }

    override fun open(deviceKey: String): UsbIoConnection? {
        record("open")
        if (openFails || deviceKey !in granted) return null
        return FakeIoConnection(this).also { connections += it }
    }

    override fun deviceFrom(intent: Intent): UsbDeviceInfo? =
        intent.getStringExtra(EXTRA_KEY)?.let { key -> devices.firstOrNull { it.key == key } }

    companion object {
        const val EXTRA_KEY: String = "test.usb.DEVICE_KEY"
    }
}

/** Scriptable [UsbIoConnection]; by default every transfer succeeds in full. */
internal class FakeIoConnection(private val io: FakeUsbIo) : UsbIoConnection {
    val requests = CopyOnWriteArrayList<FakeIoRequest>()
    val controlSetups = CopyOnWriteArrayList<ControlSetup>()
    val controlLengths = CopyOnWriteArrayList<Int>()
    val waits = CopyOnWriteArrayList<Long>()

    @Volatile var rawDescriptors: ByteArray? = FakeUsbBackend.DEFAULT_RAW_DESCRIPTORS

    @Volatile var control: (ControlSetup, ByteArray, Int, Int) -> Int = { _, _, length, _ -> length }

    @Volatile var claimResult: (UsbInterfaceInfo, Boolean) -> Boolean = { _, _ -> true }

    @Volatile var initializeFails = false

    @Volatile var queueFails = false

    /** Behaviour of [requestWait]; by default it completes the last queued request in full. */
    @Volatile var waiter: (Long) -> UsbIoRequest? = { _ -> requests.lastOrNull()?.also { it.complete() } }

    @Volatile var closed = false

    override fun rawDescriptors(): ByteArray? {
        io.record("rawDescriptors")
        return rawDescriptors
    }

    override fun controlTransfer(setup: ControlSetup, buffer: ByteArray, length: Int, timeoutMs: Int): Int {
        io.record("controlTransfer")
        controlSetups += setup
        controlLengths += length
        return control(setup, buffer, length, timeoutMs)
    }

    override fun claimInterface(usbInterface: UsbInterfaceInfo, force: Boolean): Boolean {
        io.record("claim ${usbInterface.id} force=$force")
        return claimResult(usbInterface, force)
    }

    override fun releaseInterface(usbInterface: UsbInterfaceInfo): Boolean {
        io.record("release ${usbInterface.id}")
        return true
    }

    override fun openRequest(endpoint: UsbEndpointInfo): UsbIoRequest? {
        io.record("openRequest")
        if (initializeFails) return null
        return FakeIoRequest(io, endpoint, queueFails).also { requests += it }
    }

    override fun requestWait(timeoutMs: Long): UsbIoRequest? {
        io.record("requestWait")
        waits += timeoutMs
        return waiter(timeoutMs)
    }

    override fun close() {
        io.record("close")
        closed = true
    }
}

/** Scriptable [UsbIoRequest] that keeps a copy of the bytes it was queued with. */
internal class FakeIoRequest(
    private val io: FakeUsbIo,
    val endpoint: UsbEndpointInfo,
    private val queueFails: Boolean,
) : UsbIoRequest {
    val cancelLatch = CountDownLatch(1)

    @Volatile var queued: ByteArray? = null

    @Volatile var cancelled = false

    @Volatile var closed = false

    @Volatile private var buffer: ByteBuffer? = null

    override fun queue(buffer: ByteBuffer): Boolean {
        io.record("queue")
        this.buffer = buffer
        queued = ByteArray(buffer.remaining()).also { buffer.duplicate().get(it) }
        return !queueFails
    }

    override fun cancel(): Boolean {
        io.record("cancel")
        cancelled = true
        cancelLatch.countDown()
        return true
    }

    override fun close() {
        io.record("closeRequest")
        closed = true
    }

    /** Marks the whole buffer as transferred, as `UsbRequest` does on completion. */
    fun complete() {
        buffer?.let { it.position(it.limit()) }
    }
}

/** Executor that runs every task on the main looper, to prove the lane's Looper assertion. */
internal class MainLooperExecutor : AbstractExecutorService() {
    private val handler = Handler(Looper.getMainLooper())

    @Volatile private var shut = false

    override fun execute(command: Runnable) {
        handler.post(command)
    }

    override fun shutdown() {
        shut = true
    }

    override fun shutdownNow(): MutableList<Runnable> {
        shut = true
        return mutableListOf()
    }

    override fun isShutdown(): Boolean = shut

    override fun isTerminated(): Boolean = shut

    override fun awaitTermination(timeout: Long, unit: TimeUnit): Boolean = true
}

/**
 * Real framework USB objects for Robolectric. Their constructors are hidden from the SDK stubs,
 * so they are built by reflection against the SDK 36 runtime used by these tests.
 */
internal object FrameworkUsb {
    private val int: Class<*> = Integer.TYPE

    fun endpoint(address: Int, attributes: Int): UsbEndpoint =
        UsbEndpoint::class.java.getDeclaredConstructor(int, int, int, int)
            .apply { isAccessible = true }
            .newInstance(address, attributes, 64, 1)

    fun usbInterface(id: Int, interfaceClass: Int, vararg endpoints: UsbEndpoint): UsbInterface {
        val usbInterface = UsbInterface::class.java
            .getDeclaredConstructor(int, int, String::class.java, int, int, int)
            .apply { isAccessible = true }
            .newInstance(id, 0, "interface $id", interfaceClass, 0, 0)
        UsbInterface::class.java.getDeclaredMethod("setEndpoints", Array<Parcelable>::class.java)
            .apply { isAccessible = true }
            .invoke(usbInterface, arrayOf<Parcelable>(*endpoints))
        return usbInterface
    }

    fun device(
        name: String,
        vendorId: Int,
        productId: Int,
        vararg interfaces: UsbInterface,
        serial: () -> String? = { null },
    ): UsbDevice {
        val configuration = UsbConfiguration::class.java
            .getDeclaredConstructor(int, String::class.java, int, int)
            .apply { isAccessible = true }
            .newInstance(1, "config", 0x80, 50)
        UsbConfiguration::class.java.getDeclaredMethod("setInterfaces", Array<Parcelable>::class.java)
            .apply { isAccessible = true }
            .invoke(configuration, arrayOf<Parcelable>(*interfaces))
        val constructor = UsbDevice::class.java.declaredConstructors
            .filter { ctor -> ctor.parameterTypes.any { it == Array<UsbConfiguration>::class.java } }
            .maxByOrNull { it.parameterCount }
            ?: throw AssertionError("no UsbDevice constructor takes configurations")
        constructor.isAccessible = true
        val strings = ArrayDeque(listOf(name, "OpenAuri", FakeUsbBackend.PRODUCT_NAME, "1.00"))
        val ints = ArrayDeque(listOf(vendorId, productId, 0, 0, 0))
        val args = constructor.parameterTypes.map { type ->
            when {
                type == String::class.java -> strings.removeFirstOrNull()
                type == int -> ints.removeFirstOrNull() ?: 0
                type == java.lang.Boolean.TYPE -> false
                type == Array<UsbConfiguration>::class.java -> arrayOf(configuration)
                type.isInterface -> Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { proxy, method, arguments ->
                    if (method.name == "getSerial") serial() else defaults.invoke(proxy, method, arguments)
                }
                else -> null
            }
        }
        return constructor.newInstance(*args.toTypedArray()) as UsbDevice
    }

    /** The cable as [FakeUsbBackend.cable] describes it: audio 0 and 1, HID 2 with 0x83 and 0x04. */
    fun cable(name: String): UsbDevice = device(
        name,
        FakeUsbBackend.VENDOR_ID,
        FakeUsbBackend.PRODUCT_ID,
        usbInterface(0, UsbBackend.CLASS_AUDIO),
        usbInterface(1, UsbBackend.CLASS_AUDIO, endpoint(0x01, 0x09)),
        usbInterface(
            FakeUsbBackend.HID_INTERFACE_ID,
            UsbBackend.CLASS_HID,
            endpoint(0x83, 0x03),
            endpoint(FakeUsbBackend.INTERRUPT_OUT_ADDRESS, 0x03),
        ),
    )

    fun connection(device: UsbDevice): UsbDeviceConnection =
        UsbDeviceConnection::class.java.getDeclaredConstructor(UsbDevice::class.java)
            .apply { isAccessible = true }
            .newInstance(device)

    private val defaults = InvocationHandler { _, method, _ ->
        when (method.returnType) {
            Integer.TYPE -> 0
            java.lang.Boolean.TYPE -> false
            java.lang.Long.TYPE -> 0L
            else -> null
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class AndroidUsbBackendTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val cable = FakeUsbBackend.cable()
    private val hid: UsbInterfaceInfo = cable.interfaces[FakeUsbBackend.HID_INTERFACE_ID]
    private val out: UsbEndpointInfo = hid.endpoints.single { it.isInterruptOut }
    private val setReport = ControlSetup(0x21, 0x09, 0x02CB, FakeUsbBackend.HID_INTERFACE_ID)
    private val io = FakeUsbIo()
    private val backends = mutableListOf<AndroidUsbBackend>()
    private val lanes = CopyOnWriteArrayList<ThreadPoolExecutor>()

    @Before
    fun plugCable() {
        io.devices += cable
        io.granted += cable.key
    }

    @After
    fun disposeBackends() {
        backends.forEach { it.dispose() }
    }

    private fun backend(
        usbIo: UsbIo? = io,
        executorFactory: (String) -> ExecutorService = { key -> trackedLane(key) },
        clock: () -> Long = AndroidUsbBackend.monotonicClock,
    ): AndroidUsbBackend = AndroidUsbBackend(
        app,
        usbIo,
        executorFactory,
        AndroidUsbBackend.newLaneExecutor("test-cancel"),
        AndroidUsbBackend.mainThreadCheck,
        clock,
    ).also { backends += it }

    private fun trackedLane(key: String): ExecutorService =
        (AndroidUsbBackend.newLaneExecutor("test-io $key") as ThreadPoolExecutor).also { lanes += it }

    private fun receiversFor(action: String) =
        shadowOf(app).registeredReceivers.filter { it.intentFilter.hasAction(action) }

    private fun iface(id: Int, interfaceClass: Int, vararg endpoints: UsbEndpointInfo) =
        UsbInterfaceInfo(id, 0, interfaceClass, 0, 0, endpoints.toList())

    private fun device(key: String, vararg interfaces: UsbInterfaceInfo) =
        UsbDeviceInfo(key, 1, 2, null, null, interfaces.toList())

    private fun detach() {
        app.sendBroadcast(io.intent(UsbManager.ACTION_USB_DEVICE_DETACHED, cable.key))
        UsbTestSupport.idleMain()
    }

    /** Makes the next requestWait block until [release] opens (or the request is cancelled). */
    private fun blockNextWait(connection: FakeIoConnection, release: CountDownLatch): CountDownLatch {
        val waiting = CountDownLatch(1)
        connection.waiter = { _ ->
            val request = connection.requests.last()
            waiting.countDown()
            while (release.count > 0 && request.cancelLatch.count > 0) Thread.sleep(2)
            request.complete()
            request
        }
        return waiting
    }

    @Test
    fun findHidInterfacePicksTheHidClassOnACompositeAudioDevice() {
        val chosen = backend().findHidInterface(cable)

        assertEquals(UsbBackend.CLASS_AUDIO, cable.interfaces[0].interfaceClass)
        assertEquals(FakeUsbBackend.HID_INTERFACE_ID, chosen?.id)
        assertEquals(UsbBackend.CLASS_HID, chosen?.interfaceClass)
        assertSame(out, chosen?.interruptOut)
    }

    @Test
    fun findHidInterfacePrefersInterruptOutAndFallsBackToTheFirstHid() {
        val inOnly = iface(3, UsbBackend.CLASS_HID, UsbEndpointInfo(0x81, 0x03, 8, 1))
        val withOut = iface(4, UsbBackend.CLASS_HID, UsbEndpointInfo(0x81, 0x03, 8, 1), UsbEndpointInfo(0x02, 0x03, 8, 1))

        assertEquals(4, UsbBackend.selectHidInterface(device("a", iface(0, UsbBackend.CLASS_AUDIO), inOnly, withOut))?.id)
        assertEquals(3, UsbBackend.selectHidInterface(device("b", iface(0, UsbBackend.CLASS_AUDIO), inOnly))?.id)
        assertNull(UsbBackend.selectHidInterface(device("c", iface(0, UsbBackend.CLASS_AUDIO))))
    }

    @Test
    fun endpointInfoDecodesDirectionAndType() {
        val iso = UsbEndpointInfo(0x01, 0x09, 192, 1)
        val interruptIn = UsbEndpointInfo(0x83, 0x03, 64, 1)

        assertFalse(iso.isIn)
        assertFalse(iso.isInterrupt)
        assertFalse(iso.isInterruptOut)
        assertTrue(interruptIn.isIn)
        assertFalse(interruptIn.isInterruptOut)
        assertTrue(out.isInterruptOut)
        assertEquals(64, out.maxPacketSize)
        assertEquals(1, out.interval)
    }

    @Test
    fun listAppliesVendorAndProductFilters() {
        io.devices += UsbDeviceInfo("/dev/bus/usb/001/003", 0x1234, FakeUsbBackend.PRODUCT_ID, null, null, emptyList())
        val backend = backend()
        val vid = FakeUsbBackend.VENDOR_ID
        val pid = FakeUsbBackend.PRODUCT_ID

        assertEquals(2, backend.list(emptyList()).size)
        assertEquals(listOf(cable.key), backend.list(listOf(UsbFilter(vid, null))).map { it.key })
        assertEquals(listOf(cable.key), backend.list(listOf(UsbFilter(vid, pid))).map { it.key })
        assertTrue(backend.list(listOf(UsbFilter(vid, 0x0001))).isEmpty())
        assertEquals(2, backend.list(listOf(UsbFilter(null, pid))).size)
        assertEquals(2, backend.list(listOf(UsbFilter(0x0001, null), UsbFilter(null, null))).size)
        assertEquals(FakeUsbBackend.PRODUCT_NAME, backend.list(emptyList()).first().productName)
        assertEquals("Generic", backend.list(emptyList()).first().manufacturerName)
    }

    @Test
    fun withoutUsbHostEveryCallFailsWithNoHostAndNoReceiverIsRegistered() {
        val backend = backend(usbIo = null)
        var result: Result<Boolean>? = null

        backend.requestPermission(cable) { result = it }

        assertFalse(backend.hasHost)
        assertTrue(receiversFor(UsbManager.ACTION_USB_DEVICE_DETACHED).isEmpty())
        assertTrue(result?.exceptionOrNull() is UsbFailure.NoHost)
        assertThrows(UsbFailure.NoHost::class.java) { backend.list(emptyList()) }
        assertThrows(UsbFailure.NoHost::class.java) { backend.hasPermission(cable) }
        assertTrue(UsbTestSupport.failureOffMain { backend.open(cable) } is UsbFailure.NoHost)
    }

    @Test
    fun deviceReceiverIsExportedForSystemBroadcastsAndUnregisteredOnDispose() {
        assertEquals(36, app.applicationInfo.targetSdkVersion)
        val backend = backend()
        val receiver = receiversFor(UsbManager.ACTION_USB_DEVICE_DETACHED).single()
        val exportFlags = Context.RECEIVER_EXPORTED or Context.RECEIVER_NOT_EXPORTED

        assertTrue(backend.hasHost)
        assertTrue(receiver.intentFilter.hasAction(UsbManager.ACTION_USB_DEVICE_ATTACHED))
        assertEquals(Context.RECEIVER_EXPORTED, receiver.flags and exportFlags)

        backend.dispose()
        backend.dispose()

        assertTrue(receiversFor(UsbManager.ACTION_USB_DEVICE_DETACHED).isEmpty())
        assertThrows(UsbFailure.Closed::class.java) { backend.list(emptyList()) }
    }

    @Test
    fun attachAndDetachBroadcastsReachListenersUntilRemoved() {
        val backend = backend()
        val events = CopyOnWriteArrayList<String>()
        val listener = UsbTestSupport.recordingListener(events)
        backend.addListener(listener)

        app.sendBroadcast(io.intent(UsbManager.ACTION_USB_DEVICE_ATTACHED, cable.key))
        app.sendBroadcast(Intent(UsbManager.ACTION_USB_DEVICE_DETACHED))
        detach()
        backend.removeListener(listener)
        app.sendBroadcast(io.intent(UsbManager.ACTION_USB_DEVICE_ATTACHED, cable.key))
        UsbTestSupport.idleMain()

        assertEquals(listOf("attached ${cable.key}", "detached ${cable.key}"), events.toList())
    }

    @Test
    fun interruptOutQueuesTheBufferAndWaitsOffTheMainThread() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val report = ByteArray(32) { it.toByte() }

        val sent = UsbTestSupport.offMain { backend.transferInterrupt(handle, out, report, UsbBackend.DEFAULT_TIMEOUT_MS) }

        val connection = io.connections.single()
        val request = connection.requests.single()
        assertEquals(32, sent)
        assertSame(handle, UsbTestSupport.offMain { backend.open(cable) })
        assertSame(cable, handle.device)
        assertArrayEquals(report, request.queued)
        assertEquals(out.address, request.endpoint.address)
        assertTrue(request.closed)
        assertFalse(request.cancelled)
        assertEquals(listOf(UsbBackend.DEFAULT_TIMEOUT_MS.toLong()), connection.waits.toList())
        assertEquals(1, io.calls.count { it.name == "open" })
        assertTrue(io.calls.none { it.onMain })
    }

    @Test
    fun requestWaitTimeoutCancelsReapsAndClosesTheRequest() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()
        connection.waiter = { timeoutMs ->
            if (timeoutMs == 1000L) throw TimeoutException("no completion") else connection.requests.last()
        }

        val failure = UsbTestSupport.failureOffMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }

        val request = connection.requests.single()
        assertTrue(failure is UsbFailure.Timeout)
        assertEquals(1000, (failure as UsbFailure.Timeout).timeoutMs)
        assertEquals(cable.key, failure.deviceKey)
        assertTrue(failure.cause is TimeoutException)
        assertTrue(request.cancelled)
        assertTrue(request.closed)
        assertEquals(listOf(1000L, AndroidUsbBackend.REAP_TIMEOUT_MS), connection.waits.toList())
        assertTrue(io.calls.none { it.onMain })
    }

    @Test
    fun aCancelledRequestTheKernelNeverHandsBackIsClosedAfterTheConnection() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()
        connection.waiter = { throw TimeoutException("never") }

        val failure = UsbTestSupport.failureOffMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }
        val request = connection.requests.single()
        val closedEarly = request.closed
        UsbTestSupport.offMain { backend.close(handle) }

        assertTrue(failure is UsbFailure.Timeout)
        assertEquals(1, failure.suppressed.size)
        assertTrue(request.cancelled)
        assertFalse(closedEarly)
        assertTrue(connection.closed)
        assertTrue(request.closed)
        val names = io.calls.map { it.name }
        assertTrue(names.indexOf("close") < names.lastIndexOf("closeRequest"))
    }

    @Test
    fun lateOrphanIsClosedAndCurrentTransferKeepsWaitingWithTheRemainingBudget() {
        val now = AtomicLong(100L)
        val backend = backend(clock = { now.get() })
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()
        connection.waiter = { throw TimeoutException("orphan") }
        assertTrue(UsbTestSupport.failureOffMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) } is UsbFailure.Timeout)
        val orphan = connection.requests.single()
        assertFalse(orphan.closed)
        connection.waits.clear()
        val waits = AtomicInteger()
        connection.waiter = {
            if (waits.getAndIncrement() == 0) {
                now.addAndGet(250)
                orphan
            } else {
                connection.requests.last().also { it.complete() }
            }
        }
        assertEquals(32, UsbTestSupport.offMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) })
        assertTrue(orphan.closed)
        assertTrue(connection.requests.last().closed)
        assertFalse(connection.requests.last().cancelled)
        assertEquals(listOf(1000L, 750L), connection.waits.toList())
    }

    @Test
    fun reapingAnOrphanCannotExtendTheCurrentTransferTimeout() {
        val now = AtomicLong(100L)
        val backend = backend(clock = { now.get() })
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()
        connection.waiter = { throw TimeoutException("orphan") }
        assertTrue(UsbTestSupport.failureOffMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) } is UsbFailure.Timeout)
        val orphan = connection.requests.single()
        connection.waits.clear()
        connection.waiter = {
            now.addAndGet(1000)
            if (!orphan.closed) orphan else connection.requests.last()
        }
        assertTrue(UsbTestSupport.failureOffMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) } is UsbFailure.Timeout)
        assertTrue(orphan.closed)
        assertTrue(connection.requests.last().cancelled)
        assertTrue(connection.requests.last().closed)
        assertEquals(listOf(1000L, AndroidUsbBackend.REAP_TIMEOUT_MS), connection.waits.toList())
    }

    @Test
    fun requestWaitReturningNoRequestIsATransferFailure() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()
        val waits = AtomicInteger()
        connection.waiter = { _ -> if (waits.getAndIncrement() == 0) null else connection.requests.last() }

        val failure = UsbTestSupport.failureOffMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }

        val request = connection.requests.single()
        assertTrue(failure is UsbFailure.TransferFailed)
        assertEquals(-1, (failure as UsbFailure.TransferFailed).code)
        assertTrue(request.cancelled)
        assertTrue(request.closed)
    }

    @Test
    fun initializeOrQueueFailuresAreTransferFailures() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()

        connection.initializeFails = true
        val notInitialized = UsbTestSupport.failureOffMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }
        connection.initializeFails = false
        connection.queueFails = true
        val notQueued = UsbTestSupport.failureOffMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }

        assertTrue(notInitialized is UsbFailure.TransferFailed)
        assertTrue(notQueued is UsbFailure.TransferFailed)
        assertTrue(connection.requests.single().closed)
        assertTrue(connection.waits.isEmpty())
    }

    @Test
    fun detachDuringATransferEmitsTheEventThenCancelsReleasesAndFailsWithDetached() {
        val backend = backend()
        val events = CopyOnWriteArrayList<String>()
        backend.addListener(UsbTestSupport.recordingListener(events))
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        assertTrue(UsbTestSupport.offMain { backend.claim(handle, hid, true) })
        val connection = io.connections.single()
        val waiting = CountDownLatch(1)
        connection.waiter = { _ ->
            val request = connection.requests.last()
            waiting.countDown()
            if (request.cancelLatch.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS)) events += "cancelled"
            request
        }
        val transfer = UsbTestSupport.async { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }
        assertTrue(waiting.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))

        detach()

        assertTrue(UsbTestSupport.failureOf(transfer) is UsbFailure.Detached)
        assertEquals(listOf("detached ${cable.key}", "cancelled"), events.toList())
        UsbTestSupport.eventually("teardown") { connection.closed }
        val request = connection.requests.single()
        assertTrue(request.cancelled)
        assertTrue(request.closed)
        assertEquals(1, io.calls.count { it.name == "release ${hid.id}" })
        assertTrue(io.calls.none { it.onMain })
        val stale = UsbTestSupport.failureOffMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }
        assertTrue(stale is UsbFailure.Detached)
        UsbTestSupport.offMain { backend.close(handle) }
        val dropped = UsbTestSupport.failureOffMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }
        assertTrue(dropped is UsbFailure.NotOpen)
    }

    @Test
    fun workQueuedBehindADetachFailsWithDetachedWithoutIo() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()
        val waiting = blockNextWait(connection, CountDownLatch(1))
        val transfer = UsbTestSupport.async { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }
        assertTrue(waiting.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))
        val queued = UsbTestSupport.async { backend.controlOut(handle, setReport, ByteArray(32), 1000) }
        UsbTestSupport.eventually("queued control transfer") { lanes.single().queue.size == 1 }

        detach()

        assertTrue(UsbTestSupport.failureOf(transfer) is UsbFailure.Detached)
        assertTrue(UsbTestSupport.failureOf(queued) is UsbFailure.Detached)
        assertTrue(connection.controlSetups.isEmpty())
    }

    @Test
    fun detachWhileRequestWaitReportsNoRequestStillFailsWithDetached() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()
        val waiting = CountDownLatch(1)
        connection.waiter = { _ ->
            val request = connection.requests.last()
            waiting.countDown()
            request.cancelLatch.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS)
            // After an unplug the kernel answers ENODEV instead of handing the request back.
            null
        }
        val transfer = UsbTestSupport.async { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }
        assertTrue(waiting.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))

        detach()

        assertTrue(UsbTestSupport.failureOf(transfer) is UsbFailure.Detached)
        UsbTestSupport.eventually("teardown") { connection.closed }
        assertTrue(connection.requests.single().closed)
    }

    @Test
    fun detachDuringAControlTransferFailsWithDetached() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()
        val entered = CountDownLatch(1)
        val proceed = CountDownLatch(1)
        connection.control = { _, _, length, _ ->
            entered.countDown()
            proceed.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS)
            length
        }
        val transfer = UsbTestSupport.async { backend.controlOut(handle, setReport, ByteArray(32), 1000) }
        assertTrue(entered.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))

        detach()
        proceed.countDown()

        assertTrue(UsbTestSupport.failureOf(transfer) is UsbFailure.Detached)
    }

    @Test
    fun closeIsIdempotentAndWorkQueuedBehindItFailsWithNotOpen() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()
        val release = CountDownLatch(1)
        val waiting = blockNextWait(connection, release)
        val transfer = UsbTestSupport.async { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }
        assertTrue(waiting.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))
        val firstClose = UsbTestSupport.async { backend.close(handle) }
        UsbTestSupport.eventually("first close queued") { lanes.single().queue.size == 1 }
        val queued = UsbTestSupport.async { backend.controlOut(handle, setReport, ByteArray(32), 1000) }
        UsbTestSupport.eventually("control queued") { lanes.single().queue.size == 2 }
        val secondClose = UsbTestSupport.async { backend.close(handle) }
        UsbTestSupport.eventually("second close queued") { lanes.single().queue.size == 3 }

        release.countDown()

        assertEquals(32, transfer.get(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))
        firstClose.get(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS)
        secondClose.get(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS)
        assertTrue(UsbTestSupport.failureOf(queued) is UsbFailure.NotOpen)
        assertEquals(1, io.calls.count { it.name == "close" })
        UsbTestSupport.offMain { backend.close(handle) }
        assertEquals(1, io.calls.count { it.name == "close" })
    }

    @Test
    fun blockingCallsOnTheMainThreadThrowBeforeAnyIo() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        io.calls.clear()
        val calls = listOf<() -> Any?>(
            { backend.open(cable) },
            { backend.rawDescriptors(handle) },
            { backend.hidReportDescriptor(handle, hid.id, 64) },
            { backend.transferInterrupt(handle, out, ByteArray(32), 1000) },
            { backend.controlOut(handle, setReport, ByteArray(32), 1000) },
            { backend.claim(handle, hid, true) },
            { backend.release(handle, hid) },
            { backend.close(handle) },
        )

        assertTrue(Looper.getMainLooper().isCurrentThread)
        val failures = calls.map { call -> assertThrows(UsbFailure.MainThread::class.java) { call() } }

        assertEquals(
            listOf("open", "rawDescriptors", "hidReportDescriptor", "transferInterrupt", "controlOut", "claim", "release", "close"),
            failures.map { it.operation },
        )
        assertTrue(io.calls.isEmpty())
    }

    @Test
    fun theLaneAssertsLooperBeforeTouchingTheSeam() {
        val backend = backend(executorFactory = { MainLooperExecutor() })
        val open = UsbTestSupport.async { backend.open(cable) }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(UsbTestSupport.WAIT_SECONDS)
        while (!open.isDone && System.nanoTime() < deadline) {
            UsbTestSupport.idleMain()
            Thread.sleep(2)
        }

        assertTrue(UsbTestSupport.failureOf(open) is UsbFailure.MainThread)
        assertTrue(io.calls.isEmpty())
    }

    @Test
    fun controlOutReturnsTheLengthOrATypedFailure() {
        val now = AtomicLong()
        val backend = backend(clock = { now.get() })
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()

        val sent = UsbTestSupport.offMain { backend.controlOut(handle, setReport, ByteArray(32), 1000) }
        connection.control = { _, _, _, _ -> -71 }
        val failed = UsbTestSupport.failureOffMain { backend.controlOut(handle, setReport, ByteArray(32), 1000) }
        connection.control = { _, _, _, timeoutMs ->
            now.addAndGet(timeoutMs.toLong())
            -1
        }
        val timedOut = UsbTestSupport.failureOffMain { backend.controlOut(handle, setReport, ByteArray(32), 1000) }

        val setup = connection.controlSetups.first()
        assertEquals(32, sent)
        assertEquals(listOf(0x21, 0x09, 0x02CB, 2), listOf(setup.requestType, setup.request, setup.value, setup.index))
        assertEquals(32, connection.controlLengths.first())
        assertEquals(-71, (failed as UsbFailure.TransferFailed).code)
        assertEquals(1000, (timedOut as UsbFailure.Timeout).timeoutMs)
        assertTrue(io.calls.none { it.onMain })
    }

    @Test
    fun hidReportDescriptorUsesGetDescriptorOnTheHidInterface() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()
        val expected = FakeUsbBackend.DEFAULT_REPORT_DESCRIPTOR
        connection.control = { _, buffer, _, _ ->
            expected.copyInto(buffer)
            expected.size
        }

        val descriptor = UsbTestSupport.offMain { backend.hidReportDescriptor(handle, hid.id, 256) }

        val setup = connection.controlSetups.single()
        assertArrayEquals(expected, descriptor)
        assertEquals(listOf(0x81, 0x06, 0x2200, hid.id), listOf(setup.requestType, setup.request, setup.value, setup.index))
        assertEquals(256, connection.controlLengths.single())
        for (length in listOf(0, 0x10000)) {
            val failure = UsbTestSupport.failureOffMain { backend.hidReportDescriptor(handle, hid.id, length) }
            assertTrue(failure is UsbFailure.BadArgs)
        }
        assertTrue(UsbTestSupport.failureOffMain { backend.hidReportDescriptor(handle, -1, 64) } is UsbFailure.BadArgs)
    }

    @Test
    fun rawDescriptorsAreReturnedAndNullIsATransferFailure() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()

        val raw = UsbTestSupport.offMain { backend.rawDescriptors(handle) }
        connection.rawDescriptors = null
        val failure = UsbTestSupport.failureOffMain { backend.rawDescriptors(handle) }

        assertArrayEquals(FakeUsbBackend.DEFAULT_RAW_DESCRIPTORS, raw)
        assertTrue(failure is UsbFailure.TransferFailed)
    }

    @Test
    fun invalidArgumentsFailWithBadArgsBeforeIo() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        io.calls.clear()
        val iso = cable.interfaces[1].endpoints.single()
        val foreignEndpoint = UsbEndpointInfo(0x05, 0x03, 64, 1)
        val foreignInterface = iface(9, UsbBackend.CLASS_HID)
        val badCalls = listOf<() -> Any?>(
            { backend.transferInterrupt(handle, iso, ByteArray(32), 1000) },
            { backend.transferInterrupt(handle, foreignEndpoint, ByteArray(32), 1000) },
            { backend.transferInterrupt(handle, out, ByteArray(32), 0) },
            { backend.controlOut(handle, ControlSetup(0xA1, 0x01, 0x01CB, 2), ByteArray(32), 1000) },
            { backend.controlOut(handle, setReport, ByteArray(32), -5) },
            { backend.claim(handle, foreignInterface, true) },
            { backend.release(handle, foreignInterface) },
        )

        badCalls.forEach { call -> assertTrue(UsbTestSupport.failureOffMain(call) is UsbFailure.BadArgs) }

        assertTrue(io.calls.isEmpty())
        assertThrows(UsbFailure.BadArgs::class.java) { ControlSetup(-1, 0, 0, 0) }
        assertThrows(UsbFailure.BadArgs::class.java) { ControlSetup(0, 0x100, 0, 0) }
        assertThrows(UsbFailure.BadArgs::class.java) { ControlSetup(0, 0, 0x10000, 0) }
        assertThrows(UsbFailure.BadArgs::class.java) { ControlSetup(0, 0, 0, 0x10000) }
    }

    @Test
    fun openFailsWithPermissionDeniedOrOpenFailed() {
        val backend = backend()

        io.granted.clear()
        val denied = UsbTestSupport.failureOffMain { backend.open(cable) }
        io.granted += cable.key
        io.openFails = true
        val failed = UsbTestSupport.failureOffMain { backend.open(cable) }

        assertEquals(cable.key, (denied as UsbFailure.PermissionDenied).deviceKey)
        assertEquals(cable.key, (failed as UsbFailure.OpenFailed).deviceKey)
    }

    @Test
    fun claimAndReleaseGoToTheConnectionAndOnlySuccessfulClaimsAreTracked() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()

        assertTrue(UsbTestSupport.offMain { backend.claim(handle, hid, false) })
        assertTrue(UsbTestSupport.offMain { backend.release(handle, hid) })
        connection.claimResult = { _, _ -> false }
        assertFalse(UsbTestSupport.offMain { backend.claim(handle, hid, true) })
        UsbTestSupport.offMain { backend.close(handle) }

        assertEquals(
            listOf("open", "claim 2 force=false", "release 2", "claim 2 force=true", "close"),
            io.calls.map { it.name },
        )
        assertTrue(UsbTestSupport.failureOffMain { backend.rawDescriptors(handle) } is UsbFailure.NotOpen)
    }

    @Test
    fun aShutDownLaneFailsWithClosed() {
        val backend = backend(executorFactory = { Executors.newSingleThreadExecutor().apply { shutdown() } })

        val failure = UsbTestSupport.failureOffMain { backend.open(cable) }

        assertTrue(failure is UsbFailure.Closed)
        assertTrue(failure.cause is java.util.concurrent.RejectedExecutionException)
    }

    @Test
    fun anInterruptedCallerGetsInterruptedAndKeepsItsInterruptFlag() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val release = CountDownLatch(1)
        val waiting = blockNextWait(io.connections.single(), release)
        val transfer = UsbTestSupport.async { backend.transferInterrupt(handle, out, ByteArray(32), 1000) }
        assertTrue(waiting.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))
        var observed: UsbFailure? = null
        var flagKept = false
        val caller = Thread {
            try {
                backend.controlOut(handle, setReport, ByteArray(32), 1000)
            } catch (failure: UsbFailure) {
                observed = failure
                flagKept = Thread.currentThread().isInterrupted
            }
        }
        caller.start()
        UsbTestSupport.eventually("caller queued") { lanes.single().queue.size == 1 }

        caller.interrupt()
        caller.join(TimeUnit.SECONDS.toMillis(UsbTestSupport.WAIT_SECONDS))
        release.countDown()

        assertEquals("controlOut", (observed as UsbFailure.Interrupted).operation)
        assertTrue(flagKept)
        assertEquals(32, transfer.get(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))
    }

    @Test
    fun disposeClosesConnectionsAndFailsLaterCalls() {
        val backend = backend()
        val handle = UsbTestSupport.offMain { backend.open(cable) }
        val connection = io.connections.single()
        var result: Result<Boolean>? = null

        backend.dispose()
        backend.requestPermission(cable) { result = it }

        UsbTestSupport.eventually("connection closed") { connection.closed }
        assertTrue(result?.exceptionOrNull() is UsbFailure.Closed)
        assertTrue(UsbTestSupport.failureOffMain { backend.transferInterrupt(handle, out, ByteArray(32), 1000) } is UsbFailure.NotOpen)
        assertTrue(UsbTestSupport.failureOffMain { backend.open(cable) } is UsbFailure.Closed)
    }

    @Test
    fun frameworkIoReadsDevicesAndPermissionsFromTheShadowUsbManager() {
        val manager = app.getSystemService(UsbManager::class.java)
        val device = FrameworkUsb.cable("/dev/bus/usb/002/007")
        shadowOf(manager).addOrUpdateUsbDevice(device, true)
        val frameworkIo = FrameworkUsbIo(manager)
        val permission = PendingIntent.getBroadcast(
            app,
            0,
            Intent("test.usb.PERMISSION").setPackage(app.packageName),
            PendingIntent.FLAG_IMMUTABLE,
        )

        val info = frameworkIo.devices().single()
        val hidInfo = UsbBackend.selectHidInterface(info)

        assertEquals("/dev/bus/usb/002/007", info.key)
        assertEquals(FakeUsbBackend.VENDOR_ID, info.vendorId)
        assertEquals(FakeUsbBackend.PRODUCT_ID, info.productId)
        assertEquals(FakeUsbBackend.PRODUCT_NAME, info.productName)
        assertEquals("OpenAuri", info.manufacturerName)
        assertEquals(listOf(1, 1, 3), info.interfaces.map { it.interfaceClass })
        assertEquals(FakeUsbBackend.HID_INTERFACE_ID, hidInfo?.id)
        assertEquals(listOf(0x83, FakeUsbBackend.INTERRUPT_OUT_ADDRESS), hidInfo?.endpoints?.map { it.address })
        assertEquals(FakeUsbBackend.INTERRUPT_OUT_ADDRESS, hidInfo?.interruptOut?.address)
        assertTrue(frameworkIo.hasPermission(info.key))
        assertFalse(frameworkIo.hasPermission("/dev/bus/usb/009/009"))
        frameworkIo.requestPermission(info.key, permission)
        assertThrows(UsbFailure.NotFound::class.java) { frameworkIo.requestPermission("/dev/bus/usb/009/009", permission) }
        assertTrue(UsbTestSupport.offMain { frameworkIo.open(info.key) } is FrameworkConnection)
        assertTrue(UsbTestSupport.failureOffMain { frameworkIo.open("/dev/bus/usb/009/009") } is UsbFailure.NotFound)
        val detached = Intent(UsbManager.ACTION_USB_DEVICE_DETACHED).putExtra(UsbManager.EXTRA_DEVICE, device)
        assertEquals(info.key, frameworkIo.deviceFrom(detached)?.key)
        assertNull(frameworkIo.deviceFrom(Intent(UsbManager.ACTION_USB_DEVICE_DETACHED)))
        shadowOf(manager).addOrUpdateUsbDevice(device, false)
        assertFalse(frameworkIo.hasPermission(info.key))
    }

    @Test
    fun frameworkSerialIsReadOnlyWithPermissionAndOnlySecurityExceptionsFallBackToNull() {
        val manager = app.getSystemService(UsbManager::class.java)
        var reads = 0
        var serial: () -> String? = { "cable-serial" }
        val device = FrameworkUsb.device("/dev/bus/usb/002/012", 0x3302, 0x8902, serial = {
            reads++
            serial()
        })
        val usbIo = FrameworkUsbIo(manager)
        shadowOf(manager).addOrUpdateUsbDevice(device, false)
        assertNull(usbIo.devices().single().serialNumber)
        assertEquals(0, reads)
        shadowOf(manager).addOrUpdateUsbDevice(device, true)
        assertEquals("cable-serial", usbIo.devices().single().serialNumber)
        serial = { throw SecurityException("revoked during serial read") }
        assertNull(usbIo.devices().single().serialNumber)
        serial = { throw IllegalStateException("not a permission failure") }
        assertThrows(IllegalStateException::class.java) { usbIo.devices() }
        assertEquals(3, reads)
    }

    @Test
    fun createUsesUsbManagerOnlyWithTheUsbHostFeature() {
        val manager = app.getSystemService(UsbManager::class.java)
        val device = FrameworkUsb.cable("/dev/bus/usb/002/009")
        shadowOf(manager).addOrUpdateUsbDevice(device, true)
        val withoutHost = AndroidUsbBackend.create(app).also { backends += it }
        shadowOf(app.packageManager).setSystemFeature(PackageManager.FEATURE_USB_HOST, true)
        val backend = AndroidUsbBackend.create(app).also { backends += it }
        val events = CopyOnWriteArrayList<String>()
        backend.addListener(UsbTestSupport.recordingListener(events))
        var permission: Result<Boolean>? = null

        val info = backend.list(emptyList()).single()
        val hidInfo = backend.findHidInterface(info) ?: throw AssertionError("HID interface")
        backend.requestPermission(info) { permission = it }
        val handle = UsbTestSupport.offMain { backend.open(info) }
        // End to end through FrameworkConnection and Robolectric's USB shadows.
        assertTrue(UsbTestSupport.offMain { backend.claim(handle, hidInfo, true) })
        assertEquals(32, UsbTestSupport.offMain { backend.controlOut(handle, setReport, ByteArray(32), 1000) })
        assertEquals(256, UsbTestSupport.offMain { backend.hidReportDescriptor(handle, hidInfo.id, 256) }.size)
        assertTrue(UsbTestSupport.failureOffMain { backend.rawDescriptors(handle) } is UsbFailure.TransferFailed)
        assertTrue(UsbTestSupport.offMain { backend.release(handle, hidInfo) })
        UsbTestSupport.offMain { backend.close(handle) }
        app.sendBroadcast(Intent(UsbManager.ACTION_USB_DEVICE_ATTACHED).putExtra(UsbManager.EXTRA_DEVICE, device))
        app.sendBroadcast(Intent(UsbManager.ACTION_USB_DEVICE_DETACHED).putExtra(UsbManager.EXTRA_DEVICE, device))
        UsbTestSupport.idleMain()

        assertFalse(withoutHost.hasHost)
        assertTrue(backend.hasHost)
        assertTrue(backend.hasPermission(info))
        assertEquals(true, permission?.getOrNull())
        assertEquals(FakeUsbBackend.HID_INTERFACE_ID, backend.findHidInterface(info)?.id)
        assertEquals(info.key, handle.device.key)
        assertEquals(listOf("attached ${info.key}", "detached ${info.key}"), events.toList())
    }

    @Test
    fun frameworkConnectionDelegatesToUsbDeviceConnection() {
        val device = FrameworkUsb.cable("/dev/bus/usb/002/010")
        val connection = FrameworkConnection(device, FrameworkUsb.connection(device))
        val wrongAlternate = UsbInterfaceInfo(hid.id, 1, UsbBackend.CLASS_HID, 0, 0, emptyList())
        val missing = UsbInterfaceInfo(7, 0, UsbBackend.CLASS_HID, 0, 0, emptyList())

        // Robolectric's ShadowUsbDeviceConnection and ShadowUsbRequest stand in for usbfs.
        UsbTestSupport.offMain {
            assertNull(connection.rawDescriptors())
            assertEquals(8, connection.controlTransfer(ControlSetup.hidReportDescriptor(hid.id), ByteArray(8), 8, 100))
            assertTrue(connection.claimInterface(hid, true))
            val request = connection.openRequest(out)
            assertTrue(request is FrameworkRequest)
            assertSame(request, connection.requestWait(10))
            assertFalse(request?.cancel() ?: true)
            request?.close()
            assertTrue(connection.releaseInterface(hid))
            connection.close()
        }

        assertThrows(UsbFailure.NotFound::class.java) { connection.claimInterface(wrongAlternate, false) }
        assertThrows(UsbFailure.NotFound::class.java) { connection.releaseInterface(missing) }
        assertThrows(UsbFailure.NotFound::class.java) { connection.openRequest(UsbEndpointInfo(0x09, 0x03, 8, 1)) }
    }

    @Test
    fun frameworkRequestQueuesThroughUsbRequestAndMapsBackFromRequestWait() {
        val device = FrameworkUsb.cable("/dev/bus/usb/002/011")
        val usbConnection = FrameworkUsb.connection(device)
        val connection = FrameworkConnection(device, usbConnection)
        val interruptIn = hid.endpoints.single { it.isIn }
        val buffer = ByteBuffer.allocate(8)

        val queued = UsbTestSupport.offMain {
            val request = connection.openRequest(interruptIn) ?: throw AssertionError("initialize failed")
            // The shadow serves queue() from its inbound pipe, so feed it before queueing.
            shadowOf(usbConnection).writeIncomingData(ByteArray(8) { (it + 1).toByte() })
            request.queue(buffer) to request
        }

        assertTrue(queued.first)
        assertSame(queued.second, UsbTestSupport.offMain { connection.requestWait(10) })
        val fresh = UsbRequest()
        val wrapper = FrameworkRequest(fresh)
        assertSame(wrapper, fresh.clientData)
        queued.second.close()
    }
}
