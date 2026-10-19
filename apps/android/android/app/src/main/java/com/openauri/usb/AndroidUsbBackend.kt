package com.openauri.usb

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import java.nio.ByteBuffer
import java.util.concurrent.Callable
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong

/**
 * [UsbBackend] on top of [UsbManager].
 *
 * - Interrupt transfers use `UsbRequest.initialize` + `queue(ByteBuffer)` +
 *   `UsbDeviceConnection.requestWait(timeout)` (API 26+). On timeout the request is cancelled,
 *   reaped and closed; a request the kernel never hands back is closed after the connection.
 * - Control transfers use `controlTransfer` with a timeout.
 * - All I/O of one device runs on that device's single-thread lane; the calling thread waits.
 *   Blocking calls on the main thread throw [UsbFailure.MainThread] before any I/O, and the lane
 *   asserts again with [Looper] right before touching the framework.
 * - A dynamic receiver tracks `ACTION_USB_DEVICE_ATTACHED` and `ACTION_USB_DEVICE_DETACHED`. A
 *   detach emits [UsbDeviceListener.onDetached] first, then cancels the pending transfer (so the
 *   caller sees [UsbFailure.Detached] after the event), releases claims and closes the connection.
 *
 * Framework calls go through the internal [UsbIo] seam so tests can replace them.
 */
