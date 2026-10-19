package com.openauri.usb

import android.content.Context
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.JSObject
import com.openauri.app.BuildConfig
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class DiagnosticsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @After
    fun noSchemaViolations() {
        BridgeSchema.assertNoViolations()
    }

    @Test
    fun hexIsLowerCaseTwoDigitsPerByte() {
        assertEquals("", ByteArray(0).toHex())
        assertEquals("000ff0ff7f80", bytes(0x00, 0x0F, 0xF0, 0xFF, 0x7F, 0x80).toHex())
    }

    @Test
    fun reportDescriptorLengthIsReadFromTheHidDescriptorOfTheChosenInterface() {
        assertEquals(23, UsbDescriptors.hidReportDescriptorLength(rawDescriptors(23), 2, 0))
        assertEquals(0x1234, UsbDescriptors.hidReportDescriptorLength(rawDescriptors(0x1234), 2, 0))
        // The decoy HID descriptor that follows interface 0 belongs to interface 0 only.
        assertEquals(0x99, UsbDescriptors.hidReportDescriptorLength(rawDescriptors(23), 0, 0))
        assertNull(UsbDescriptors.hidReportDescriptorLength(rawDescriptors(23), 2, 1))
        assertNull(UsbDescriptors.hidReportDescriptorLength(rawDescriptors(23), 5, 0))
        assertNull(UsbDescriptors.hidReportDescriptorLength(rawDescriptors(0), 2, 0))
        assertNull(UsbDescriptors.hidReportDescriptorLength(FakeUsbBackend.DEFAULT_RAW_DESCRIPTORS, 2, 0))
    }

    @Test
    fun malformedRawDescriptorsYieldNoLength() {
        val full = rawDescriptors(23)
        val hidOffset = full.size - HID_AND_ENDPOINTS_BYTES
        val cases = mapOf(
            "empty" to ByteArray(0),
            "one byte" to bytes(0x09),
            "zero bLength" to bytes(0x00, 0x04, 0x02, 0x00),
            "truncated interface descriptor" to full.copyOf(hidOffset + 4),
            "truncated HID descriptor" to full.copyOf(hidOffset + INTERFACE_BYTES + 4),
            "short interface descriptor" to bytes(0x05, 0x04, 0x02, 0x00, 0x00) + hid(0x22, 0x10, 0x00),
            "HID descriptor before any interface" to hid(0x22, 0x10, 0x00),
            "HID descriptor without a length list" to hidInterface() + bytes(0x05, 0x21, 0x11, 0x01, 0x00),
            "no class descriptors" to hidInterface() + bytes(0x06, 0x21, 0x11, 0x01, 0x00, 0x00),
            "entry list cut short" to hidInterface() + bytes(0x09, 0x21, 0x11, 0x01, 0x00, 0x02, 0x23, 0x10, 0x00),
            "only a physical descriptor" to hidInterface() + bytes(0x09, 0x21, 0x11, 0x01, 0x00, 0x01, 0x23, 0x10, 0x00),
        )
        for ((name, raw) in cases) {
            assertNull(name, UsbDescriptors.hidReportDescriptorLength(raw, 2, 0))
        }
        val second = hidInterface() + bytes(0x0C, 0x21, 0x11, 0x01, 0x00, 0x02, 0x23, 0x10, 0x00, 0x22, 0x40, 0x00)
        assertEquals(0x40, UsbDescriptors.hidReportDescriptorLength(second, 2, 0))
    }

    @Test
    fun wireLogIsARingBufferOfTheLastBuffers() {
        val log = WireLog(capacity = 2)
        assertEquals(0, log.toJson().length())
        log.record(10, bytes(0x01))
        log.record(20, bytes(0x02))
        log.record(30, bytes(0xCB, 0xFF))
        val entries = log.toJson()
        assertEquals(2, entries.length())
        assertEquals(20L, entries.getJSONObject(0).getLong("atMs"))
        assertEquals("02", entries.getJSONObject(0).getString("hex"))
        assertEquals(30L, entries.getJSONObject(1).getLong("atMs"))
        assertEquals("cbff", entries.getJSONObject(1).getString("hex"))
        assertEquals(256, WireLog.CAPACITY)
        assertThrows(IllegalArgumentException::class.java) { WireLog(capacity = 0) }
    }

    @Test
    fun appInfoReportsBuildAndroidWebViewAndTheUsbHostFeature() {
        val packages = shadowOf(context.packageManager)
        packages.setSystemFeature(PackageManager.FEATURE_USB_HOST, true)
        val info = AppInfo.from(context)
        assertEquals(BuildConfig.VERSION_NAME, info.appVersion)
        assertTrue(info.androidVersion, info.androidVersion.endsWith("(API 36)"))
        assertTrue(info.webViewVersion.isNotBlank())
        assertTrue(info.usbHost)
        packages.setSystemFeature(PackageManager.FEATURE_USB_HOST, false)
        assertFalse(info.usbHost)

        assertEquals(AppInfo.UNKNOWN, AppInfo("1", "16", { null }, { false }).webViewVersion)
        assertEquals(AppInfo.UNKNOWN, AppInfo("1", "16", { " " }, { false }).webViewVersion)
        assertEquals("140.0", AppInfo("1", "16", { "140.0" }, { false }).webViewVersion)
    }

    @Test
    fun diagnosticsJsonFollowsAnexoBAndCarriesTheWireLogOnlyWhenGiven() {
        val hid = UsbInterfaceInfo(
            id = 3,
            alternateSetting = 0,
            interfaceClass = UsbBackend.CLASS_HID,
            interfaceSubclass = 0,
            interfaceProtocol = 0,
            endpoints = listOf(
                UsbEndpointInfo(0x00, 0x00, 8, 0),
                UsbEndpointInfo(0x81, 0x01, 192, 1),
                UsbEndpointInfo(0x02, 0x02, 512, 0),
                UsbEndpointInfo(0x83, 0x03, 64, 1),
            ),
        )
        val descriptor = HidReportDescriptor.parse(twoOutputReports)
        val device = JSObject().put("key", "/dev/bus/usb/001/002#1").put("vendorId", 0x3302)
            .put("productId", 0x8902).put("productName", "USB DSP Audio")
        val info = AppInfo("1.0.0", "16 (API 36)", { null }, { true })
        val raw = rawDescriptors(twoOutputReports.size)
        val control = UsbDiagnostics.build(device, info, raw, hid, twoOutputReports, descriptor, null, true, null)
        BridgeSchema.check("UsbDiagnostics", control.toString(), "control diagnostics")
        assertEquals("control", control.getString("transfer"))
        assertEquals(64, control.getInt("paddedLength"))
        assertEquals(3, control.getInt("hidInterfaceId"))
        assertTrue(control.getBoolean("kernelDriverDetached"))
        assertEquals("unknown", control.getString("webViewVersion"))
        assertEquals(raw.toHex(), control.getString("rawDescriptorsHex"))
        assertEquals(twoOutputReports.toHex(), control.getString("reportDescriptorHex"))
        assertFalse(control.has("wireLog"))
        val endpoints = control.getJSONArray("endpoints")
        assertEquals(
            listOf("control", "isochronous", "bulk", "interrupt"),
            List(endpoints.length()) { endpoints.getJSONObject(it).getString("type") },
        )
        assertEquals(
            listOf("out", "in", "out", "in"),
            List(endpoints.length()) { endpoints.getJSONObject(it).getString("direction") },
        )
        assertEquals(512, endpoints.getJSONObject(2).getInt("maxPacketSize"))
        val outputs = control.getJSONArray("outputReports")
        assertEquals(listOf(0x02 to 63, 0xCB to 31), List(outputs.length()) {
            outputs.getJSONObject(it).getInt("reportId") to outputs.getJSONObject(it).getInt("bytes")
        })

        val log = WireLog().apply { record(42, bytes(0xCB, 0x00)) }
        val interrupt = UsbDiagnostics.build(device, info, raw, hid, twoOutputReports, descriptor, hid.endpoints[3], false, log)
        BridgeSchema.check("UsbDiagnostics", interrupt.toString(), "interrupt diagnostics")
        assertEquals("interrupt", interrupt.getString("transfer"))
        assertEquals("cb00", interrupt.getJSONArray("wireLog").getJSONObject(0).getString("hex"))
    }

    companion object {
        private const val INTERFACE_BYTES = 9

        /** Bytes of the HID interface descriptor, its HID descriptor and its two endpoints. */
        private const val HID_AND_ENDPOINTS_BYTES = INTERFACE_BYTES + 9 + 7 + 7

        /**
         * Raw descriptors of the cable: device, configuration, audio interface 0 followed by a
         * decoy HID descriptor (report length 0x99), then HID interface [interfaceId] whose HID
         * descriptor declares a report descriptor of [reportLength] bytes, and its endpoints.
         */
        fun rawDescriptors(reportLength: Int, interfaceId: Int = FakeUsbBackend.HID_INTERFACE_ID): ByteArray =
            FakeUsbBackend.DEFAULT_RAW_DESCRIPTORS +
                bytes(0x09, 0x02, 0x3B, 0x00, 0x02, 0x01, 0x00, 0x80, 0x32) +
                bytes(0x09, 0x04, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00) +
                hid(0x22, 0x99, 0x00) +
                hidInterface(interfaceId) +
                hid(0x22, reportLength and 0xFF, reportLength ushr 8) +
                bytes(0x07, 0x05, 0x83, 0x03, 0x40, 0x00, 0x01) +
                bytes(0x07, 0x05, 0x04, 0x03, 0x40, 0x00, 0x01)

        /** Output report 0xCB of 31 bytes and output report 0x02 of 63 bytes: 64 on the wire. */
        val twoOutputReports: ByteArray = bytes(
            0x06, 0x00, 0xFF, 0x09, 0x01, 0xA1, 0x01,
            0x85, 0xCB, 0x75, 0x08, 0x95, 0x1F, 0x09, 0x01, 0x91, 0x02,
            0x85, 0x02, 0x95, 0x3F, 0x09, 0x01, 0x91, 0x02,
            0xC0,
        )

        /** One output report 0x01 of 31 bytes and no report 0xCB. */
        val vendorReportOnly: ByteArray = bytes(
            0x06, 0x00, 0xFF, 0x09, 0x01, 0xA1, 0x01,
            0x85, 0x01, 0x75, 0x08, 0x95, 0x1F, 0x09, 0x01, 0x91, 0x02,
            0xC0,
        )

        private fun hidInterface(interfaceId: Int = FakeUsbBackend.HID_INTERFACE_ID): ByteArray =
            bytes(0x09, 0x04, interfaceId, 0x00, 0x02, 0x03, 0x00, 0x00, 0x00)

        /** A 9-byte HID descriptor with one class descriptor entry. */
        private fun hid(type: Int, low: Int, high: Int): ByteArray =
            bytes(0x09, 0x21, 0x11, 0x01, 0x00, 0x01, type, low, high)

        private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }
    }
}
