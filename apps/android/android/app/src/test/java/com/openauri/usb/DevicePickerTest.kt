package com.openauri.usb

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.DialogInterface
import android.os.Looper
import android.widget.ListView
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlertDialog
import java.util.concurrent.Executor

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class DevicePickerTest {
    private val cables = listOf("/dev/bus/usb/001/002", "/dev/bus/usb/001/003", "/dev/bus/usb/002/004")
        .map { FakeUsbBackend.cable(it) }
    private val direct = Executor { it.run() }

    private fun activity(): Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    /** Shows the picker for [devices]; the answers it gives are appended to [answers]. */
    private fun show(devices: List<UsbDeviceInfo>, answers: MutableList<List<UsbDeviceInfo>>): AlertDialog {
        val host = activity()
        val dialog = DialogDevicePicker({ host }, direct).show(devices) { answers += it }
        return checkNotNull(dialog) { "the picker showed no dialog" }
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun click(dialog: AlertDialog, which: Int) {
        dialog.getButton(which).performClick()
        idle()
    }

    @Test
    fun labelsNameEveryCableAndFallBackForUnnamedDevices() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val unnamed = UsbDeviceInfo("/dev/bus/usb/003/001", 1, 2, null, null, emptyList())
        val blank = UsbDeviceInfo("/dev/bus/usb/003/002", 1, 2, " ", null, emptyList())
        assertEquals(
            listOf("USB DSP Audio, cable 1", "USB device, cable 2", "USB device, cable 3"),
            DialogDevicePicker.labels(context, listOf(cables[0], unnamed, blank)).map { it.toString() },
        )
    }

    @Test
    fun twoCablesConnectReturnsTheCheckedOneOnce() {
        val answers = mutableListOf<List<UsbDeviceInfo>>()
        val dialog = show(cables.take(2), answers)
        assertTrue(dialog.isShowing)
        assertEquals(ListView.CHOICE_MODE_MULTIPLE, dialog.listView.choiceMode)
        val shadow = shadowOf(dialog)
        assertEquals("Choose the cables to connect", shadow.title.toString())
        assertEquals(listOf("USB DSP Audio, cable 1", "USB DSP Audio, cable 2"), shadow.items.map { it.toString() })
        assertEquals("Connect", dialog.getButton(DialogInterface.BUTTON_POSITIVE).text.toString())
        assertEquals("Cancel", dialog.getButton(DialogInterface.BUTTON_NEGATIVE).text.toString())
        shadow.clickOnItem(1)
        click(dialog, DialogInterface.BUTTON_POSITIVE)
        assertFalse(dialog.isShowing)
        assertEquals(listOf(listOf(cables[1])), answers)
    }

    @Test
    fun threeCablesCanBeChosenTogetherAndUnchecked() {
        val answers = mutableListOf<List<UsbDeviceInfo>>()
        val dialog = show(cables, answers)
        val shadow = shadowOf(dialog)
        shadow.clickOnItem(0)
        shadow.clickOnItem(1)
        shadow.clickOnItem(2)
        shadow.clickOnItem(1)
        click(dialog, DialogInterface.BUTTON_POSITIVE)
        assertEquals(listOf(listOf(cables[0], cables[2])), answers)
    }

    @Test
    fun cancelBackAndAnEmptyChoiceAllAnswerNothing() {
        val cancelled = mutableListOf<List<UsbDeviceInfo>>()
        val cancelDialog = show(cables, cancelled)
        shadowOf(cancelDialog).clickOnItem(0)
        click(cancelDialog, DialogInterface.BUTTON_NEGATIVE)
        assertEquals(listOf(emptyList<UsbDeviceInfo>()), cancelled)

        val back = mutableListOf<List<UsbDeviceInfo>>()
        val backDialog = show(cables.take(2), back)
        backDialog.cancel()
        idle()
        assertEquals(listOf(emptyList<UsbDeviceInfo>()), back)

        val none = mutableListOf<List<UsbDeviceInfo>>()
        val noneDialog = show(cables.take(2), none)
        click(noneDialog, DialogInterface.BUTTON_POSITIVE)
        assertEquals(listOf(emptyList<UsbDeviceInfo>()), none)
    }

    @Test
    fun everyTouchTargetIsAtLeast48dp() {
        val dialog = show(cables, mutableListOf())
        val minimum = 48 * dialog.context.resources.displayMetrics.density
        for (which in listOf(DialogInterface.BUTTON_POSITIVE, DialogInterface.BUTTON_NEGATIVE)) {
            val button = dialog.getButton(which)
            assertTrue(button.minHeight >= minimum)
            assertTrue(button.minimumHeight >= minimum)
        }
        val list = dialog.listView
        for (index in cables.indices) {
            val row = list.adapter.getView(index, null, list)
            assertTrue("row $index is ${row.minimumHeight}px", row.minimumHeight >= minimum)
        }
    }

    @Test
    fun noActivityOrAFinishingOneAnswersNothingWithoutADialog() {
        val answers = mutableListOf<List<UsbDeviceInfo>>()
        assertNull(DialogDevicePicker({ null }, direct).show(cables) { answers += it })
        val finishing = activity().also { it.finish() }
        assertNull(DialogDevicePicker({ finishing }, direct).show(cables) { answers += it })
        val destroyed = Robolectric.buildActivity(Activity::class.java).setup().pause().stop().destroy().get()
        assertFalse(destroyed.isFinishing)
        assertNull(DialogDevicePicker({ destroyed }, direct).show(cables) { answers += it })
        assertEquals(listOf(emptyList<UsbDeviceInfo>(), emptyList(), emptyList()), answers)
    }

    @Test
    fun pickShowsTheDialogThroughTheMainExecutor() {
        val posted = mutableListOf<Runnable>()
        val host = activity()
        val answers = mutableListOf<List<UsbDeviceInfo>>()
        DialogDevicePicker({ host }, Executor { posted += it }).pick(cables.take(2)) { answers += it }
        assertEquals(1, posted.size)
        assertTrue(answers.isEmpty())
        posted.single().run()
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertTrue(dialog.isShowing)
        click(dialog, DialogInterface.BUTTON_NEGATIVE)
        assertEquals(listOf(emptyList<UsbDeviceInfo>()), answers)
    }

    @Test
    @Config(qualifiers = "pt-rBR")
    fun pickerIsLocalizedInBrazilianPortuguese() {
        val dialog = show(cables.take(2), mutableListOf())
        val shadow = shadowOf(dialog)
        assertEquals("Escolha os cabos para conectar", shadow.title.toString())
        assertEquals("USB DSP Audio, cabo 2", shadow.items[1].toString())
        assertEquals("Conectar", dialog.getButton(DialogInterface.BUTTON_POSITIVE).text.toString())
        assertEquals("Cancelar", dialog.getButton(DialogInterface.BUTTON_NEGATIVE).text.toString())
        val unnamed = UsbDeviceInfo("/dev/bus/usb/003/001", 1, 2, null, null, emptyList())
        assertEquals("Dispositivo USB, cabo 1", DialogDevicePicker.labels(dialog.context, listOf(unnamed))[0].toString())
    }
}