class AndroidUsbBackend internal constructor(
    private val context: Context,
    private val io: UsbIo?,
    private val executorFactory: (deviceKey: String) -> ExecutorService,
    private val cancelExecutor: ExecutorService,
    private val isMainThread: () -> Boolean,
    private val clock: () -> Long,
) : UsbBackend {

    private val lock = Any()
    private val lanes = HashMap<String, Lane>()
    private val connections = HashMap<Long, Connection>()
    private val handleIds = AtomicLong()
    private val listeners = CopyOnWriteArrayList<UsbDeviceListener>()
    private val broker = PermissionBroker(context) { key, intent -> requireIo().requestPermission(key, intent) }
    private val deviceReceiver = io?.let { DeviceReceiver(it) }

    @Volatile private var disposed = false

    init {
        deviceReceiver?.let { receiver ->
            val filter = IntentFilter().apply {
                addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
                addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            }
            // Both actions are system broadcasts sent by system_server, a different UID, so the
            // receiver is registered exported: that states the sender is outside the app and works
            // on every API level (below 33 ContextCompat emulates NOT_EXPORTED with a signature
            // permission the sender must hold). It opens nothing to other apps because both
            // actions are protected broadcasts that only the system may send.
            ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
        }
    }

    override val hasHost: Boolean
        get() = io != null

    override fun list(filters: List<UsbFilter>): List<UsbDeviceInfo> =
        requireIo().devices().filter { device -> filters.isEmpty() || filters.any { it.matches(device) } }

    override fun hasPermission(device: UsbDeviceInfo): Boolean = requireIo().hasPermission(device.key)

    override fun requestPermission(device: UsbDeviceInfo, callback: PermissionCallback) {
        val host = try {
            requireIo()
        } catch (failure: UsbFailure) {
            callback(Result.failure(failure))
            return
        }
        if (host.hasPermission(device.key)) callback(Result.success(true)) else broker.request(device.key, callback)
    }

    override fun open(device: UsbDeviceInfo): UsbConnectionHandle {
        checkNotMain("open")
        val host = requireIo()
        val lane = synchronized(lock) {
            lanes.getOrPut(device.key) { Lane(device.key, executorFactory(device.key)) }
        }
        return lane.run("open") { lane.connection?.handle ?: connect(host, lane, device) }
    }

    override fun rawDescriptors(connection: UsbConnectionHandle): ByteArray {
        checkNotMain("rawDescriptors")
        val conn = connectionFor(connection)
        return conn.run("rawDescriptors") {
            conn.io.rawDescriptors()
                ?: throw UsbFailure.TransferFailed(conn.key, TRANSFER_ERROR, "getRawDescriptors returned null")
        }
    }

    override fun hidReportDescriptor(connection: UsbConnectionHandle, interfaceId: Int, length: Int): ByteArray {
        checkNotMain("hidReportDescriptor")
        if (length !in 1..MAX_CONTROL_LENGTH) throw UsbFailure.BadArgs("descriptor length $length")
        val setup = ControlSetup.hidReportDescriptor(interfaceId)
        val conn = connectionFor(connection)
        return conn.run("hidReportDescriptor") {
            val descriptor = ByteArray(length)
            descriptor.copyOf(control(conn, setup, descriptor, UsbBackend.DEFAULT_TIMEOUT_MS))
        }
    }

    override fun transferInterrupt(
        connection: UsbConnectionHandle,
        endpoint: UsbEndpointInfo,
        buffer: ByteArray,
        timeoutMs: Int,
    ): Int {
        checkNotMain("transferInterrupt")
        if (!endpoint.isInterrupt) throw UsbFailure.BadArgs("endpoint ${hex(endpoint.address)} is not interrupt")
        checkTimeout(timeoutMs)
        val conn = connectionFor(connection)
        val owned = conn.handle.device.interfaces.any { usbInterface ->
            usbInterface.endpoints.any { it.address == endpoint.address }
        }
        if (!owned) throw UsbFailure.BadArgs("endpoint ${hex(endpoint.address)} is not on ${conn.key}")
        return conn.run("transferInterrupt") { interrupt(conn, endpoint, buffer, timeoutMs) }
    }

    override fun controlOut(
        connection: UsbConnectionHandle,
        setup: ControlSetup,
        buffer: ByteArray,
        timeoutMs: Int,
    ): Int {
        checkNotMain("controlOut")
        if ((setup.requestType and UsbEndpointInfo.DIRECTION_MASK) != 0) {
            throw UsbFailure.BadArgs("request type ${hex(setup.requestType)} is not host-to-device")
        }
        checkTimeout(timeoutMs)
        val conn = connectionFor(connection)
        return conn.run("controlOut") { control(conn, setup, buffer, timeoutMs) }
    }

    override fun claim(connection: UsbConnectionHandle, usbInterface: UsbInterfaceInfo, force: Boolean): Boolean {
        checkNotMain("claim")
        val conn = connectionFor(connection)
        checkInterface(conn, usbInterface)
        return conn.run("claim") {
            conn.io.claimInterface(usbInterface, force).also { claimed ->
                if (claimed) conn.claimed += usbInterface
            }
        }
    }

    override fun release(connection: UsbConnectionHandle, usbInterface: UsbInterfaceInfo): Boolean {
        checkNotMain("release")
        val conn = connectionFor(connection)
        checkInterface(conn, usbInterface)
        return conn.run("release") {
            conn.claimed -= usbInterface
            conn.io.releaseInterface(usbInterface)
        }
    }

    override fun close(connection: UsbConnectionHandle) {
        checkNotMain("close")
        val conn = synchronized(lock) { connections[connection.id] } ?: return
        if (conn.lane.detached) {
            // The detach path tears the connection down; only the stale handle is left to drop.
            synchronized(lock) { connections.remove(connection.id) }
            return
        }
        conn.lane.run("close") {
            if (!conn.closed) {
                conn.teardown()
                conn.lane.connection = null
            }
            synchronized(lock) { connections.remove(connection.id) }
        }
    }

    override fun addListener(listener: UsbDeviceListener) {
        listeners += listener
    }

    override fun removeListener(listener: UsbDeviceListener) {
        listeners -= listener
    }

    override fun dispose() {
        val toShutDown = synchronized(lock) {
            if (disposed) return
            disposed = true
            connections.clear()
            lanes.values.toList().also { lanes.clear() }
        }
        deviceReceiver?.let { context.unregisterReceiver(it) }
        broker.dispose()
        listeners.clear()
        toShutDown.forEach { it.shutdown() }
        cancelExecutor.shutdown()
    }

    private fun connect(host: UsbIo, lane: Lane, device: UsbDeviceInfo): UsbConnectionHandle {
        val ioConnection = host.open(device.key) ?: throw if (host.hasPermission(device.key)) {
            UsbFailure.OpenFailed(device.key)
        } else {
            UsbFailure.PermissionDenied(device.key)
        }
        val conn = Connection(UsbConnectionHandle(device, handleIds.incrementAndGet()), ioConnection, lane)
        lane.connection = conn
        synchronized(lock) { connections[conn.handle.id] = conn }
        return conn.handle
    }

    /** Runs on the lane thread. */
    private fun interrupt(conn: Connection, endpoint: UsbEndpointInfo, buffer: ByteArray, timeoutMs: Int): Int {
        val request = conn.io.openRequest(endpoint)
            ?: throw UsbFailure.TransferFailed(conn.key, TRANSFER_ERROR, "UsbRequest.initialize failed")
        val data = ByteBuffer.wrap(buffer)
        if (!request.queue(data)) {
            request.close()
            throw UsbFailure.TransferFailed(conn.key, TRANSFER_ERROR, "UsbRequest.queue failed")
        }
        conn.lane.pending = request
        val completed = try {
            conn.io.requestWait(timeoutMs.toLong())
        } catch (timeout: TimeoutException) {
            throw conn.abandon(request, UsbFailure.Timeout(conn.key, timeoutMs, timeout))
        } finally {
            conn.lane.pending = null
        }
        if (completed !== request) {
            val failure = if (conn.lane.detached) {
                UsbFailure.Detached(conn.key)
            } else {
                UsbFailure.TransferFailed(conn.key, TRANSFER_ERROR, "requestWait did not return the queued request")
            }
            throw conn.abandon(request, failure)
        }
        request.close()
        if (conn.lane.detached) throw UsbFailure.Detached(conn.key)
        return data.position()
    }

    /** Runs on the lane thread. Android reports a control timeout as -1, so elapsed time tells it apart. */
    private fun control(conn: Connection, setup: ControlSetup, buffer: ByteArray, timeoutMs: Int): Int {
        val started = clock()
        val result = conn.io.controlTransfer(setup, buffer, buffer.size, timeoutMs)
        return when {
            conn.lane.detached -> throw UsbFailure.Detached(conn.key)
            result >= 0 -> result
            clock() - started >= timeoutMs -> throw UsbFailure.Timeout(conn.key, timeoutMs, null)
            else -> throw UsbFailure.TransferFailed(conn.key, result, "controlTransfer failed")
        }
    }

    private fun onAttached(device: UsbDeviceInfo) {
        listeners.forEach { it.onAttached(device) }
    }

    /** Main thread: no I/O here, the cancel and the teardown run on background threads. */
    private fun onDetached(device: UsbDeviceInfo) {
        val lane = synchronized(lock) { lanes.remove(device.key) }
        lane?.detached = true
        listeners.forEach { it.onDetached(device) }
        if (lane != null) {
            cancelExecutor.execute { lane.pending?.cancel() }
            lane.shutdown()
        }
    }

    private fun requireIo(): UsbIo {
        if (disposed) throw UsbFailure.Closed("USB backend disposed", null)
        return io ?: throw UsbFailure.NoHost()
    }

    private fun connectionFor(handle: UsbConnectionHandle): Connection {
        val conn = synchronized(lock) { connections[handle.id] } ?: throw UsbFailure.NotOpen(handle.device.key)
        if (conn.lane.detached) throw UsbFailure.Detached(handle.device.key)
        return conn
    }

    private fun checkInterface(conn: Connection, usbInterface: UsbInterfaceInfo) {
        if (conn.handle.device.interfaces.none { it.id == usbInterface.id }) {
            throw UsbFailure.BadArgs("interface ${usbInterface.id} is not on ${conn.key}")
        }
    }

    private fun checkNotMain(operation: String) {
        if (isMainThread()) throw UsbFailure.MainThread(operation)
    }

    private fun checkTimeout(timeoutMs: Int) {
        if (timeoutMs <= 0) throw UsbFailure.BadArgs("timeout $timeoutMs ms must be positive")
    }

    private fun hex(value: Int) = "0x%02x".format(value)

    /** Single-thread I/O lane of one device. */
    private inner class Lane(val key: String, val executor: ExecutorService) {
        @Volatile var detached = false

        /** The interrupt request waiting in `requestWait`, for the detach path to cancel. */
        @Volatile var pending: UsbIoRequest? = null

        /** Lane thread only. */
        var connection: Connection? = null

        /** Runs [block] on the lane and waits for it; failures are rethrown on the caller. */
        fun <T> run(operation: String, block: () -> T): T {
            val task = Callable {
                runCatching {
                    checkNotMain(operation)
                    if (detached) throw UsbFailure.Detached(key)
                    block()
                }
            }
            val future = try {
                executor.submit(task)
            } catch (rejected: RejectedExecutionException) {
                // A lane that refuses work is dead: drop it so the next open starts a fresh one.
                synchronized(lock) { lanes.remove(key, this) }
                throw UsbFailure.Closed("USB I/O lane of $key is shut down", rejected)
            }
            val result = try {
                future.get()
            } catch (interrupted: InterruptedException) {
                Thread.currentThread().interrupt()
                throw UsbFailure.Interrupted(operation, interrupted)
            }
            return result.getOrThrow()
        }

        /** Tears the open connection down after the queued work, then stops the lane. */
        fun shutdown() {
            executor.execute {
                connection?.teardown()
                connection = null
            }
            executor.shutdown()
        }
    }

    /** An open connection; its mutable state is only touched on the lane thread. */
    private inner class Connection(val handle: UsbConnectionHandle, val io: UsbIoConnection, val lane: Lane) {
        val key: String
            get() = handle.device.key
        val claimed = LinkedHashSet<UsbInterfaceInfo>()
        private val orphans = ArrayList<UsbIoRequest>()

        @Volatile var closed = false
            private set

        fun <T> run(operation: String, block: () -> T): T = lane.run(operation) {
            if (closed) throw UsbFailure.NotOpen(key)
            block()
        }

        /**
         * Cancels [request] and reaps it, so that a later `requestWait` never returns a request
         * whose native memory was freed. If the kernel does not hand it back in time it is closed
         * only after the connection.
         */
        fun abandon(request: UsbIoRequest, failure: UsbFailure): UsbFailure {
            request.cancel()
            val reaped = try {
                io.requestWait(REAP_TIMEOUT_MS)
            } catch (timeout: TimeoutException) {
                failure.addSuppressed(timeout)
                null
            }
            if (reaped === request) request.close() else orphans += request
            return failure
        }

        /** Releases the claimed interfaces (never a reset or setConfiguration) and closes. */
        fun teardown() {
            try {
                claimed.forEach { io.releaseInterface(it) }
            } finally {
                claimed.clear()
                closed = true
                io.close()
                orphans.forEach { it.close() }
                orphans.clear()
            }
        }
    }

    private inner class DeviceReceiver(private val host: UsbIo) : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val device = host.deviceFrom(intent) ?: return
            if (intent.action == UsbManager.ACTION_USB_DEVICE_DETACHED) onDetached(device) else onAttached(device)
        }
    }

    companion object {
        /** How long to wait for the kernel to hand back a cancelled request. */
        const val REAP_TIMEOUT_MS: Long = 50

        private const val TRANSFER_ERROR = -1
        private const val MAX_CONTROL_LENGTH = 0xFFFF
        private const val LANE_IDLE_SECONDS = 30L

        /** Production main-thread check. */
        internal val mainThreadCheck: () -> Boolean = { Looper.getMainLooper().isCurrentThread }

        /** Production monotonic clock, in ms. */
        internal val monotonicClock: () -> Long = { SystemClock.elapsedRealtime() }

        /**
         * Backend for [context]'s application. Without the `android.hardware.usb.host` feature
         * [UsbBackend.hasHost] is false and every call fails with [UsbFailure.NoHost].
         */
        fun create(context: Context): AndroidUsbBackend {
            val app = context.applicationContext
            val io = app.getSystemService(UsbManager::class.java)
                ?.takeIf { app.packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST) }
                ?.let { FrameworkUsbIo(it) }
            return AndroidUsbBackend(
                context = app,
                io = io,
                executorFactory = { key -> newLaneExecutor("openauri-usb-io $key") },
                cancelExecutor = newLaneExecutor("openauri-usb-cancel"),
                isMainThread = mainThreadCheck,
                clock = monotonicClock,
            )
        }

        /** Single daemon thread that exits when idle; the lane stays FIFO. */
        internal fun newLaneExecutor(name: String): ExecutorService =
            ThreadPoolExecutor(1, 1, LANE_IDLE_SECONDS, TimeUnit.SECONDS, LinkedBlockingQueue()) { task ->
                Thread(task, name).apply { isDaemon = true }
            }.apply { allowCoreThreadTimeOut(true) }
    }
}

