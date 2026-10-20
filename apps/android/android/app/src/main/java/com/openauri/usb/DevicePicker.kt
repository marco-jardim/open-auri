package com.openauri.usb

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.DialogInterface
import com.openauri.app.R
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.ceil

/** Lets the user choose which of several matching devices the page may use (plan RF2). */
fun interface DevicePicker {
    /**
     * Shows the choice among [devices] (two or more). [onResult] runs exactly once with the chosen
     * devices, in the order of [devices]; an empty list means the user cancelled or chose nothing.
     */
    fun pick(devices: List<UsbDeviceInfo>, onResult: (List<UsbDeviceInfo>) -> Unit)
}

/**
 * [DevicePicker] shown as a native multiple-choice [AlertDialog], the equivalent of WebHID's
 * chooser:
 * - the title, the buttons and the items are localized (en-US, pt-BR) and are what TalkBack
 *   reads; each item is "product name, cable n", so identical cables stay distinguishable, and the
 *   platform's checkable rows announce their checked state;
 * - every row and button is at least [MIN_TOUCH_TARGET_DP] dp high;
 * - Connect returns the checked devices; Cancel, Back, a touch outside, an empty choice and a
 *   dismissal by the system all return an empty list.
 *
 * @param activity the activity to show the dialog on; null or finishing means "cancelled".
 * @param main runs the dialog on the main thread.
 */
class DialogDevicePicker(private val activity: () -> Activity?, private val main: Executor) : DevicePicker {

    override fun pick(devices: List<UsbDeviceInfo>, onResult: (List<UsbDeviceInfo>) -> Unit) {
        main.execute { show(devices, onResult) }
    }

    /** Main thread. Returns the dialog shown, or null when there is no activity to show it on. */
    internal fun show(devices: List<UsbDeviceInfo>, onResult: (List<UsbDeviceInfo>) -> Unit): AlertDialog? {
        val host = activity()?.takeUnless { it.isFinishing || it.isDestroyed }
        if (host == null) {
            onResult(emptyList())
            return null
        }
        val checked = BooleanArray(devices.size)
        val answered = AtomicBoolean(false)
        fun answer(chosen: List<UsbDeviceInfo>) {
            if (answered.compareAndSet(false, true)) onResult(chosen)
        }
        val dialog = AlertDialog.Builder(host)
            .setTitle(R.string.usb_picker_title)
            .setMultiChoiceItems(labels(host, devices), checked) { _, which, isChecked -> checked[which] = isChecked }
            .setPositiveButton(R.string.usb_picker_connect) { _, _ ->
                answer(devices.filterIndexed { index, _ -> checked[index] })
            }
            .setNegativeButton(R.string.usb_picker_cancel) { _, _ -> answer(emptyList()) }
            .setOnDismissListener { answer(emptyList()) }
            .create()
        dialog.show()
        val minHeight = ceil(MIN_TOUCH_TARGET_DP * host.resources.displayMetrics.density).toInt()
        for (which in intArrayOf(DialogInterface.BUTTON_POSITIVE, DialogInterface.BUTTON_NEGATIVE)) {
            // Both buttons exist once the dialog is shown, since both were set on the builder.
            val button = dialog.getButton(which)
            button.minHeight = minHeight
            button.minimumHeight = minHeight
        }
        return dialog
    }

    companion object {
        /** Minimum height of every touch target of the picker (plan RNF7). */
        const val MIN_TOUCH_TARGET_DP: Int = 48

        /** Accessible label of each device: "product name, cable n" (n from 1). */
        fun labels(context: Context, devices: List<UsbDeviceInfo>): Array<CharSequence> =
            Array(devices.size) { index ->
                val name = devices[index].productName?.takeIf { it.isNotBlank() }
                    ?: context.getString(R.string.usb_picker_unnamed_device)
                context.getString(R.string.usb_picker_item, name, index + 1)
            }
    }
}
