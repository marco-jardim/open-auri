package com.openauri.usb

/**
 * Narrow USB host API used by the OpenAuri transport plugin.
 *
 * Every type it exposes is a plain Kotlin value ([UsbDeviceInfo], [UsbInterfaceInfo],
 * [UsbEndpointInfo], [ControlSetup]) or an opaque [UsbConnectionHandle], so callers never touch
 * `android.hardware.usb` classes and tests can swap in a fake backend.
 *
 * Threading contract:
 * - [open], [rawDescriptors], [hidReportDescriptor], [transferInterrupt], [controlOut], [claim],
 *   [release] and [close] block until the I/O finishes. They must be called off the main thread;
 *   on the main thread they throw [UsbFailure.MainThread] without touching the device.
 * - [list], [hasPermission], [requestPermission], [findHidInterface], [addListener],
 *   [removeListener] and [dispose] perform no USB I/O and may be called from any thread.
 *
 * Errors are thrown as [UsbFailure]; [requestPermission] reports them through its callback.
 */
interface UsbBackend {

    /** False when the device has no USB host support; the other calls then fail with [UsbFailure.NoHost]. */
    val hasHost: Boolean

    /** Attached devices matching any of [filters], or every attached device when [filters] is empty. */
    fun list(filters: List<UsbFilter>): List<UsbDeviceInfo>

    /** Whether the app may open [device] without asking the user. */
    fun hasPermission(device: UsbDeviceInfo): Boolean

    /**
     * Asks the user for access to [device]. [callback] runs exactly once with `true` (granted),
     * `false` (denied) or a [UsbFailure]: on the caller's thread when the answer is known at once,
     * on the main thread otherwise. Concurrent requests for one device share a single dialog.
     */
    fun requestPermission(device: UsbDeviceInfo, callback: PermissionCallback)

    /** Opens [device]. Opening an already open device returns the existing handle. */
    fun open(device: UsbDeviceInfo): UsbConnectionHandle

    /** Raw device, configuration, interface and endpoint descriptors of the connection. */
    fun rawDescriptors(connection: UsbConnectionHandle): ByteArray

    /**
     * Reads up to [length] bytes of the HID report descriptor of interface [interfaceId] with a
     * standard GET_DESCRIPTOR request (see [ControlSetup.hidReportDescriptor]).
     */
    fun hidReportDescriptor(connection: UsbConnectionHandle, interfaceId: Int, length: Int): ByteArray

    /**
     * The HID interface (class [CLASS_HID]) of [device], chosen by class and never by position:
     * on a composite audio + HID device interface 0 is audio. Prefers an interface with an
     * interrupt OUT endpoint; null when the device has no HID interface.
     */
    fun findHidInterface(device: UsbDeviceInfo): UsbInterfaceInfo? = selectHidInterface(device)

    /**
     * Runs one interrupt transfer of [buffer] on [endpoint] and returns the number of bytes
     * transferred. For an OUT endpoint a value below `buffer.size` means a short write.
     */
    fun transferInterrupt(
        connection: UsbConnectionHandle,
        endpoint: UsbEndpointInfo,
        buffer: ByteArray,
        timeoutMs: Int,
    ): Int

    /** Runs a host-to-device control transfer with [buffer] as data stage; returns the bytes sent. */
    fun controlOut(
        connection: UsbConnectionHandle,
        setup: ControlSetup,
        buffer: ByteArray,
        timeoutMs: Int,
    ): Int

    /**
     * Claims [usbInterface]. With [force] the kernel driver bound to it is detached first.
     * Returns false when the interface stays held by someone else (EBUSY).
     */
    fun claim(connection: UsbConnectionHandle, usbInterface: UsbInterfaceInfo, force: Boolean): Boolean

    /** Releases [usbInterface]; returns false when the platform refused. */
    fun release(connection: UsbConnectionHandle, usbInterface: UsbInterfaceInfo): Boolean

    /** Closes the connection, releasing its claimed interfaces. Idempotent. */
    fun close(connection: UsbConnectionHandle)

    /** Registers [listener] for attach and detach events (delivered on the main thread). */
    fun addListener(listener: UsbDeviceListener)

    /** Unregisters [listener]. */
    fun removeListener(listener: UsbDeviceListener)

    /** Unregisters receivers, fails pending permission requests and closes every connection. */
    fun dispose()

    companion object {
        /** bInterfaceClass of audio interfaces. */
        const val CLASS_AUDIO: Int = 0x01

        /** bInterfaceClass of HID interfaces. */
        const val CLASS_HID: Int = 0x03

        /** Transfer timeout of the plan (Anexo C, `USB_TIMEOUT`). */
        const val DEFAULT_TIMEOUT_MS: Int = 1000

        /** Shared implementation of [UsbBackend.findHidInterface]. */
        fun selectHidInterface(device: UsbDeviceInfo): UsbInterfaceInfo? {
            val hid = device.interfaces.filter { it.interfaceClass == CLASS_HID }
            return hid.firstOrNull { it.interruptOut != null } ?: hid.firstOrNull()
        }
    }
}