/**
 * Seam over the framework USB classes; [FrameworkUsbIo] is the production implementation.
 * [devices], [hasPermission], [requestPermission] and [deviceFrom] do no USB I/O; [open] and
 * everything on [UsbIoConnection] and [UsbIoRequest] do, and only run on a lane thread.
 */
internal interface UsbIo {
    fun devices(): List<UsbDeviceInfo>
    fun hasPermission(deviceKey: String): Boolean
    fun requestPermission(deviceKey: String, intent: PendingIntent)
    fun open(deviceKey: String): UsbIoConnection?
    fun deviceFrom(intent: Intent): UsbDeviceInfo?
}

/** Seam over [UsbDeviceConnection]. */
internal interface UsbIoConnection {
    fun rawDescriptors(): ByteArray?
    fun controlTransfer(setup: ControlSetup, buffer: ByteArray, length: Int, timeoutMs: Int): Int
    fun claimInterface(usbInterface: UsbInterfaceInfo, force: Boolean): Boolean
    fun releaseInterface(usbInterface: UsbInterfaceInfo): Boolean

    /** A new request initialised for [endpoint], or null when initialisation failed. */
    fun openRequest(endpoint: UsbEndpointInfo): UsbIoRequest?

    /** The next completed request, or null on error. */
    @Throws(TimeoutException::class)
    fun requestWait(timeoutMs: Long): UsbIoRequest?
    fun close()
}

