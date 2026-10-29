package com.openauri.usb

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.webkit.WebViewCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.openauri.app.BuildConfig

/**
 * Versions reported by `getInfo` and `diagnostics`; [webViewVersion] and [usbHost] are read on
 * every call. None of them identifies the user.
 */
class AppInfo(
    val appVersion: String,
    val androidVersion: String,
    private val webView: () -> String?,
    private val usbHostFeature: () -> Boolean,
) {
    /** Version name of the active WebView provider, or [UNKNOWN]. */
    val webViewVersion: String
        get() = webView()?.takeIf { it.isNotBlank() } ?: UNKNOWN

    /** Whether the device declares `PackageManager.FEATURE_USB_HOST`. */
    val usbHost: Boolean
        get() = usbHostFeature()

    companion object {
        /** Reported when a version cannot be read. */
        const val UNKNOWN: String = "unknown"

        /** The real values: build version, Android release and API level, WebView package, feature. */
        fun from(context: Context): AppInfo = AppInfo(
            appVersion = BuildConfig.VERSION_NAME,
            androidVersion = "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            webView = { WebViewCompat.getCurrentWebViewPackage(context)?.versionName },
            usbHostFeature = { context.packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST) },
        )
    }
}

/**
 * Debug-only log of the bytes sent on the wire (plan RS7): a ring buffer of the last [capacity]
 * buffers, each with the monotonic time it was sent. The plugin creates one only when
 * `BuildConfig.DEBUG` is true; a release build never records or reports a wire log. The buffers
 * are 0xCB reports (EQ coefficients), never personal data.
 */
class WireLog(private val capacity: Int = CAPACITY) {
    private class Entry(val atMs: Long, val hex: String)

    private val entries = ArrayDeque<Entry>()

    init {
        require(capacity > 0) { "capacity $capacity must be positive" }
    }

    /** Records [bytes], sent at [atMs]; the oldest entry goes when the buffer is full. */
    @Synchronized
    fun record(atMs: Long, bytes: ByteArray) {
        if (entries.size == capacity) entries.removeFirst()
        entries.addLast(Entry(atMs, bytes.toHex()))
    }

    /** The entries, oldest first, as `[{atMs, hex}]`. */
    @Synchronized
    fun toJson(): JSArray = JSArray().apply {
        entries.forEach { put(JSObject().put("atMs", it.atMs).put("hex", it.hex)) }
    }

    companion object {
        /** Enough for the 12 writes of the hardware validation (Anexo E), 10 reports each. */
        const val CAPACITY: Int = 256
    }
}

/** Walks the raw descriptors returned by `UsbDeviceConnection.getRawDescriptors()`. */
object UsbDescriptors {
    /** bDescriptorType of an interface descriptor. */
    const val TYPE_INTERFACE: Int = 0x04

    /** bDescriptorType of the HID class descriptor (HID 1.11 section 6.2.1). */
    const val TYPE_HID: Int = 0x21

    /** bDescriptorType of the HID report descriptor, as listed inside the HID descriptor. */
    const val TYPE_HID_REPORT: Int = 0x22

    private const val INTERFACE_LENGTH = 9
    private const val INTERFACE_NUMBER_OFFSET = 2
    private const val ALTERNATE_SETTING_OFFSET = 3
    private const val HID_DESCRIPTOR_COUNT_OFFSET = 5
    private const val HID_DESCRIPTOR_LIST_OFFSET = 6
    private const val HID_DESCRIPTOR_ENTRY_BYTES = 3

    /**
     * wDescriptorLength of the report descriptor declared by the HID descriptor that follows the
     * interface descriptor of [interfaceId] / [alternateSetting]; null when it is absent, zero or
     * the descriptors are truncated (the caller then asks for a safe maximum).
     */
    fun hidReportDescriptorLength(raw: ByteArray, interfaceId: Int, alternateSetting: Int): Int? {
        var offset = 0
        var inInterface = false
        while (offset + 1 < raw.size) {
            val length = raw.u8(offset)
            if (length < 2 || offset + length > raw.size) return null
            when (raw.u8(offset + 1)) {
                TYPE_INTERFACE -> inInterface = length >= INTERFACE_LENGTH &&
                    raw.u8(offset + INTERFACE_NUMBER_OFFSET) == interfaceId &&
                    raw.u8(offset + ALTERNATE_SETTING_OFFSET) == alternateSetting
                TYPE_HID -> if (inInterface) return reportLength(raw, offset, length)
            }
            offset += length
        }
        return null
    }