/** Receives the outcome of [UsbBackend.requestPermission]. */
typealias PermissionCallback = (Result<Boolean>) -> Unit

/** Attach and detach notifications of [UsbBackend]. */
interface UsbDeviceListener {
    /** [device] was plugged in. */
    fun onAttached(device: UsbDeviceInfo)

    /** [device] was unplugged; operations still pending on it fail with [UsbFailure.Detached]. */
    fun onDetached(device: UsbDeviceInfo)
}

/** Vendor/product filter for [UsbBackend.list]; a null field matches any value. */
class UsbFilter(val vendorId: Int?, val productId: Int?) {
    /** Whether [device] passes this filter. */
    fun matches(device: UsbDeviceInfo): Boolean =
        (vendorId == null || vendorId == device.vendorId) &&
            (productId == null || productId == device.productId)
}

/**
 * Snapshot of an attached USB device.
 *
 * @property key stable identity while attached (the platform device name, e.g. `/dev/bus/usb/001/002`).
 * @property interfaces every interface of the active configuration, in descriptor order.
 * @property serialNumber physical serial when permission allows reading it, otherwise null.
 */
class UsbDeviceInfo(
    val key: String,
    val vendorId: Int,
    val productId: Int,
    val productName: String?,
    val manufacturerName: String?,
    val interfaces: List<UsbInterfaceInfo>,
    val serialNumber: String? = null,
)

/** One interface (alternate setting) of a [UsbDeviceInfo]. */
class UsbInterfaceInfo(
    val id: Int,
    val alternateSetting: Int,
    val interfaceClass: Int,
    val interfaceSubclass: Int,
    val interfaceProtocol: Int,
    val endpoints: List<UsbEndpointInfo>,
) {
    /** First interrupt OUT endpoint, or null when output reports must go through SET_REPORT. */
    val interruptOut: UsbEndpointInfo?
        get() = endpoints.firstOrNull { it.isInterruptOut }
}

/** One endpoint of a [UsbInterfaceInfo]: raw bEndpointAddress, bmAttributes, wMaxPacketSize, bInterval. */
class UsbEndpointInfo(val address: Int, val attributes: Int, val maxPacketSize: Int, val interval: Int) {
    /** True for device-to-host endpoints. */
    val isIn: Boolean
        get() = (address and DIRECTION_MASK) == DIRECTION_IN

    /** True for interrupt endpoints. */
    val isInterrupt: Boolean
        get() = (attributes and TYPE_MASK) == TYPE_INTERRUPT

    /** True for interrupt OUT endpoints, the preferred route for output reports. */
    val isInterruptOut: Boolean
        get() = isInterrupt && !isIn

    companion object {
        /** Direction bit of bEndpointAddress. */
        const val DIRECTION_MASK: Int = 0x80

        /** Direction value of IN endpoints. */
        const val DIRECTION_IN: Int = 0x80

        /** Transfer type bits of bmAttributes. */
        const val TYPE_MASK: Int = 0x03

        /** Transfer type value of interrupt endpoints. */
        const val TYPE_INTERRUPT: Int = 0x03
    }
}

/** Opaque handle of an open connection, valid until [UsbBackend.close] or detach. */
class UsbConnectionHandle(val device: UsbDeviceInfo, val id: Long)

/**
 * Setup stage of a control transfer: bmRequestType, bRequest, wValue and wIndex.
 *
 * @throws UsbFailure.BadArgs when a field does not fit its USB width.
 */
class ControlSetup(val requestType: Int, val request: Int, val value: Int, val index: Int) {
    init {
        checkField("requestType", requestType, BYTE_MAX)
        checkField("request", request, BYTE_MAX)
        checkField("value", value, WORD_MAX)
        checkField("index", index, WORD_MAX)
    }

    companion object {
        /** bmRequestType of a standard device-to-host request addressed to an interface. */
        const val GET_DESCRIPTOR_REQUEST_TYPE: Int = 0x81

        /** bRequest GET_DESCRIPTOR. */
        const val GET_DESCRIPTOR: Int = 0x06

        /** wValue for descriptor type 0x22 (HID report), index 0. */
        const val HID_REPORT_DESCRIPTOR_VALUE: Int = 0x2200

        private const val BYTE_MAX = 0xFF
        private const val WORD_MAX = 0xFFFF

        /** GET_DESCRIPTOR(HID report) for interface [interfaceId]: `0x81, 0x06, 0x2200, interfaceId`. */
        fun hidReportDescriptor(interfaceId: Int): ControlSetup =
            ControlSetup(GET_DESCRIPTOR_REQUEST_TYPE, GET_DESCRIPTOR, HID_REPORT_DESCRIPTOR_VALUE, interfaceId)

        private fun checkField(name: String, value: Int, max: Int) {
            if (value !in 0..max) throw UsbFailure.BadArgs("$name $value is outside 0..$max")
        }
    }
}
