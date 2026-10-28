package com.openauri.usb

import android.content.Context
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.openauri.app.BuildConfig
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.Base64
import java.util.Collections
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/** Executor that runs tasks inline, or holds them until [runAll] when [queued]. */
internal class TestWorker : AbstractExecutorService() {
    private val tasks = ArrayDeque<Runnable>()

    @Volatile var queued: Boolean = false

    @Volatile var rejecting: Boolean = false

    @Volatile private var stopped = false

    val pending: Int
        get() = synchronized(tasks) { tasks.size }

    override fun execute(command: Runnable) {
        if (stopped || rejecting) throw RejectedExecutionException("worker refuses work")
        if (queued) synchronized(tasks) { tasks.addLast(command) } else command.run()
    }

    fun runAll() {
        while (true) {
            val next = synchronized(tasks) { tasks.removeFirstOrNull() } ?: return
            next.run()
        }
    }

    override fun shutdown() {
        stopped = true
    }

    override fun shutdownNow(): MutableList<Runnable> {
        shutdown()
        return synchronized(tasks) { tasks.toMutableList().also { tasks.clear() } }
    }

    override fun isShutdown(): Boolean = stopped

    override fun isTerminated(): Boolean = stopped && pending == 0

    override fun awaitTermination(timeout: Long, unit: TimeUnit): Boolean = isTerminated
}

/** Runs immediate tasks at once (the stop release) and keeps delayed ones (the idle release) pending. */
internal class TestScheduler : ClaimManager.Scheduler {
    val delayed: MutableList<Runnable> = Collections.synchronizedList(mutableListOf())

    override fun schedule(delayMs: Long, task: Runnable): ClaimManager.Scheduled {
        if (delayMs == 0L) {
            task.run()
            return ClaimManager.Scheduled {}
        }
        delayed += task
        return ClaimManager.Scheduled { delayed -= task }
    }
}

/** [FakeUsbBackend] with the failures it cannot produce itself. */
internal class ScriptedBackend(private val fake: FakeUsbBackend) : UsbBackend by fake {
    @Volatile var beforeClaim: () -> Unit = {}

    @Volatile var closeError: Exception? = null

    @Volatile var permissionError: RuntimeException? = null

    /** Index (from 0) of the [list] call that fails, if any. */
    @Volatile var failListAt: Int? = null

    /** Bytes the interrupt route leaves unsent. */
    @Volatile var shortBy: Int = 0

    private var listCalls = 0

    override fun close(connection: UsbConnectionHandle) {
        closeError?.let { throw it }
        fake.close(connection)
    }

    override fun requestPermission(device: UsbDeviceInfo, callback: PermissionCallback) {
        permissionError?.let { throw it }
        fake.requestPermission(device, callback)
    }

    @Synchronized
    override fun list(filters: List<UsbFilter>): List<UsbDeviceInfo> {
        if (listCalls++ == failListAt) throw UsbFailure.Closed("injected list failure", null)
        return fake.list(filters)
    }

    override fun transferInterrupt(
        connection: UsbConnectionHandle,
        endpoint: UsbEndpointInfo,
        buffer: ByteArray,
        timeoutMs: Int,
    ): Int = fake.transferInterrupt(connection, endpoint, buffer, timeoutMs) - shortBy

    override fun claim(connection: UsbConnectionHandle, usbInterface: UsbInterfaceInfo, force: Boolean): Boolean {
        beforeClaim()
        return fake.claim(connection, usbInterface, force)
    }
}

/**
 * One [OpenAuriUsbPlugin] wired to a [FakeUsbBackend], a virtual clock, a controllable origin, a
 * scripted picker and listeners for both events. Every call goes through a [BridgeCall], so every
 * answer is checked against the bridge schema.
 */
