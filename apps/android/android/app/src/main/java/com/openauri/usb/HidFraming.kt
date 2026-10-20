package com.openauri.usb

/** How [HidFraming.buildOutput] sizes the buffer handed to the USB stack. */
enum class HidPaddingPolicy {
    /**
     * Zero-pad every output report up to the largest output report declared by the descriptor
     * ([ParsedDescriptor.maxOutputReportBytes]), plus one byte for the report ID when the
     * descriptor uses report IDs.
     *
     * This mirrors Chromium (WebHID) on Windows: `HidConnectionWin::PlatformWrite` in
     * `services/device/hid/hid_connection_win.cc` resizes the outgoing buffer to
     * `max_output_report_size() + 1` before handing it to the HID class driver, which expects
     * every output write to be as long as the collection's longest output report
     * (https://source.chromium.org/chromium/chromium/src/+/main:services/device/hid/hid_connection_win.cc).
     * With a single 31-byte output report, as hypothesised for the CB5100, the buffer is
     * 32 bytes, the same length Chrome sends on Linux and macOS.
     */
    WINDOWS_MAX_OUTPUT,
}

/** Typed failures of [HidFraming]. */
sealed class HidFramingException(message: String) : Exception(message) {

    /**
     * [reportId] is not an Output report of the descriptor: it declares no Output item, or it
     * cannot be addressed on the wire (report 0 on a device that uses report IDs, or a non-zero
     * report on a device that does not).
     */
    class NotAnOutputReport(val reportId: Int) :
        HidFramingException("report $reportId is not a declared Output report")

    /** [length] data bytes do not fit Output report [reportId], declared with [maxLength] bytes. */
    class DataTooLong(val reportId: Int, val length: Int, val maxLength: Int) :
        HidFramingException("$length bytes do not fit Output report $reportId ($maxLength bytes)")

    /** Argument [name] is [value], outside [min]..[max]. */
    class ArgumentOutOfRange(val name: String, val value: Int, val min: Int, val max: Int) :
        HidFramingException("$name = $value is outside $min..$max")
}

/**
 * Setup packet of a HID SET_REPORT control transfer, in the argument order of
 * `UsbDeviceConnection.controlTransfer(requestType, request, value, index, buffer, length, timeout)`.
 *
 * @property requestType bmRequestType: host to device, class, interface (0x21).
 * @property request bRequest: SET_REPORT (0x09).
 * @property value wValue: report type Output (0x02) in the high byte, report ID in the low byte.
 * @property index wIndex: the HID interface number.
 * @property length wLength: bytes in the data stage.
 */
data class SetReportSetup(
    val requestType: Int,
    val request: Int,
    val value: Int,
    val index: Int,
    val length: Int,
)

/**
 * Output report framing for the USB backends (plan Annex D).
 *
 * The buffer built by [buildOutput] is what goes on the wire, both through an interrupt OUT
 * endpoint and as the data stage of a SET_REPORT control transfer ([setReportSetup]).
 */
object HidFraming {

    /** The only padding policy shipped; [paddedLength] and [buildOutput] implement it. */
    val PADDING_POLICY: HidPaddingPolicy = HidPaddingPolicy.WINDOWS_MAX_OUTPUT

    /** bmRequestType of SET_REPORT: host to device, class request, interface recipient. */
    const val SET_REPORT_REQUEST_TYPE: Int = 0x21

    /** bRequest of SET_REPORT (HID 1.11 section 7.2). */
    const val SET_REPORT_REQUEST: Int = 0x09

    /** Report type Output, high byte of wValue in SET_REPORT (HID 1.11 section 7.2.2). */
    const val REPORT_TYPE_OUTPUT: Int = 0x02

    private const val MAX_BYTE_FIELD = 0xFF
    private const val MAX_TRANSFER_LENGTH = 0xFFFF

    /**
     * Length of every buffer [buildOutput] returns for [descriptor] under [PADDING_POLICY]:
     * `maxOutputReportBytes + 1` when the descriptor uses report IDs, otherwise
     * `maxOutputReportBytes` (no report ID byte goes on the wire).
     */
    fun paddedLength(descriptor: ParsedDescriptor): Int =
        descriptor.maxOutputReportBytes + if (descriptor.usesReportIds) 1 else 0

    /**
     * Builds the wire buffer for Output report [reportId] carrying [data].
     *
     * With report IDs the buffer is `[reportId] + data`; without them it is `data` alone (pass
     * [reportId] 0). Either way it is zero-padded to [paddedLength]. [data] is not modified.
     *
     * @throws HidFramingException.ArgumentOutOfRange when [reportId] is outside 0..255.
     * @throws HidFramingException.NotAnOutputReport when [reportId] is not an Output report of
     *   [descriptor].
     * @throws HidFramingException.DataTooLong when [data] is longer than the declared report.
     */
    fun buildOutput(reportId: Int, data: ByteArray, descriptor: ParsedDescriptor): ByteArray {
        requireInRange("reportId", reportId, 0, MAX_BYTE_FIELD)
        val addressable = if (descriptor.usesReportIds) reportId != 0 else reportId == 0
        val report = descriptor.reports[reportId]
        if (!addressable || report == null || !report.declaresOutput) {
            throw HidFramingException.NotAnOutputReport(reportId)
        }
        if (data.size > report.outputBytes) {
            throw HidFramingException.DataTooLong(reportId, data.size, report.outputBytes)
        }
        val buffer = ByteArray(paddedLength(descriptor))
        val dataOffset = if (descriptor.usesReportIds) 1 else 0
        if (descriptor.usesReportIds) buffer[0] = reportId.toByte()
        data.copyInto(buffer, destinationOffset = dataOffset)
        return buffer
    }

    /**
     * Setup packet of a SET_REPORT (Output) control transfer:
     * `(0x21, 0x09, 0x0200 or reportId, interfaceId, length)`.
     *
     * @param reportId report ID, 0..255 (0 for devices without report IDs).
     * @param interfaceId HID interface number, 0..255.
     * @param length data stage length, 1..65535 (normally [paddedLength]).
     * @throws HidFramingException.ArgumentOutOfRange when an argument is out of range.
     */
    fun setReportSetup(reportId: Int, interfaceId: Int, length: Int): SetReportSetup {
        requireInRange("reportId", reportId, 0, MAX_BYTE_FIELD)
        requireInRange("interfaceId", interfaceId, 0, MAX_BYTE_FIELD)
        requireInRange("length", length, 1, MAX_TRANSFER_LENGTH)
        return SetReportSetup(
            requestType = SET_REPORT_REQUEST_TYPE,
            request = SET_REPORT_REQUEST,
            value = (REPORT_TYPE_OUTPUT shl 8) or reportId,
            index = interfaceId,
            length = length,
        )
    }

    private fun requireInRange(name: String, value: Int, min: Int, max: Int) {
        if (value < min || value > max) throw HidFramingException.ArgumentOutOfRange(name, value, min, max)
    }
}
