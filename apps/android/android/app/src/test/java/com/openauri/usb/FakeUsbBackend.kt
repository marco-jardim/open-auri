package com.openauri.usb

import java.util.concurrent.CopyOnWriteArrayList

/**
 * In-memory [UsbBackend] for unit tests, including the plugin's byte-for-byte tests.
 *
 * Faults mirror `src/transport/fake-device.mjs:31-38` (`disconnectAtReport`, `throwAtReport` and
 * `throwError`, `hangAtReport` as a timeout, `openError`) plus the USB host ones: permission
 * denied, claim EBUSY, a bound kernel driver and a custom HID report descriptor. Report indexes
 * are 0-based send attempts across both routes ([transferInterrupt] and [controlOut]); a faulted
 * attempt is not delivered. Every delivered report is recorded byte for byte in [sent].
 *
 * @param isMainThread lets a test reproduce the main-thread rule of [AndroidUsbBackend]
 *   (for example `{ Looper.getMainLooper().isCurrentThread }`); off by default.
 */
class FakeUsbBackend(
    devices: List<UsbDeviceInfo> = listOf(cable()),
    private val isMainThread: () -> Boolean = { false },
) : UsbBackend {

    /** Fault injection; may be changed between operations, like `faults` in fake-device.mjs. */
    class Faults {
        /** Attempt at which the cable is unplugged: [UsbDeviceListener.onDetached] fires, then the send fails. */
        @Volatile var detachAtReport: Int? = null

        /** Attempt that fails with [UsbFailure.Timeout] (the `hangAtReport` of the JS fake). */
        @Volatile var timeoutAtReport: Int? = null

        /** Attempt that fails with [UsbFailure.TransferFailed] and [failCode]. */
        @Volatile var failAtReport: Int? = null

        /** Code of the [failAtReport] failure. */
        @Volatile var failCode: Int = -1

        /** [requestPermission] resolves false. */
        @Volatile var permissionDenied: Boolean = false

        /** Every claim returns false (EBUSY), forced or not. */
        @Volatile var claimBusy: Boolean = false

        /** A kernel driver holds the interfaces: only a forced claim succeeds, and it detaches the driver. */
        @Volatile var kernelDriverBound: Boolean = false

        /** If set, [open] throws it. */
        @Volatile var openError: UsbFailure? = null

        /** If set, [release] throws it. */
        @Volatile var releaseError: UsbFailure? = null

        /** Bytes served by [hidReportDescriptor]. */
        @Volatile var reportDescriptor: ByteArray = DEFAULT_REPORT_DESCRIPTOR

        /** Bytes served by [rawDescriptors]. */
        @Volatile var rawDescriptors: ByteArray = DEFAULT_RAW_DESCRIPTORS
    }

    /** Route a report took. */
    enum class Route { INTERRUPT, CONTROL }

    /** One delivered report. */
    class SentReport(
        val deviceKey: String,
        val route: Route,
        val bytes: ByteArray,
        val endpointAddress: Int?,
        val setup: ControlSetup?,
        val timeoutMs: Int,
    )

    val faults = Faults()

    /** When false, [hasHost] is false and every call fails with [UsbFailure.NoHost]. */
    @Volatile var hostSupported: Boolean = true

    private val lock = Any()
    private val attached = LinkedHashMap<String, UsbDeviceInfo>()
    private val granted = HashSet<String>()
    private val open = LinkedHashMap<Long, UsbConnectionHandle>()
    private val claimed = HashSet<Pair<Long, Int>>()
    private val sentReports = ArrayList<SentReport>()
    private val callLog = ArrayList<String>()
    private val listeners = CopyOnWriteArrayList<UsbDeviceListener>()
    private var nextId = 0L
    private var attemptCount = 0
    private var permissionRequestCount = 0

    init {
        devices.forEach { attached[it.key] = it }
    }

    /** Delivered reports, in order. */
    val sent: List<SentReport>
        get() = synchronized(lock) { sentReports.toList() }

    /** Log of the I/O calls, e.g. `open`, `claim 2 force=true`, `release 2`, `INTERRUPT`. */
    val calls: List<String>
        get() = synchronized(lock) { callLog.toList() }

    /** Send attempts so far, delivered or not. */
    val attempts: Int
        get() = synchronized(lock) { attemptCount }

    /** Calls to [requestPermission]. */
    val permissionRequests: Int
        get() = synchronized(lock) { permissionRequestCount }

    /** Grants permission for [device] without a dialog. */
    fun grant(device: UsbDeviceInfo) {
        synchronized(lock) { granted += device.key }
    }

    /** Whether interface [interfaceId] is claimed on [connection]. */
    fun isClaimed(connection: UsbConnectionHandle, interfaceId: Int): Boolean =
        synchronized(lock) { (connection.id to interfaceId) in claimed }

    /** Whether [connection] is open. */
    fun isOpen(connection: UsbConnectionHandle): Boolean = synchronized(lock) { connection.id in open }

    /** Plugs [device] in and fires [UsbDeviceListener.onAttached]. */
    fun attach(device: UsbDeviceInfo) {
        synchronized(lock) { attached[device.key] = device }
        listeners.forEach { it.onAttached(device) }
    }

    /** Unplugs the device and fires [UsbDeviceListener.onDetached]. Idempotent. */
    fun detach(deviceKey: String) {
        val device = synchronized(lock) {
            val removed = attached.remove(deviceKey) ?: return
            val ids = open.values.filter { it.device.key == deviceKey }.map { it.id }.toSet()
            open.keys.removeAll(ids)
            claimed.removeAll { it.first in ids }
            removed
        }
        listeners.forEach { it.onDetached(device) }
    }

    override val hasHost: Boolean
        get() = hostSupported

    override fun list(filters: List<UsbFilter>): List<UsbDeviceInfo> {
        if (!hostSupported) throw UsbFailure.NoHost()
        return synchronized(lock) {
            attached.values.filter { device -> filters.isEmpty() || filters.any { it.matches(device) } }
                .map { device ->
                    if (device.key !in granted && device.serialNumber != null) {
                        UsbDeviceInfo(
                            device.key, device.vendorId, device.productId, device.productName,
                            device.manufacturerName, device.interfaces,
                        )
                    } else {
                        device
                    }
                }
        }
    }

    override fun hasPermission(device: UsbDeviceInfo): Boolean = synchronized(lock) { device.key in granted }

    override fun requestPermission(device: UsbDeviceInfo, callback: PermissionCallback) {
        val result: Result<Boolean> = synchronized(lock) {
            permissionRequestCount++
            when {
                !hostSupported -> Result.failure(UsbFailure.NoHost())
                device.key !in attached -> Result.failure<Boolean>(UsbFailure.NotFound(device.key))
                device.key in granted -> Result.success(true)
                faults.permissionDenied -> Result.success(false)
                else -> {
                    granted += device.key
                    Result.success(true)
                }
            }
        }
        callback(result)
    }

    override fun open(device: UsbDeviceInfo): UsbConnectionHandle {
        io("open")
        synchronized(lock) {
            faults.openError?.let { throw it }
            if (device.key !in attached) throw UsbFailure.NotFound(device.key)
            if (device.key !in granted) throw UsbFailure.PermissionDenied(device.key)
            open.values.firstOrNull { it.device.key == device.key }?.let { return it }
            val handle = UsbConnectionHandle(device, ++nextId)
            open[handle.id] = handle
            return handle
        }
    }

    override fun rawDescriptors(connection: UsbConnectionHandle): ByteArray {
        io("rawDescriptors")
        synchronized(lock) { requireOpen(connection) }
        return faults.rawDescriptors.copyOf()
    }

    override fun hidReportDescriptor(connection: UsbConnectionHandle, interfaceId: Int, length: Int): ByteArray {
        io("hidReportDescriptor $interfaceId")
        synchronized(lock) { requireOpen(connection) }
        val descriptor = faults.reportDescriptor
        return descriptor.copyOf(minOf(length, descriptor.size))
    }

    override fun transferInterrupt(
        connection: UsbConnectionHandle,
        endpoint: UsbEndpointInfo,
        buffer: ByteArray,
        timeoutMs: Int,
    ): Int {
        if (!endpoint.isInterrupt) throw UsbFailure.BadArgs("endpoint ${endpoint.address} is not interrupt")
        return send(connection, Route.INTERRUPT, buffer, endpoint.address, null, timeoutMs)
    }

    override fun controlOut(
        connection: UsbConnectionHandle,
        setup: ControlSetup,
        buffer: ByteArray,
        timeoutMs: Int,
    ): Int = send(connection, Route.CONTROL, buffer, null, setup, timeoutMs)

    override fun claim(connection: UsbConnectionHandle, usbInterface: UsbInterfaceInfo, force: Boolean): Boolean {
        io("claim ${usbInterface.id} force=$force")
        synchronized(lock) {
            requireOpen(connection)
            val ok = when {
                faults.claimBusy -> false
                faults.kernelDriverBound && !force -> false
                else -> true
            }
            if (ok) {
                if (force) faults.kernelDriverBound = false
                claimed += connection.id to usbInterface.id
            }
            return ok
        }
    }

    override fun release(connection: UsbConnectionHandle, usbInterface: UsbInterfaceInfo): Boolean {
        io("release ${usbInterface.id}")
        faults.releaseError?.let { throw it }
        synchronized(lock) {
            requireOpen(connection)
            return claimed.remove(connection.id to usbInterface.id)
        }
    }

    override fun close(connection: UsbConnectionHandle) {
        io("close")
        synchronized(lock) {
            open.remove(connection.id)
            claimed.removeAll { it.first == connection.id }
        }
    }

    override fun addListener(listener: UsbDeviceListener) {
        listeners += listener
    }

    override fun removeListener(listener: UsbDeviceListener) {
        listeners -= listener
    }

    override fun dispose() {
        listeners.clear()
    }

    private fun send(
        connection: UsbConnectionHandle,
        route: Route,
        buffer: ByteArray,
        endpointAddress: Int?,
        setup: ControlSetup?,
        timeoutMs: Int,
    ): Int {
        io(route.name)
        val key = connection.device.key
        val failure: UsbFailure? = synchronized(lock) {
            requireOpen(connection)
            when (attemptCount++) {
                faults.detachAtReport -> UsbFailure.Detached(key)
                faults.timeoutAtReport -> UsbFailure.Timeout(key, timeoutMs, null)
                faults.failAtReport -> UsbFailure.TransferFailed(key, faults.failCode, "injected failure")
                else -> {
                    sentReports += SentReport(key, route, buffer.copyOf(), endpointAddress, setup, timeoutMs)
                    null
                }
            }
        }
        // As on the real backend, the detach event fires before the send reports the failure.
        if (failure is UsbFailure.Detached) detach(key)
        if (failure != null) throw failure
        return buffer.size
    }

    private fun io(call: String) {
        if (isMainThread()) throw UsbFailure.MainThread(call)
        if (!hostSupported) throw UsbFailure.NoHost()
        synchronized(lock) { callLog += call }
    }

    /** Called with [lock] held. */
    private fun requireOpen(connection: UsbConnectionHandle) {
        if (connection.id in open) return
        if (connection.device.key !in attached) throw UsbFailure.Detached(connection.device.key)
        throw UsbFailure.NotOpen(connection.device.key)
    }

    companion object {
        /** VID of the 0xCB DSP cable. */
        const val VENDOR_ID: Int = 0x3302

        /** PID of the 0xCB DSP cable. */
        const val PRODUCT_ID: Int = 0x8902

        /** Product string of the cable. */
        const val PRODUCT_NAME: String = "USB DSP Audio"

        /** Interface number of the HID interface of [cable]; interfaces 0 and 1 are audio. */
        const val HID_INTERFACE_ID: Int = 2

        /** Address of the interrupt OUT endpoint of [cable]. */
        const val INTERRUPT_OUT_ADDRESS: Int = 0x04

        /** Vendor page, one output report 0xCB of 31 bytes (32 on the wire with the ID). */
        val DEFAULT_REPORT_DESCRIPTOR: ByteArray = bytes(
            0x06, 0x00, 0xFF, // Usage Page (Vendor 0xFF00)
            0x09, 0x01, // Usage (1)
            0xA1, 0x01, // Collection (Application)
            0x85, 0xCB, // Report ID (0xCB)
            0x15, 0x00, // Logical Minimum (0)
            0x26, 0xFF, 0x00, // Logical Maximum (255)
            0x75, 0x08, // Report Size (8)
            0x95, 0x1F, // Report Count (31)
            0x09, 0x01, // Usage (1)
            0x91, 0x02, // Output (Data, Variable, Absolute)
            0xC0, // End Collection
        )

        /** Device descriptor of the cable (VID 0x3302, PID 0x8902). */
        val DEFAULT_RAW_DESCRIPTORS: ByteArray = bytes(
            0x12, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x40,
            0x02, 0x33, 0x02, 0x89, 0x00, 0x01, 0x01, 0x02, 0x00, 0x01,
        )

        /**
         * The cable as a composite device: interface 0 audio control, interface 1 audio
         * streaming, interface 2 HID with an interrupt IN endpoint and, if [interruptOut], an
         * interrupt OUT endpoint ([INTERRUPT_OUT_ADDRESS]).
         */
        fun cable(key: String = "/dev/bus/usb/001/002", interruptOut: Boolean = true, serialNumber: String? = null): UsbDeviceInfo {
            val hidEndpoints = buildList {
                add(UsbEndpointInfo(0x83, 0x03, 64, 1))
                if (interruptOut) add(UsbEndpointInfo(INTERRUPT_OUT_ADDRESS, 0x03, 64, 1))
            }
            return UsbDeviceInfo(
                key = key,
                vendorId = VENDOR_ID,
                productId = PRODUCT_ID,
                productName = PRODUCT_NAME,
                manufacturerName = "Generic",
                serialNumber = serialNumber,
                interfaces = listOf(
                    UsbInterfaceInfo(0, 0, UsbBackend.CLASS_AUDIO, 0x01, 0x00, emptyList()),
                    UsbInterfaceInfo(1, 0, UsbBackend.CLASS_AUDIO, 0x02, 0x00, listOf(UsbEndpointInfo(0x01, 0x09, 192, 1))),
                    UsbInterfaceInfo(HID_INTERFACE_ID, 0, UsbBackend.CLASS_HID, 0x00, 0x00, hidEndpoints),
                ),
            )
        }

        private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }
    }
}