internal class UsbPluginHarness(
    devices: List<UsbDeviceInfo> = listOf(FakeUsbBackend.cable()),
    val isDebug: Boolean = false,
    info: AppInfo = AppInfo("1.2.3", "16 (API 36)", { "140.0.7339.0" }, { true }),
    wrap: (FakeUsbBackend) -> UsbBackend = { it },
    workerOverride: ExecutorService? = null,
    val commitSpacing: CommitSpacingStore = CommitSpacingStore(),
) {
    val fake = FakeUsbBackend(devices)
    val backend: UsbBackend = wrap(fake)
    val journal: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val worker = TestWorker()
    val scheduler = TestScheduler()
    val claims = ClaimManager(backend, scheduler, ClaimManager.IDLE_RELEASE_MS)

    @Volatile var nowMs: Long = 100_000L

    @Volatile var pageUrl: String? = PAGE

    @Volatile var pinnedUrl: String? = PINNED

    /** What the picker answers when offered several devices. */
    var choose: (List<UsbDeviceInfo>) -> List<UsbDeviceInfo> = { it }

    /** Device keys offered to the picker, one list per dialog. */
    val offered: MutableList<List<String>> = mutableListOf()

    val backgroundErrors: MutableList<Throwable> = Collections.synchronizedList(mutableListOf())

    private val picker = DevicePicker { offer, onResult ->
        offered += offer.map { it.key }
        onResult(choose(offer))
    }

    val plugin = OpenAuriUsbPlugin(
        OpenAuriUsbPlugin.Environment(
            backend = backend,
            claims = claims,
            origin = OriginGuard({ pinnedUrl }, { pageUrl }),
            picker = picker,
            info = info,
            worker = workerOverride ?: worker,
            clock = { nowMs },
            isDebug = isDebug,
            onBackgroundError = { backgroundErrors += it },
            commitSpacing = commitSpacing,
        ),
    ).also { it.load() }

    val connects = ListenerCall(OpenAuriUsbPlugin.EVENT_CONNECT, journal)
    val disconnects = ListenerCall(OpenAuriUsbPlugin.EVENT_DISCONNECT, journal)

    init {
        plugin.addListener(connects)
        plugin.addListener(disconnects)
    }

    fun call(method: String, data: JSObject = JSObject(), validRequest: Boolean? = true): BridgeCall =
        BridgeCall(method, data, journal, validRequest).also(::invoke)

    fun invoke(call: BridgeCall) {
        when (call.methodName) {
            "getInfo" -> plugin.getInfo(call)
            "requestDevice" -> plugin.requestDevice(call)
            "getDevices" -> plugin.getDevices(call)
            "open" -> plugin.open(call)
            "close" -> plugin.close(call)
            "sendReport" -> plugin.sendReport(call)
            "diagnostics" -> plugin.diagnostics(call)
            "addListener" -> plugin.addListener(call)
            "removeListener" -> plugin.removeListener(call)
            "removeAllListeners" -> plugin.removeAllListeners(call)
            else -> throw AssertionError("unknown method ${call.methodName}")
        }
    }

    fun requestDevice(filters: List<JSObject> = listOf(cb5100Filter())): BridgeCall {
        val array = JSArray()
        filters.forEach { array.put(it) }
        return call("requestDevice", JSObject().put("filters", array))
    }

    fun open(key: String): BridgeCall = call("open", JSObject().put("key", key))

    fun close(key: String): BridgeCall = call("close", JSObject().put("key", key))

    fun diagnostics(key: String): BridgeCall = call("diagnostics", JSObject().put("key", key))

    fun send(key: String, reportId: Int, data: ByteArray): BridgeCall =
        call("sendReport", JSObject().put("key", key).put("reportId", reportId).put("data", base64(data)))

    /** Grants and opens the first matching cable; returns its key. */
    fun connectFirst(): String {
        choose = { listOf(it.first()) }
        val key = requestDevice().deviceKeys().first()
        assertTrue("open $key", open(key).resolved)
        return key
    }

    /** The 9 data reports and the commit of [curve], with the transport's timing. */
    fun writeCurve(key: String, curve: ProtocolFixtureTest.Curve): List<BridgeCall> {
        val calls = curve.reports.map { report ->
            send(key, ProtocolConstants.HID_REPORT_ID, report).also { nowMs += ProtocolFixtureTest.reportGapMs }
        }
        nowMs += ProtocolFixtureTest.settleMs
        return calls + send(key, ProtocolConstants.HID_REPORT_ID, ProtocolConstants.commitReport())
    }

    /** Number of backend calls so far (every one is I/O or a permission dialog). */
    fun ioCount(): Int = fake.calls.size + fake.permissionRequests

    companion object {
        const val PINNED: String = "https://open-auri.com"
        const val PAGE: String = "https://open-auri.com/cabo?tab=gravar#x"

        fun cb5100Filter(): JSObject = JSObject().put("vendorId", 0x3302).put("productId", 0x8902)

        fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

        /** [0xCB] + [data], as the interrupt and control routes must put it on the wire. */
        fun wire(data: ByteArray, paddedLength: Int = 32): ByteArray =
            (byteArrayOf(ProtocolConstants.HID_REPORT_ID.toByte()) + data).copyOf(paddedLength)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class OpenAuriUsbPluginTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val neutral = ProtocolFixtureTest.neutral
    private val commit = ProtocolConstants.commitReport()

    @After
    fun noSchemaViolations() {
        BridgeSchema.assertNoViolations()
    }

    @Test
    fun pluginIsCapacitorsOpenAuriUsbWithEveryMethodExported() {
        assertEquals("OpenAuriUsb", OpenAuriUsbPlugin::class.java.getAnnotation(CapacitorPlugin::class.java)?.name)
        assertNotNull(OpenAuriUsbPlugin::class.java.getConstructor())
        val exported = OpenAuriUsbPlugin::class.java.declaredMethods
            .filter { it.isAnnotationPresent(PluginMethod::class.java) }
            .associate { it.name to it.getAnnotation(PluginMethod::class.java)?.returnType }
        val bridgeMethods = listOf("getInfo", "requestDevice", "getDevices", "open", "close", "sendReport", "diagnostics")
        bridgeMethods.forEach { assertEquals(it, PluginMethod.RETURN_PROMISE, exported[it]) }
        assertEquals(PluginMethod.RETURN_NONE, exported["addListener"])
        assertEquals(PluginMethod.RETURN_NONE, exported["removeListener"])
        assertEquals(PluginMethod.RETURN_PROMISE, exported["removeAllListeners"])
    }

    @Test
    fun getInfoReportsBridgeApiVersionsAndTheUsbHostFeature() {
        val packages = shadowOf(context.packageManager)
        for (feature in listOf(true, false)) {
            packages.setSystemFeature(PackageManager.FEATURE_USB_HOST, feature)
            val info = UsbPluginHarness(info = AppInfo.from(context)).call("getInfo").payload
            assertNotNull(info)
            checkNotNull(info)
            assertEquals(1, info.getInt("bridgeApi"))
            assertEquals(BuildConfig.VERSION_NAME, info.getString("appVersion"))
            assertEquals(feature, info.getBoolean("usbHost"))
            assertTrue(info.getString("webViewVersion").orEmpty().isNotBlank())
            assertEquals(true, info.getBoolean("liveApply"))
        }
        val injected = UsbPluginHarness().call("getInfo").payload
        assertEquals("140.0.7339.0", injected?.getString("webViewVersion"))
    }

    @Test
    fun requestDeviceWithNoMatchResolvesEmptyWithoutAskingPermission() {
        val harness = UsbPluginHarness()
        val call = harness.requestDevice(listOf(JSObject().put("vendorId", 0x1234)))
        assertEquals(emptyList<String>(), call.deviceKeys())
        assertEquals(0, harness.fake.permissionRequests)
        assertTrue(harness.offered.isEmpty())
    }

    @Test
    fun requestDeviceWithOneCableAsksPermissionAndReportsTheDevice() {
        val harness = UsbPluginHarness()
        val call = harness.requestDevice()
        assertEquals(1, harness.fake.permissionRequests)
        assertTrue(harness.offered.isEmpty())
        val device = call.payload?.getJSONArray("devices")?.getJSONObject(0)
        checkNotNull(device)
        assertEquals("/dev/bus/usb/001/002#1", device.getString("key"))
        assertEquals(0x3302, device.getInt("vendorId"))
        assertEquals(0x8902, device.getInt("productId"))
        assertEquals("USB DSP Audio", device.getString("productName"))
        // The key is stable while the cable stays attached.
        assertEquals(listOf("/dev/bus/usb/001/002#1"), harness.requestDevice().deviceKeys())
        assertTrue(harness.fake.calls.isEmpty())
    }

    @Test
    fun deniedPermissionResolvesEmptyLikeTheWebHidChooser() {
        val harness = UsbPluginHarness()
        harness.fake.faults.permissionDenied = true
        assertEquals(emptyList<String>(), harness.requestDevice().deviceKeys())
        assertEquals(1, harness.fake.permissionRequests)
        assertEquals(emptyList<String>(), harness.call("getDevices").deviceKeys())
    }

    @Test
    fun pickerWithTwoAndThreeCablesAsksPermissionOnlyForTheChosenOnes() {
        val cables = listOf("/dev/bus/usb/001/002", "/dev/bus/usb/001/003", "/dev/bus/usb/002/004").map { FakeUsbBackend.cable(it) }
        val two = UsbPluginHarness(devices = cables.take(2))
        two.choose = { offer -> listOf(offer[1]) }
        assertEquals(listOf("/dev/bus/usb/001/003#1"), two.requestDevice().deviceKeys())
        assertEquals(listOf(cables.take(2).map { it.key }), two.offered)
        assertEquals(1, two.fake.permissionRequests)

        val three = UsbPluginHarness(devices = cables)
        three.choose = { offer -> listOf(offer[0], offer[2]) }
        assertEquals(listOf("/dev/bus/usb/001/002#1", "/dev/bus/usb/002/004#2"), three.requestDevice().deviceKeys())
        assertEquals(listOf(cables.map { it.key }), three.offered)
        assertEquals(2, three.fake.permissionRequests)
        assertEquals(listOf("/dev/bus/usb/001/002#1", "/dev/bus/usb/002/004#2"), three.call("getDevices").deviceKeys())

        val cancelled = UsbPluginHarness(devices = cables)
        cancelled.choose = { emptyList() }
        assertEquals(emptyList<String>(), cancelled.requestDevice().deviceKeys())
        assertEquals(0, cancelled.fake.permissionRequests)
    }

    @Test
    fun pickerResultKeepsOnlyGrantedAndStillAttachedDevices() {
        val cables = listOf("/dev/bus/usb/001/002", "/dev/bus/usb/001/003").map { FakeUsbBackend.cable(it) }
        val harness = UsbPluginHarness(devices = cables)
        harness.fake.grant(cables[1])
        harness.fake.faults.permissionDenied = true
        assertEquals(listOf("/dev/bus/usb/001/003#1"), harness.requestDevice().deviceKeys())

        val unplugged = UsbPluginHarness(devices = cables)
        unplugged.choose = { offer ->
            unplugged.fake.detach(offer[0].key)
            offer
        }
        assertEquals(listOf("/dev/bus/usb/001/003#1"), unplugged.requestDevice().deviceKeys())
    }

    @Test
    fun requestDeviceIntersectsEveryFilterWithTheCb5100Identity() {
        val mouse = UsbDeviceInfo("/dev/bus/usb/003/001", 0x046D, 0xC077, null, null, emptyList())
        val harness = UsbPluginHarness(devices = listOf(FakeUsbBackend.cable(), mouse))
        harness.choose = { it }
        val cableKeys = listOf("/dev/bus/usb/001/002#1")
        for (filters in listOf(emptyList(), listOf(JSObject()), listOf(JSObject().put("vendorId", 0x3302)))) {
            assertEquals(cableKeys, harness.requestDevice(filters).deviceKeys())
        }
        for (filter in listOf(JSObject().put("productId", 0xC077), JSObject().put("vendorId", 0x046D))) {
            assertTrue(harness.requestDevice(listOf(filter)).deviceKeys().isEmpty())
        }
        assertTrue(harness.offered.isEmpty())
        assertFalse(harness.fake.hasPermission(mouse))
        assertEquals(listOf("/dev/bus/usb/001/002#1"), harness.call("getDevices").deviceKeys())
    }

    @Test
    fun malformedFiltersAreBadArgs() {
        val harness = UsbPluginHarness()
        val bad = listOf(
            JSObject(),
            JSObject().put("filters", "x"),
            JSObject().put("filters", JSArray().put(5)),
            JSObject().put("filters", JSArray().put(JSObject().put("usagePage", 0xFF00))),
            JSObject().put("filters", JSArray().put(JSObject().put("vendorId", 0x10000))),
            JSObject().put("filters", JSArray().put(JSObject().put("vendorId", -1))),
            JSObject().put("filters", JSArray().put(JSObject().put("productId", "x"))),
            JSObject().put("filters", JSArray().put(JSObject().put("vendorId", JSONObject.NULL))),
        )
        for (data in bad) {
            assertEquals(data.toString(), ErrorCodes.USB_BAD_ARGS, harness.call("requestDevice", data, validRequest = false).code)
        }
        assertEquals(0, harness.ioCount())
    }

    @Test
    fun withoutUsbHostRequestDeviceAndGetDevicesFailWithNoHost() {
        val harness = UsbPluginHarness()
        harness.fake.hostSupported = false
        assertEquals(ErrorCodes.USB_NO_HOST, harness.requestDevice().code)
        assertEquals(ErrorCodes.USB_NO_HOST, harness.call("getDevices").code)
        assertEquals(0, harness.ioCount())
    }

    @Test
    fun permissionFailuresThrownByThePlatformRejectTheRequest() {
        val one = UsbPluginHarness(wrap = ::ScriptedBackend)
        (one.backend as ScriptedBackend).permissionError = SecurityException("no permission dialog")
        val single = one.requestDevice()
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, single.code)
        assertEquals("no permission dialog", single.message)

        val cables = listOf("/dev/bus/usb/001/002", "/dev/bus/usb/001/003").map { FakeUsbBackend.cable(it) }
        val many = UsbPluginHarness(devices = cables, wrap = ::ScriptedBackend)
        (many.backend as ScriptedBackend).permissionError = IllegalStateException("broken")
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, many.requestDevice().code)

        val listing = UsbPluginHarness(wrap = ::ScriptedBackend)
        (listing.backend as ScriptedBackend).failListAt = 1
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, listing.requestDevice().code)
    }

    @Test
    fun openReadsAndParsesTheDescriptorOnceAndIsIdempotent() {
        val harness = UsbPluginHarness()
        val key = harness.connectFirst()
        assertEquals(listOf("open", "rawDescriptors", "hidReportDescriptor 2"), harness.fake.calls)
        assertTrue(harness.open(key).resolved)
        assertEquals(3, harness.fake.calls.size)
    }

    @Test
    fun openChecksKeyAndPermissionBeforeAnyIo() {
        val harness = UsbPluginHarness()
        for (data in listOf(JSObject(), JSObject().put("key", ""), JSObject().put("key", 7))) {
            assertEquals(ErrorCodes.USB_BAD_ARGS, harness.call("open", data, validRequest = false).code)
        }
        assertEquals(ErrorCodes.USB_NOT_FOUND, harness.open("/dev/bus/usb/009/009#9").code)
        harness.fake.attach(FakeUsbBackend.cable("/dev/bus/usb/001/005"))
        val unpermitted = harness.connects.keys.single()
        assertEquals(ErrorCodes.USB_PERMISSION_DENIED, harness.open(unpermitted).code)
        assertEquals(0, harness.ioCount())
    }

    @Test
    fun openFailuresRejectWithTheirCodeAndCloseTheConnection() {
        val malformed = UsbPluginHarness()
        malformed.fake.faults.reportDescriptor = byteArrayOf(0xA1.toByte(), 0x01)
        malformed.choose = { it }
        val key = malformed.requestDevice().deviceKeys().single()
        val failed = malformed.open(key)
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, failed.code)
        assertTrue(failed.message.orEmpty().startsWith("malformed HID report descriptor"))
        assertEquals("close", malformed.fake.calls.last())
        assertEquals(ErrorCodes.USB_NOT_OPEN, malformed.send(key, 0xCB, neutral.reports[0]).code)

        val audioOnly = UsbDeviceInfo(
            "/dev/bus/usb/001/007", 0x3302, 0x8902, "USB DSP Audio", null,
            listOf(UsbInterfaceInfo(0, 0, UsbBackend.CLASS_AUDIO, 1, 0, emptyList())),
        )
        val noHid = UsbPluginHarness(devices = listOf(audioOnly))
        val noHidKey = noHid.requestDevice().deviceKeys().single()
        assertEquals(ErrorCodes.USB_NOT_FOUND, noHid.open(noHidKey).code)
        assertEquals(listOf("open", "close"), noHid.fake.calls)

        val refused = UsbPluginHarness()
        val refusedKey = refused.requestDevice().deviceKeys().single()
        refused.fake.faults.openError = UsbFailure.OpenFailed("/dev/bus/usb/001/002")
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, refused.open(refusedKey).code)

        val stuck = UsbPluginHarness(wrap = ::ScriptedBackend)
        stuck.fake.faults.reportDescriptor = byteArrayOf(0xC0.toByte())
        (stuck.backend as ScriptedBackend).closeError = UsbFailure.Closed("lane gone", null)
        val stuckKey = stuck.requestDevice().deviceKeys().single()
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, stuck.open(stuckKey).code)
        assertFalse("close" in stuck.fake.calls)
    }

    @Test
    fun reportDescriptorLengthComesFromTheHidDescriptorWhenDeclared() {
        val declared = UsbPluginHarness()
        declared.fake.faults.rawDescriptors = DiagnosticsTest.rawDescriptors(reportLength = 10)
        val shortKey = declared.requestDevice().deviceKeys().single()
        // Only 10 of the 23 descriptor bytes are read, so the parse fails: the declared length was used.
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, declared.open(shortKey).code)

        val exact = UsbPluginHarness()
        exact.fake.faults.rawDescriptors = DiagnosticsTest.rawDescriptors(reportLength = FakeUsbBackend.DEFAULT_REPORT_DESCRIPTOR.size)
        val key = exact.connectFirst()
        assertEquals(FakeUsbBackend.DEFAULT_REPORT_DESCRIPTOR.toHex(), exact.diagnostics(key).payload?.getString("reportDescriptorHex"))
    }

    @Test
    fun detachDuringAQueuedOpenRejectsDetachedAndClosesTheConnection() {
        val harness = UsbPluginHarness()
        val key = harness.requestDevice().deviceKeys().single()
        harness.worker.queued = true
        val call = harness.open(key)
        harness.fake.detach("/dev/bus/usb/001/002")
        harness.fake.attach(FakeUsbBackend.cable())
        harness.worker.runAll()
        assertEquals(ErrorCodes.USB_DETACHED, call.code)
        assertEquals(listOf("event:disconnect:$key", "event:connect:/dev/bus/usb/001/002#2"), harness.journal.filter { it.startsWith("event:") })
        assertEquals("close", harness.fake.calls.last())
    }

    @Test
    fun closeResolvesDropsTheSessionAndIsIdempotent() {
        val harness = UsbPluginHarness()
        val key = harness.connectFirst()
        harness.send(key, 0xCB, neutral.reports[0])
        assertTrue(harness.close(key).resolved)
        assertEquals("close", harness.fake.calls.last())
        assertEquals(ErrorCodes.USB_NOT_OPEN, harness.send(key, 0xCB, neutral.reports[1]).code)
        assertEquals(ErrorCodes.USB_NOT_OPEN, harness.diagnostics(key).code)
        assertTrue(harness.close(key).resolved)
        assertEquals(ErrorCodes.USB_NOT_FOUND, harness.close("/dev/bus/usb/009/009#9").code)
        // Reopening starts over: the sequence of the closed connection cannot be continued.
        assertTrue(harness.open(key).resolved)
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, neutral.reports[1]).code)

        val failing = UsbPluginHarness(wrap = ::ScriptedBackend)
        val failingKey = failing.connectFirst()
        (failing.backend as ScriptedBackend).closeError = UsbFailure.Closed("lane gone", null)
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, failing.close(failingKey).code)
    }

    @Test
    fun sendReportArgumentsAreCheckedBeforeAnything() {
        val harness = UsbPluginHarness()
        val key = harness.connectFirst()
        val before = harness.ioCount()
        val good = UsbPluginHarness.base64(neutral.reports[0])
        val bad = listOf(
            JSObject().put("reportId", 0xCB).put("data", good),
            JSObject().put("key", "").put("reportId", 0xCB).put("data", good),
            JSObject().put("key", 5).put("reportId", 0xCB).put("data", good),
            JSObject().put("key", key).put("data", good),
            JSObject().put("key", key).put("reportId", -1).put("data", good),
            JSObject().put("key", key).put("reportId", 256).put("data", good),
            JSObject().put("key", key).put("reportId", 1.5).put("data", good),
            JSObject().put("key", key).put("reportId", "203").put("data", good),
            JSObject().put("key", key).put("reportId", 1L shl 40).put("data", good),
            JSObject().put("key", key).put("reportId", 0xCB),
            JSObject().put("key", key).put("reportId", 0xCB).put("data", 123),
            JSObject().put("key", key).put("reportId", 0xCB).put("data", "A"),
            JSObject().put("key", key).put("reportId", 0xCB).put("data", "AA="),
            JSObject().put("key", key).put("reportId", 0xCB).put("data", "%%%%"),
            JSObject().put("key", key).put("reportId", 0xCB).put("data", "A".repeat(BridgeArgs.MAX_DATA_BASE64_LENGTH + 1)),
        )
        for (data in bad) {
            val call = harness.call("sendReport", data, validRequest = false)
            assertEquals(data.toString().take(120), ErrorCodes.USB_BAD_ARGS, call.code)
        }
        assertEquals(ErrorCodes.USB_NOT_FOUND, harness.send("/dev/bus/usb/009/009#9", 0xCB, neutral.reports[0]).code)
        assertEquals(before, harness.ioCount())
        // The guard saw none of them: the real sequence still starts at report 0.
        assertTrue(harness.send(key, 0xCB, neutral.reports[0]).resolved)
    }

    @Test
    fun fixtureWritesReachTheInterruptEndpointByteForByte() {
        val harness = UsbPluginHarness()
        val key = harness.connectFirst()
        writeAllCurves(harness, key)
        val expected = expectedWire()
        assertEquals(expected.size, harness.fake.sent.size)
        harness.fake.sent.forEachIndexed { index, sent ->
            assertArrayEquals("buffer $index", expected[index], sent.bytes)
            assertEquals(FakeUsbBackend.Route.INTERRUPT, sent.route)
            assertEquals(FakeUsbBackend.INTERRUPT_OUT_ADDRESS, sent.endpointAddress)
            assertNull(sent.setup)
            assertEquals(1000, sent.timeoutMs)
        }
        assertEquals(ProtocolFixtureTest.allCurves.size, harness.fake.sent.count { it.bytes.contentEquals(UsbPluginHarness.wire(commit)) })
    }

    @Test
    fun fixtureWritesUseSetReportWithoutAnInterruptOutEndpoint() {
        val harness = UsbPluginHarness(devices = listOf(FakeUsbBackend.cable(interruptOut = false)))
        val key = harness.connectFirst()
        writeAllCurves(harness, key)
        val expected = expectedWire()
        assertEquals(expected.size, harness.fake.sent.size)
        harness.fake.sent.forEachIndexed { index, sent ->
            assertArrayEquals("buffer $index", expected[index], sent.bytes)
            assertEquals(FakeUsbBackend.Route.CONTROL, sent.route)
            val setup = checkNotNull(sent.setup)
            assertEquals(0x21, setup.requestType)
            assertEquals(0x09, setup.request)
            assertEquals(0x02CB, setup.value)
            assertEquals(FakeUsbBackend.HID_INTERFACE_ID, setup.index)
            assertEquals(1000, sent.timeoutMs)
        }
        assertEquals("control", harness.diagnostics(key).payload?.getString("transfer"))
    }

    @Test
    fun buffersArePaddedToTheLargestOutputReportOnBothRoutes() {
        for (interruptOut in listOf(true, false)) {
            val harness = UsbPluginHarness(devices = listOf(FakeUsbBackend.cable(interruptOut = interruptOut)))
            harness.fake.faults.reportDescriptor = DiagnosticsTest.twoOutputReports
            val key = harness.connectFirst()
            assertEquals(64, harness.diagnostics(key).payload?.getInt("paddedLength"))
            harness.writeCurve(key, neutral).forEach { assertTrue(it.resolved) }
            val expected = (neutral.reports + listOf(commit)).map { UsbPluginHarness.wire(it, paddedLength = 64) }
            assertEquals(expected.size, harness.fake.sent.size)
            expected.forEachIndexed { index, bytes -> assertArrayEquals(bytes, harness.fake.sent[index].bytes) }
        }
    }

    @Test
    fun everyGuardRejectionSendsZeroBytes() {
        val badPreamble = neutral.reports[0].copyOf().also { it[1] = 0 }
        val badPadding = neutral.reports[8].copyOf().also { it[30] = 1 }
        val badCrc = neutral.reports[7].copyOf().also { it[5] = (it[5] + 1).toByte() }
        // Name, valid data reports sent first, then the report the guard must refuse.
        val cases: List<Triple<String, Int, Pair<Int, ByteArray>>> = listOf(
            Triple("wrong report ID", 0, 0x01 to neutral.reports[0]),
            Triple("wrong size", 0, 0xCB to neutral.reports[0].copyOf(30)),
            Triple("commit first", 0, 0xCB to commit),
            Triple("out of order", 0, 0xCB to neutral.reports[1]),
            Triple("repeated report", 3, 0xCB to neutral.reports[2]),
            Triple("bad preamble", 0, 0xCB to badPreamble),
            Triple("bad CRC", 7, 0xCB to badCrc),
            Triple("bad padding", 8, 0xCB to badPadding),
            Triple("data instead of commit", 9, 0xCB to neutral.reports[1]),
            // A valid report 0 after the 9 data reports is a live apply; a bad one is still refused.
            Triple("bad report 0 instead of commit", 9, 0xCB to badPreamble),
        )
        for ((name, valid, report) in cases) {
            val harness = UsbPluginHarness()
            val key = harness.connectFirst()
            (0 until valid).forEach { assertTrue(name, harness.send(key, 0xCB, neutral.reports[it]).resolved) }
            val calls = harness.fake.calls.size
            val attempts = harness.fake.attempts
            val call = harness.send(key, report.first, report.second)
            assertEquals(name, ErrorCodes.USB_GUARD_REJECTED, call.code)
            assertTrue(name, call.message.orEmpty().isNotBlank())
            // The refused report made no backend call at all, not even a claim.
            assertEquals(name, calls, harness.fake.calls.size)
            assertEquals(name, attempts, harness.fake.attempts)
            assertEquals(name, valid, harness.fake.sent.size)
            assertEquals(name, ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, commit).code)
            assertEquals(name, calls, harness.fake.calls.size)
        }
    }

    @Test
    fun aCommitWithoutTheNineValidReportsNeverReachesTheBackend() {
        val harness = UsbPluginHarness()
        val key = harness.connectFirst()
        (0 until 8).forEach { assertTrue(harness.send(key, 0xCB, neutral.reports[it]).resolved) }
        val calls = harness.fake.calls.size
        val rejected = harness.send(key, 0xCB, commit)
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, rejected.code)
        assertEquals(FrameGuard.RejectReason.COMMIT_WITHOUT_DATA.message, rejected.message)
        assertEquals(calls, harness.fake.calls.size)
        assertFalse(harness.fake.sent.any { it.bytes.contentEquals(UsbPluginHarness.wire(commit)) })
    }

    @Test
    fun twoCommitsLessThanTwoSecondsApartOnTheSameKeyRefuseTheSecond() {
        val harness = UsbPluginHarness()
        val key = harness.connectFirst()
        harness.writeCurve(key, neutral).forEach { assertTrue(it.resolved) }
        val second = harness.writeCurve(key, ProtocolFixtureTest.presets[0])
        second.dropLast(1).forEach { assertTrue(it.resolved) }
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, second.last().code)
        assertEquals(FrameGuard.RejectReason.COMMIT_TOO_SOON.message, second.last().message)
        assertEquals(1, harness.fake.sent.count { it.bytes.contentEquals(UsbPluginHarness.wire(commit)) })
        harness.nowMs += ProtocolConstants.WRITE_SPACING_MS
        harness.writeCurve(key, ProtocolFixtureTest.presets[0]).forEach { assertTrue(it.resolved) }
        assertEquals(2, harness.fake.sent.count { it.bytes.contentEquals(UsbPluginHarness.wire(commit)) })
    }

    @Test
    fun reconnectKeepsCommitSpacingAcrossAttachmentKeys() {
        val harness = UsbPluginHarness()
        val first = harness.connectFirst()
        harness.writeCurve(first, neutral).forEach { assertTrue(it.resolved) }
        val committedAt = harness.nowMs
        harness.fake.detach(FakeUsbBackend.cable().key)
        harness.fake.attach(FakeUsbBackend.cable("/dev/bus/usb/002/008"))
        val second = harness.connectFirst()
        assertNotEquals(first, second)
        val calls = harness.writeCurve(second, neutral)
        calls.dropLast(1).forEach { assertTrue(it.resolved) }
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, calls.last().code)
        assertEquals(19, harness.fake.sent.size)
        harness.nowMs = committedAt + ProtocolConstants.WRITE_SPACING_MS
        harness.writeCurve(second, neutral).forEach { assertTrue(it.resolved) }
    }

    @Test
    fun pluginRecreationKeepsCommitSpacingForThePhysicalDevice() {
        val first = UsbPluginHarness()
        first.writeCurve(first.connectFirst(), neutral).forEach { assertTrue(it.resolved) }
        first.plugin.handleOnDestroy()
        val second = UsbPluginHarness(commitSpacing = first.commitSpacing)
        second.nowMs = first.nowMs
        val key = second.connectFirst()
        val calls = second.writeCurve(key, neutral)
        calls.dropLast(1).forEach { assertTrue(it.resolved) }
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, calls.last().code)
        assertEquals(9, second.fake.sent.size)
        second.nowMs = first.nowMs + ProtocolConstants.WRITE_SPACING_MS
        second.writeCurve(key, neutral).forEach { assertTrue(it.resolved) }
    }

    @Test
    fun serialReadAfterPermissionDistinguishesCablesAndSurvivesPluginRecreation() {
        val devices = listOf(
            FakeUsbBackend.cable(serialNumber = "A"),
            FakeUsbBackend.cable("/dev/bus/usb/001/003", serialNumber = "B"),
        )
        val harness = UsbPluginHarness(devices = emptyList())
        devices.forEach { harness.fake.attach(it) }
        assertTrue(harness.fake.list(emptyList()).all { it.serialNumber == null })
        val keys = harness.requestDevice().deviceKeys()
        keys.forEach { key ->
            assertTrue(harness.open(key).resolved)
            harness.writeCurve(key, neutral).forEach { assertTrue(it.resolved) }
        }
        assertEquals(20, harness.fake.sent.size)
        val recreated = UsbPluginHarness(
            devices = listOf(FakeUsbBackend.cable("/dev/bus/usb/002/009", serialNumber = "A")),
            commitSpacing = harness.commitSpacing,
        )
        recreated.nowMs = harness.nowMs
        val key = recreated.connectFirst()
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, recreated.writeCurve(key, neutral).last().code)
        assertEquals(9, recreated.fake.sent.size)
        recreated.nowMs += ProtocolConstants.WRITE_SPACING_MS
        recreated.writeCurve(key, neutral).forEach { assertTrue(it.resolved) }
    }

    @Test
    fun aCableWithoutAProductNameStillHasAnEmptyBridgeProductName() {
        val cable = FakeUsbBackend.cable()
        val unnamed = UsbDeviceInfo(cable.key, cable.vendorId, cable.productId, null, null, cable.interfaces)
        val call = UsbPluginHarness(devices = listOf(unnamed)).requestDevice()
        assertEquals("", call.payload?.getJSONArray("devices")?.getJSONObject(0)?.getString("productName"))
    }

    @Test
    fun stopBetweenCommitDecisionAndTransferSendsNothing() {
        val harness = UsbPluginHarness(wrap = ::ScriptedBackend)
        val key = harness.connectFirst()
        neutral.reports.forEach { assertTrue(harness.send(key, 0xCB, it).resolved) }
        // Release the claim without resetting the validated sequence, so the commit reclaims it.
        harness.claims.releaseAll()
        (harness.backend as ScriptedBackend).beforeClaim = { harness.plugin.handleOnStop() }
        val call = harness.send(key, 0xCB, commit)
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, call.code)
        assertTrue(call.message.orEmpty().contains("reset"))
        assertEquals(9, harness.fake.sent.size)
        assertEquals(9, harness.fake.attempts)
    }

    @Test
    fun realWorkerRejectsOneOfTwoConcurrentSendsOnTheSameKeyAsBusy() {
        val worker = OpenAuriUsbPlugin.newWorker()
        val harness = UsbPluginHarness(wrap = ::ScriptedBackend, workerOverride = worker)
        val entered = CountDownLatch(1)
        val proceed = CountDownLatch(1)
        try {
            val key = harness.requestDevice().deviceKeys().single()
            val opened = harness.open(key)
            UsbTestSupport.eventually("open on real worker") { opened.completed }
            assertTrue(opened.resolved)
            (harness.backend as ScriptedBackend).beforeClaim = {
                entered.countDown()
                check(proceed.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))
            }
            val first = UsbTestSupport.offMain { harness.send(key, 0xCB, neutral.reports[0]) }
            assertTrue(entered.await(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))
            val second = UsbTestSupport.offMain { harness.send(key, 0xCB, neutral.reports[0]) }
            assertEquals(ErrorCodes.USB_BUSY, second.code)
            assertFalse(first.completed)
            proceed.countDown()
            UsbTestSupport.eventually("first real-worker send") { first.completed }
            assertTrue(first.resolved)
            assertEquals(1, harness.fake.sent.size)
        } finally {
            proceed.countDown()
            harness.plugin.handleOnDestroy()
            assertTrue(worker.awaitTermination(UsbTestSupport.WAIT_SECONDS, TimeUnit.SECONDS))
        }
    }

    @Test
    fun detachAtAnyReportEmitsDisconnectFirstAndNeverTheCommit() {
        for (k in 0..9) {
            val harness = UsbPluginHarness()
            val key = harness.connectFirst()
            harness.fake.faults.detachAtReport = k
            val calls = harness.writeCurve(key, neutral)
            calls.take(k).forEach { assertTrue("k=$k", it.resolved) }
            assertEquals("k=$k", ErrorCodes.USB_DETACHED, calls[k].code)
            calls.drop(k + 1).forEach { assertEquals("k=$k", ErrorCodes.USB_NOT_FOUND, it.code) }
            val disconnect = harness.journal.indexOf("event:disconnect:$key")
            val rejection = harness.journal.indexOf("reject:sendReport:USB_DETACHED")
            assertTrue("k=$k disconnect $disconnect before rejection $rejection", disconnect in 0 until rejection)
            assertEquals(k, harness.fake.sent.size)
            assertFalse(harness.fake.sent.any { it.bytes.contentEquals(UsbPluginHarness.wire(commit)) })
            assertEquals("close", harness.fake.calls.last())
            assertEquals(listOf(key), harness.disconnects.keys)
        }
    }

    @Test
    fun timeoutIsUsbTimeoutAndTheInterruptedSequenceCannotBeCommitted() {
        val harness = UsbPluginHarness()
        val key = harness.connectFirst()
        harness.fake.faults.timeoutAtReport = 3
        val calls = harness.writeCurve(key, neutral)
        assertEquals(ErrorCodes.USB_TIMEOUT, calls[3].code)
        calls.drop(4).forEach { assertEquals(ErrorCodes.USB_GUARD_REJECTED, it.code) }
        assertEquals(3, harness.fake.sent.size)
    }

    @Test
    fun transferFailuresShortWritesFramingAndClaimsMapToAnexoC() {
        val failing = UsbPluginHarness()
        val failingKey = failing.connectFirst()
        failing.fake.faults.failAtReport = 0
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, failing.send(failingKey, 0xCB, neutral.reports[0]).code)

        val short = UsbPluginHarness(wrap = ::ScriptedBackend)
        val shortKey = short.connectFirst()
        val scripted = short.backend as ScriptedBackend
        scripted.shortBy = 1
        val shortCall = short.send(shortKey, 0xCB, neutral.reports[0])
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, shortCall.code)
        assertEquals("short write: 31 of 32 bytes", shortCall.message)
        scripted.shortBy = 0
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, short.send(shortKey, 0xCB, neutral.reports[1]).code)

        val foreign = UsbPluginHarness()
        foreign.fake.faults.reportDescriptor = DiagnosticsTest.vendorReportOnly
        val foreignKey = foreign.connectFirst()
        val framing = foreign.send(foreignKey, 0xCB, neutral.reports[0])
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, framing.code)
        assertEquals(0, foreign.fake.attempts)
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, foreign.send(foreignKey, 0xCB, neutral.reports[1]).code)

        val busy = UsbPluginHarness()
        val busyKey = busy.connectFirst()
        busy.fake.faults.claimBusy = true
        assertEquals(ErrorCodes.USB_BUSY, busy.send(busyKey, 0xCB, neutral.reports[0]).code)
        assertEquals(0, busy.fake.attempts)
    }

    @Test
    fun aSecondConcurrentSendReportOnTheSameKeyIsBusy() {
        val cables = listOf("/dev/bus/usb/001/002", "/dev/bus/usb/001/003").map { FakeUsbBackend.cable(it) }
        val harness = UsbPluginHarness(devices = cables)
        val keys = harness.requestDevice().deviceKeys()
        keys.forEach { assertTrue(harness.open(it).resolved) }
        harness.worker.queued = true
        val first = harness.send(keys[0], 0xCB, neutral.reports[0])
        val concurrent = harness.send(keys[0], 0xCB, neutral.reports[0])
        val otherKey = harness.send(keys[1], 0xCB, neutral.reports[0])
        assertEquals(ErrorCodes.USB_BUSY, concurrent.code)
        assertFalse(first.completed)
        assertFalse(otherKey.completed)
        harness.worker.runAll()
        assertTrue(first.resolved)
        assertTrue(otherKey.resolved)
        assertEquals(2, harness.fake.sent.size)
        harness.worker.queued = false
        assertTrue(harness.send(keys[0], 0xCB, neutral.reports[1]).resolved)
        assertEquals(false, harness.diagnostics(keys[0]).payload?.getBoolean("kernelDriverDetached"))
    }

    @Test
    fun sessionsClosedWhileASendWaitsRejectNotOpen() {
        val harness = UsbPluginHarness()
        val key = harness.connectFirst()
        harness.worker.queued = true
        val waiting = harness.send(key, 0xCB, neutral.reports[0])
        harness.plugin.onDocumentStarted()
        harness.worker.runAll()
        assertEquals(ErrorCodes.USB_NOT_OPEN, waiting.code)
        assertEquals(0, harness.fake.attempts)
        assertEquals("close", harness.fake.calls.last())
    }

    @Test
    fun aWorkerThatRefusesWorkRejectsAndFreesTheKey() {
        val harness = UsbPluginHarness()
        val key = harness.connectFirst()
        harness.worker.rejecting = true
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, harness.send(key, 0xCB, neutral.reports[0]).code)
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, harness.open(key).code)
        harness.fake.detach("/dev/bus/usb/001/002")
        assertTrue(harness.backgroundErrors.single() is RejectedExecutionException)
        harness.worker.rejecting = false
        val again = UsbPluginHarness()
        val againKey = again.connectFirst()
        again.worker.rejecting = true
        again.send(againKey, 0xCB, neutral.reports[0])
        again.worker.rejecting = false
        assertTrue(again.send(againKey, 0xCB, neutral.reports[0]).resolved)
    }

    @Test
    fun appStopReleasesClaimsAndTheSequenceExpiresWithoutCommit() {
        val harness = UsbPluginHarness()
        val key = harness.connectFirst()
        (0 until 5).forEach { assertTrue(harness.send(key, 0xCB, neutral.reports[it]).resolved) }
        assertEquals(5, harness.fake.sent.size)
        harness.plugin.handleOnStop()
        assertTrue("release 2" in harness.fake.calls)
        val rest = (5 until 9).map { harness.send(key, 0xCB, neutral.reports[it]) } + harness.send(key, 0xCB, commit)
        rest.forEach { assertEquals(ErrorCodes.USB_GUARD_REJECTED, it.code) }
        assertEquals(5, harness.fake.sent.size)
        assertFalse(harness.fake.sent.any { it.bytes.contentEquals(UsbPluginHarness.wire(commit)) })
        // A fresh write after the stop works, from report 0.
        harness.nowMs += ProtocolConstants.WRITE_SPACING_MS
        harness.writeCurve(key, neutral).forEach { assertTrue(it.resolved) }
    }

    @Test
    fun aNewDocumentClosesTheConnectionsAndDropsTheSequences() {
        val harness = UsbPluginHarness()
        harness.plugin.onDocumentStarted()
        assertTrue(harness.fake.calls.isEmpty())
        val key = harness.connectFirst()
        (0 until 3).forEach { assertTrue(harness.send(key, 0xCB, neutral.reports[it]).resolved) }
        harness.plugin.onDocumentStarted()
        assertEquals("close", harness.fake.calls.last())
        assertEquals(ErrorCodes.USB_NOT_OPEN, harness.send(key, 0xCB, neutral.reports[3]).code)
        assertTrue(harness.open(key).resolved)
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, neutral.reports[3]).code)
        harness.plugin.onDocumentStarted()
        assertTrue(harness.backgroundErrors.isEmpty())
    }

    @Test
    fun diagnosticsDescribeTheConnectionAndOmitTheWireLogInRelease() {
        val release = UsbPluginHarness(isDebug = false)
        val key = release.connectFirst()
        release.send(key, 0xCB, neutral.reports[0])
        val report = checkNotNull(release.diagnostics(key).payload)
        assertFalse(report.has("wireLog"))
        assertEquals(key, report.getJSONObject("device").getString("key"))
        assertEquals("1.2.3", report.getString("appVersion"))
        assertEquals("16 (API 36)", report.getString("androidVersion"))
        assertEquals("140.0.7339.0", report.getString("webViewVersion"))
        assertEquals(FakeUsbBackend.DEFAULT_RAW_DESCRIPTORS.toHex(), report.getString("rawDescriptorsHex"))
        assertEquals(FakeUsbBackend.DEFAULT_REPORT_DESCRIPTOR.toHex(), report.getString("reportDescriptorHex"))
        assertEquals(2, report.getInt("hidInterfaceId"))
        val endpoints = report.getJSONArray("endpoints")
        assertEquals(2, endpoints.length())
        assertEquals(0x83, endpoints.getJSONObject(0).getInt("address"))
        assertEquals("in", endpoints.getJSONObject(0).getString("direction"))
        assertEquals("interrupt", endpoints.getJSONObject(1).getString("type"))
        assertEquals("out", endpoints.getJSONObject(1).getString("direction"))
        assertEquals(64, endpoints.getJSONObject(1).getInt("maxPacketSize"))
        val outputs = report.getJSONArray("outputReports")
        assertEquals(1, outputs.length())
        assertEquals(0xCB, outputs.getJSONObject(0).getInt("reportId"))
        assertEquals(31, outputs.getJSONObject(0).getInt("bytes"))
        assertEquals("interrupt", report.getString("transfer"))
        assertEquals(32, report.getInt("paddedLength"))
        assertFalse(report.getBoolean("kernelDriverDetached"))
        // Diagnostics read the cache: no USB I/O.
        val calls = release.fake.calls.size
        release.diagnostics(key)
        assertEquals(calls, release.fake.calls.size)
        assertEquals(ErrorCodes.USB_NOT_FOUND, release.diagnostics("/dev/bus/usb/009/009#9").code)
    }

    @Test
    fun debugBuildsKeepAWireLogOfTheBuffersSent() {
        val debug = UsbPluginHarness(isDebug = true)
        val key = debug.connectFirst()
        debug.fake.faults.kernelDriverBound = true
        val start = debug.nowMs
        debug.writeCurve(key, neutral).forEach { assertTrue(it.resolved) }
        val report = checkNotNull(debug.diagnostics(key).payload)
        assertTrue(report.getBoolean("kernelDriverDetached"))
        val log = report.getJSONArray("wireLog")
        assertEquals(10, log.length())
        debug.fake.sent.forEachIndexed { index, sent ->
            assertEquals(sent.bytes.toHex(), log.getJSONObject(index).getString("hex"))
        }
        assertEquals(start, log.getJSONObject(0).getLong("atMs"))
    }

    @Test
    fun connectAndDisconnectEventsCarryKeysThatChangeOnReconnect() {
        val harness = UsbPluginHarness()
        val cable = FakeUsbBackend.cable("/dev/bus/usb/001/009")
        harness.fake.attach(cable)
        val first = harness.connects.keys.single()
        assertEquals("/dev/bus/usb/001/009#1", first)
        harness.fake.detach(cable.key)
        assertEquals(listOf(first), harness.disconnects.keys)
        harness.fake.attach(cable)
        val second = harness.connects.keys.last()
        assertNotEquals(first, second)
        assertEquals(ErrorCodes.USB_NOT_FOUND, harness.open(first).code)
        // An attach for a name that still has a key means its detach was missed.
        harness.fake.attach(cable)
        assertEquals(listOf(first, second), harness.disconnects.keys)
        assertEquals(3, harness.connects.keys.size)
        // Devices that are not CB5100 cables and never got a key raise no event.
        val mouse = UsbDeviceInfo("/dev/bus/usb/003/001", 0x046D, 0xC077, "Mouse", null, emptyList())
        harness.fake.attach(mouse)
        harness.fake.detach(mouse.key)
        assertEquals(3, harness.connects.keys.size)
        assertEquals(2, harness.disconnects.keys.size)
    }

    @Test
    fun detachOfAnOpenCableClosesItInTheBackground() {
        val harness = UsbPluginHarness(wrap = ::ScriptedBackend)
        val key = harness.connectFirst()
        (harness.backend as ScriptedBackend).closeError = UsbFailure.Closed("lane gone", null)
        harness.fake.detach("/dev/bus/usb/001/002")
        assertEquals(listOf(key), harness.disconnects.keys)
        assertEquals("lane gone", harness.backgroundErrors.single().message)
        assertEquals(ErrorCodes.USB_NOT_FOUND, harness.send(key, 0xCB, neutral.reports[0]).code)
    }

    @Test
    fun aForeignOriginGetsUsbOriginFromEveryMethodWithoutIoOrStateChange() {
        val harness = UsbPluginHarness()
        harness.fake.grant(FakeUsbBackend.cable())
        val key = harness.call("getDevices").deviceKeys().single()
        val foreign = listOf("https://evil.example/cabo", "http://open-auri.com/", "https://open-auri.com.evil.example/", null)
        val requests: List<Pair<String, JSObject>> = listOf(
            "getInfo" to JSObject(),
            "requestDevice" to JSObject().put("filters", JSArray().put(UsbPluginHarness.cb5100Filter())),
            "getDevices" to JSObject(),
            "open" to JSObject().put("key", key),
            "close" to JSObject().put("key", key),
            "sendReport" to JSObject().put("key", key).put("reportId", 0xCB).put("data", UsbPluginHarness.base64(neutral.reports[0])),
            "diagnostics" to JSObject().put("key", key),
            "addListener" to JSObject().put("eventName", "connect"),
            "removeListener" to JSObject().put("eventName", "connect").put("callbackId", "1"),
            "removeAllListeners" to JSObject(),
        )
        val io = harness.ioCount()
        for (url in foreign) {
            harness.pageUrl = url
            for ((method, data) in requests) {
                val call = harness.call(method, data, validRequest = if (method in BridgeCall.LISTENER_METHODS) null else true)
                assertEquals("$method on $url", ErrorCodes.USB_ORIGIN, call.code)
            }
            harness.fake.attach(FakeUsbBackend.cable("/dev/bus/usb/001/010"))
            harness.fake.detach("/dev/bus/usb/001/010")
        }
        harness.pageUrl = UsbPluginHarness.PAGE
        harness.pinnedUrl = null
        assertEquals(ErrorCodes.USB_ORIGIN, harness.call("getInfo").code)
        harness.pinnedUrl = UsbPluginHarness.PINNED
        assertEquals(io, harness.ioCount())
        assertTrue(harness.connects.keys.isEmpty())
        assertTrue(harness.disconnects.keys.isEmpty())
        // Nothing was opened or registered on the foreign origin.
        assertEquals(ErrorCodes.USB_NOT_OPEN, harness.send(key, 0xCB, neutral.reports[0]).code)
        harness.fake.attach(FakeUsbBackend.cable("/dev/bus/usb/001/011"))
        assertEquals(1, harness.connects.keys.size)
    }

    @Test
    fun removeAllListenersStopsTheEvents() {
        val harness = UsbPluginHarness()
        assertTrue(harness.call("removeAllListeners", validRequest = null).resolved)
        harness.fake.attach(FakeUsbBackend.cable("/dev/bus/usb/001/012"))
        assertTrue(harness.connects.keys.isEmpty())
        val again = ListenerCall(OpenAuriUsbPlugin.EVENT_CONNECT)
        harness.plugin.addListener(again)
        harness.fake.attach(FakeUsbBackend.cable("/dev/bus/usb/001/013"))
        assertEquals(listOf("/dev/bus/usb/001/013#2"), again.keys)
    }

    @Test
    fun destroyStopsEventsDisposesTheBackendAndRefusesWork() {
        val harness = UsbPluginHarness()
        val key = harness.connectFirst()
        harness.plugin.handleOnDestroy()
        assertTrue(harness.worker.isShutdown)
        harness.fake.attach(FakeUsbBackend.cable("/dev/bus/usb/001/014"))
        assertTrue(harness.connects.keys.isEmpty())
        assertEquals(ErrorCodes.USB_NOT_OPEN, harness.send(key, 0xCB, neutral.reports[0]).code)
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, harness.open(key).code)
    }

    @Test
    fun everyUsbFailureMapsToItsAnexoCCode() {
        val key = "/dev/bus/usb/001/002"
        val expected = mapOf<UsbFailure, String>(
            UsbFailure.NoHost() to ErrorCodes.USB_NO_HOST,
            UsbFailure.NotFound(key) to ErrorCodes.USB_NOT_FOUND,
            UsbFailure.PermissionDenied(key) to ErrorCodes.USB_PERMISSION_DENIED,
            UsbFailure.OpenFailed(key) to ErrorCodes.USB_TRANSFER_FAILED,
            UsbFailure.NotOpen(key) to ErrorCodes.USB_NOT_OPEN,
            UsbFailure.Busy(key, "held") to ErrorCodes.USB_BUSY,
            UsbFailure.Timeout(key, 1000, null) to ErrorCodes.USB_TIMEOUT,
            UsbFailure.TransferFailed(key, -1, "x") to ErrorCodes.USB_TRANSFER_FAILED,
            UsbFailure.Detached(key) to ErrorCodes.USB_DETACHED,
            UsbFailure.MainThread("open") to ErrorCodes.USB_TRANSFER_FAILED,
            UsbFailure.BadArgs("x") to ErrorCodes.USB_BAD_ARGS,
            UsbFailure.Closed("x", null) to ErrorCodes.USB_TRANSFER_FAILED,
            UsbFailure.Interrupted("open", InterruptedException()) to ErrorCodes.USB_TRANSFER_FAILED,
        )
        expected.forEach { (failure, code) ->
            assertEquals(failure.javaClass.simpleName, code, ErrorCodes.of(failure))
            val thrown: Throwable = failure
            assertEquals(code, ErrorCodes.of(thrown))
        }
        assertEquals(ErrorCodes.USB_TIMEOUT, ErrorCodes.of(UsbBridgeException(ErrorCodes.USB_TIMEOUT, "x")))
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, ErrorCodes.of(IllegalStateException()))
        assertEquals("java.lang.IllegalStateException", ErrorCodes.messageOf(IllegalStateException()))
        assertEquals(11, ErrorCodes.ALL.toSet().size)
        assertThrows(IllegalArgumentException::class.java) { UsbBridgeException("USB_OTHER", "x") }
    }

    private fun writeAllCurves(harness: UsbPluginHarness, key: String) {
        for (curve in ProtocolFixtureTest.allCurves) {
            harness.writeCurve(key, curve).forEach { assertTrue(curve.name, it.resolved) }
            harness.nowMs += ProtocolConstants.WRITE_SPACING_MS
        }
    }

    private fun expectedWire(): List<ByteArray> = ProtocolFixtureTest.allCurves
        .flatMap { it.reports + listOf(commit) }
        .map { UsbPluginHarness.wire(it) }
}