    private fun reportLength(raw: ByteArray, offset: Int, length: Int): Int? {
        if (length <= HID_DESCRIPTOR_COUNT_OFFSET) return null
        val end = offset + length
        for (index in 0 until raw.u8(offset + HID_DESCRIPTOR_COUNT_OFFSET)) {
            val entry = offset + HID_DESCRIPTOR_LIST_OFFSET + index * HID_DESCRIPTOR_ENTRY_BYTES
            if (entry + HID_DESCRIPTOR_ENTRY_BYTES > end) return null
            if (raw.u8(entry) == TYPE_HID_REPORT) {
                return (raw.u8(entry + 1) or (raw.u8(entry + 2) shl 8)).takeIf { it > 0 }
            }
        }
        return null
    }

    private fun ByteArray.u8(index: Int): Int = this[index].toInt() and 0xFF
}

/**
 * The `UsbDiagnostics` object of the bridge contract (plan Anexo B, RF8): what the engineering
 * screen shows and the hardware report carries. Built from what `open` read and cached, so it
 * performs no USB I/O. It holds descriptors and versions, never personal data; the wire log is
 * only present when [wireLog] is non-null, which the plugin allows in debug builds only.
 */
object UsbDiagnostics {
    /** Values of `endpoints[].type`, indexed by the transfer type bits of bmAttributes. */
    private val ENDPOINT_TYPES = listOf("control", "isochronous", "bulk", "interrupt")

    /** `transfer` when output reports go through the interrupt OUT endpoint. */
    const val TRANSFER_INTERRUPT: String = "interrupt"

    /** `transfer` when output reports go through SET_REPORT control transfers. */
    const val TRANSFER_CONTROL: String = "control"

    /** The diagnostics JSON. [device] is the `NativeDeviceInfo` of the connection. */
    fun build(
        device: JSObject,
        info: AppInfo,
        rawDescriptors: ByteArray,
        hidInterface: UsbInterfaceInfo,
        reportDescriptor: ByteArray,
        descriptor: ParsedDescriptor,
        interruptOut: UsbEndpointInfo?,
        kernelDriverDetached: Boolean,
        wireLog: WireLog?,
        abandonedSequences: Int? = null,
    ): JSObject {
        val endpoints = JSArray()
        hidInterface.endpoints.forEach { endpoint ->
            endpoints.put(
                JSObject()
                    .put("address", endpoint.address)
                    .put("type", ENDPOINT_TYPES[endpoint.attributes and UsbEndpointInfo.TYPE_MASK])
                    .put("direction", if (endpoint.isIn) "in" else "out")
                    .put("maxPacketSize", endpoint.maxPacketSize),
            )
        }
        val outputReports = JSArray()
        descriptor.outputReportIds.forEach { reportId ->
            val bytes = descriptor.reports.getValue(reportId).outputBytes
            outputReports.put(JSObject().put("reportId", reportId).put("bytes", bytes))
        }
        val result = JSObject()
            .put("device", device)
            .put("appVersion", info.appVersion)
            .put("androidVersion", info.androidVersion)
            .put("webViewVersion", info.webViewVersion)
            .put("rawDescriptorsHex", rawDescriptors.toHex())
            .put("hidInterfaceId", hidInterface.id)
            .put("endpoints", endpoints)
            .put("reportDescriptorHex", reportDescriptor.toHex())
            .put("outputReports", outputReports)
            .put("transfer", if (interruptOut != null) TRANSFER_INTERRUPT else TRANSFER_CONTROL)
            .put("paddedLength", HidFraming.paddedLength(descriptor))
            .put("kernelDriverDetached", kernelDriverDetached)
        if (abandonedSequences != null) result.put("abandonedSequences", abandonedSequences)
        if (wireLog != null) result.put("wireLog", wireLog.toJson())
        return result
    }
}

private val HEX_DIGITS = "0123456789abcdef".toCharArray()

/** Lower-case hex of every byte, no separators. */
internal fun ByteArray.toHex(): String {
    val out = CharArray(size * 2)
    forEachIndexed { index, byte ->
        val value = byte.toInt() and 0xFF
        out[index * 2] = HEX_DIGITS[value ushr 4]
        out[index * 2 + 1] = HEX_DIGITS[value and 0x0F]
    }
    return String(out)
}