/** Seam over [UsbRequest]. */
internal interface UsbIoRequest {
    fun queue(buffer: ByteBuffer): Boolean
    fun cancel(): Boolean
    fun close()
}

/** [UsbIo] backed by [UsbManager]. */
internal class FrameworkUsbIo(private val manager: UsbManager) : UsbIo {
    override fun devices(): List<UsbDeviceInfo> = manager.deviceList.values.map { it.toInfo() }.sortedBy { it.key }

    override fun hasPermission(deviceKey: String): Boolean =
        manager.deviceList[deviceKey]?.let { manager.hasPermission(it) } ?: false

    override fun requestPermission(deviceKey: String, intent: PendingIntent) {
        manager.requestPermission(device(deviceKey), intent)
    }

    override fun open(deviceKey: String): UsbIoConnection? {
        val device = device(deviceKey)
        return manager.openDevice(device)?.let { FrameworkConnection(device, it) }
    }

    override fun deviceFrom(intent: Intent): UsbDeviceInfo? =
        IntentCompat.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice::class.java)?.toInfo()

    private fun device(deviceKey: String): UsbDevice =
        manager.deviceList[deviceKey] ?: throw UsbFailure.NotFound(deviceKey)
}

/** [UsbIoConnection] backed by [UsbDeviceConnection]. */
internal class FrameworkConnection(
    private val device: UsbDevice,
    private val connection: UsbDeviceConnection,
) : UsbIoConnection {
    override fun rawDescriptors(): ByteArray? = connection.rawDescriptors

    override fun controlTransfer(setup: ControlSetup, buffer: ByteArray, length: Int, timeoutMs: Int): Int =
        connection.controlTransfer(setup.requestType, setup.request, setup.value, setup.index, buffer, length, timeoutMs)

    override fun claimInterface(usbInterface: UsbInterfaceInfo, force: Boolean): Boolean =
        connection.claimInterface(find(usbInterface), force)

    override fun releaseInterface(usbInterface: UsbInterfaceInfo): Boolean =
        connection.releaseInterface(find(usbInterface))

    override fun openRequest(endpoint: UsbEndpointInfo): UsbIoRequest? {
        val request = UsbRequest()
        if (request.initialize(connection, find(endpoint))) return FrameworkRequest(request)
        request.close()
        return null
    }

    override fun requestWait(timeoutMs: Long): UsbIoRequest? =
        connection.requestWait(timeoutMs)?.clientData as? UsbIoRequest

    override fun close() {
        connection.close()
    }

    private fun find(info: UsbInterfaceInfo): UsbInterface =
        device.interfaces().firstOrNull { it.id == info.id && it.alternateSetting == info.alternateSetting }
            ?: throw UsbFailure.NotFound("${device.deviceName} interface ${info.id}")

    private fun find(info: UsbEndpointInfo): UsbEndpoint =
        device.interfaces().flatMap { it.endpoints() }.firstOrNull { it.address == info.address }
            ?: throw UsbFailure.NotFound("${device.deviceName} endpoint ${info.address}")
}

