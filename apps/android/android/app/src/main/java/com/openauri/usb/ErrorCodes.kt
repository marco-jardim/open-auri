package com.openauri.usb

/**
 * Native error codes of the `OpenAuriUsb` bridge (plan, Anexo C) and how failures map to them.
 *
 * Every rejection of the plugin carries one of these codes; the web side maps them to the
 * `DOMException` names WebHID uses (`USB_BAD_ARGS` to `TypeError`), so the transport classifies
 * failures exactly as on the desktop.
 */
object ErrorCodes {
    /** Invalid argument: reportId outside 0..255, invalid base64, empty key, malformed filters. */
    const val USB_BAD_ARGS: String = "USB_BAD_ARGS"

    /** Unknown key, or the device (or its HID interface) is not there. */
    const val USB_NOT_FOUND: String = "USB_NOT_FOUND"

    /** `sendReport` or `diagnostics` before `open`, or after `close`. */
    const val USB_NOT_OPEN: String = "USB_NOT_OPEN"

    /** A concurrent `sendReport` on the same key, or the interface is held elsewhere (EBUSY). */
    const val USB_BUSY: String = "USB_BUSY"

    /** The app has no Android permission for the device. */
    const val USB_PERMISSION_DENIED: String = "USB_PERMISSION_DENIED"

    /** The [FrameGuard] refused the report; the message carries the reason. Nothing was sent. */
    const val USB_GUARD_REJECTED: String = "USB_GUARD_REJECTED"

    /** The transfer failed or was short, or the device does not fit the HID framing. */
    const val USB_TRANSFER_FAILED: String = "USB_TRANSFER_FAILED"

    /** The transfer did not finish within [UsbBackend.DEFAULT_TIMEOUT_MS]. */
    const val USB_TIMEOUT: String = "USB_TIMEOUT"

    /** The device was unplugged during the operation (the `disconnect` event comes first). */
    const val USB_DETACHED: String = "USB_DETACHED"

    /** The page in the WebView is not on the pinned origin ([OriginGuard]). Nothing was done. */
    const val USB_ORIGIN: String = "USB_ORIGIN"

    /** The device has no USB host support (no `android.hardware.usb.host` feature). */
    const val USB_NO_HOST: String = "USB_NO_HOST"

    /** Every code, in the order of Anexo C; the bridge schema's `ErrorCode` enum lists the same. */
    val ALL: List<String> = listOf(
        USB_BAD_ARGS,
        USB_NOT_FOUND,
        USB_NOT_OPEN,
        USB_BUSY,
        USB_PERMISSION_DENIED,
        USB_GUARD_REJECTED,
        USB_TRANSFER_FAILED,
        USB_TIMEOUT,
        USB_DETACHED,
        USB_ORIGIN,
        USB_NO_HOST,
    )

    /**
     * Code of a [UsbFailure]. [UsbFailure.OpenFailed], [UsbFailure.MainThread], [UsbFailure.Closed]
     * and [UsbFailure.Interrupted] have no dedicated code: they become [USB_TRANSFER_FAILED] (the
     * generic `NotAllowedError` WebHID raises when a device operation fails) and keep their message.
     */
    fun of(failure: UsbFailure): String = when (failure) {
        is UsbFailure.NoHost -> USB_NO_HOST
        is UsbFailure.NotFound -> USB_NOT_FOUND
        is UsbFailure.PermissionDenied -> USB_PERMISSION_DENIED
        is UsbFailure.OpenFailed -> USB_TRANSFER_FAILED
        is UsbFailure.NotOpen -> USB_NOT_OPEN
        is UsbFailure.Busy -> USB_BUSY
        is UsbFailure.Timeout -> USB_TIMEOUT
        is UsbFailure.TransferFailed -> USB_TRANSFER_FAILED
        is UsbFailure.Detached -> USB_DETACHED
        is UsbFailure.MainThread -> USB_TRANSFER_FAILED
        is UsbFailure.BadArgs -> USB_BAD_ARGS
        is UsbFailure.Closed -> USB_TRANSFER_FAILED
        is UsbFailure.Interrupted -> USB_TRANSFER_FAILED
    }

    /**
     * Code of any failure raised while serving a bridge call: [UsbBridgeException] keeps its code,
     * [UsbFailure] maps through [of], and everything else (HID descriptor or framing errors, an
     * unexpected runtime error) is [USB_TRANSFER_FAILED].
     */
    fun of(error: Throwable): String = when (error) {
        is UsbBridgeException -> error.code
        is UsbFailure -> of(error)
        else -> USB_TRANSFER_FAILED
    }

    /** Message sent with the rejection: the failure's own message, or its class name. */
    fun messageOf(error: Throwable): String = error.message ?: error.javaClass.name
}

/**
 * A bridge call failed with [code] (one of [ErrorCodes.ALL]) before or instead of reaching the
 * USB backend.
 */
class UsbBridgeException(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause) {
    init {
        require(code in ErrorCodes.ALL) { "unknown bridge error code $code" }
    }
}
