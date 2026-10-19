package com.openauri.usb

/**
 * Typed failures raised by [UsbBackend] implementations.
 *
 * The plugin maps them to the native error codes of the plan (Anexo C): for example
 * [NotFound] to `USB_NOT_FOUND`, [NotOpen] to `USB_NOT_OPEN`, [Busy] to `USB_BUSY`,
 * [PermissionDenied] to `USB_PERMISSION_DENIED`, [TransferFailed] to `USB_TRANSFER_FAILED`,
 * [Timeout] to `USB_TIMEOUT`, [Detached] to `USB_DETACHED`, [NoHost] to `USB_NO_HOST` and
 * [BadArgs] to `USB_BAD_ARGS`. The remaining cases ([OpenFailed], [MainThread], [Closed],
 * [Interrupted]) have no dedicated code and keep their message.
 */
sealed class UsbFailure(message: String, cause: Throwable?) : Exception(message, cause) {

    /** The device has no USB host support. */
    class NoHost : UsbFailure("USB host mode is not supported on this device", null)

    /** No attached device (or interface, or endpoint) matches [deviceKey]. */
    class NotFound(val deviceKey: String) : UsbFailure("USB device not found: $deviceKey", null)

    /** The app has no permission to use the device. */
    class PermissionDenied(val deviceKey: String) :
        UsbFailure("USB permission denied for $deviceKey", null)

    /** `UsbManager.openDevice` returned no connection although permission is granted. */
    class OpenFailed(val deviceKey: String) :
        UsbFailure("UsbManager.openDevice failed for $deviceKey", null)

    /** The connection handle was never opened or is already closed. */
    class NotOpen(val deviceKey: String) :
        UsbFailure("USB connection to $deviceKey is not open", null)

    /** The interface is held by another driver or process (EBUSY). */
    class Busy(val deviceKey: String, detail: String) :
        UsbFailure("USB device $deviceKey is busy: $detail", null)

    /** The transfer did not finish within [timeoutMs]. */
    class Timeout(val deviceKey: String, val timeoutMs: Int, cause: Throwable?) :
        UsbFailure("USB transfer to $deviceKey timed out after $timeoutMs ms", cause)

    /** The transfer failed; [code] is the negative value returned by the platform. */
    class TransferFailed(val deviceKey: String, val code: Int, detail: String) :
        UsbFailure("USB transfer to $deviceKey failed ($code): $detail", null)

    /** The device was unplugged before or during the operation. */
    class Detached(val deviceKey: String) : UsbFailure("USB device $deviceKey was detached", null)

    /** A blocking USB operation was called on the main thread. */
    class MainThread(val operation: String) :
        UsbFailure("USB I/O ($operation) is not allowed on the main thread", null)

    /** An argument is outside its valid range. */
    class BadArgs(detail: String) : UsbFailure("Invalid USB argument: $detail", null)

    /** The backend, broker or I/O lane was disposed. */
    class Closed(detail: String, cause: Throwable?) : UsbFailure(detail, cause)

    /** The calling thread was interrupted while waiting for the I/O lane. */
    class Interrupted(val operation: String, cause: InterruptedException) :
        UsbFailure("USB I/O ($operation) was interrupted", cause)
}