/** [UsbIoRequest] backed by [UsbRequest]; registers itself as client data so requestWait maps back. */
internal class FrameworkRequest(private val request: UsbRequest) : UsbIoRequest {
    init {
        request.clientData = this
    }

    override fun queue(buffer: ByteBuffer): Boolean = request.queue(buffer)

    override fun cancel(): Boolean = request.cancel()

    override fun close() {
        request.close()
    }
}

private fun UsbDevice.interfaces(): List<UsbInterface> = (0 until interfaceCount).map { getInterface(it) }

private fun UsbInterface.endpoints(): List<UsbEndpoint> = (0 until endpointCount).map { getEndpoint(it) }

private fun UsbDevice.toInfo(): UsbDeviceInfo = UsbDeviceInfo(
    key = deviceName,
    vendorId = vendorId,
    productId = productId,
    productName = productName,
    manufacturerName = manufacturerName,
    interfaces = interfaces().map { it.toInfo() },
)

private fun UsbInterface.toInfo(): UsbInterfaceInfo = UsbInterfaceInfo(
    id = id,
    alternateSetting = alternateSetting,
    interfaceClass = interfaceClass,
    interfaceSubclass = interfaceSubclass,
    interfaceProtocol = interfaceProtocol,
    endpoints = endpoints().map { UsbEndpointInfo(it.address, it.attributes, it.maxPacketSize, it.interval) },
)
