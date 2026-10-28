package com.openauri.usb

import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.openauri.app.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64
import java.util.concurrent.ExecutorService
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Capacitor plugin `OpenAuriUsb`, bridgeApi 1 (plan Anexo B): the only path from the page to the
 * USB cable. Methods: `getInfo`, `requestDevice`, `getDevices`, `open`, `close`, `sendReport`,
 * `diagnostics`; events `connect` and `disconnect` with `{device}`. Errors use [ErrorCodes].
 *
 * Every method, the listener methods and every event first pass the [OriginGuard]: on another
 * origin the call is rejected with `USB_ORIGIN` (events are not sent) before any argument is
 * read, any state changes or the backend is touched.
 *
 * Device keys are `deviceName#n`: the platform device name plus a number this plugin assigns to
 * each physical attachment. A key stays valid while the device is attached; a detach drops it
 * and a reconnection always gets a new key, even if the kernel reuses the device name.
 *
 * `sendReport` runs, in order: argument checks (`USB_BAD_ARGS`), key and open checks, the
 * one-in-flight-per-key rule (`USB_BUSY`), then on the worker the [FrameGuards] decision
 * (`USB_GUARD_REJECTED`, nothing sent), [HidFraming] with the descriptor parsed once at `open`,
 * the [ClaimManager] claim and one transfer on the route of Anexo D.1 (interrupt OUT if the HID
 * interface has one, else SET_REPORT) with a 1000 ms timeout. Any failure after the guard resets
 * the guard of that key, so an interrupted write can never be committed (invariant 0.12.7).
 *
 * Threading: methods run on Capacitor's plugin thread and never block it. Work that touches the
 * device runs on one worker thread, in call order; the backend runs the I/O itself on its
 * per-device lane with bounded timeouts. Dialogs run on the main thread. Detach events (main
 * thread) emit `disconnect` before the pending call is rejected.
 */
@CapacitorPlugin(name = OpenAuriUsbPlugin.NAME)
class OpenAuriUsbPlugin internal constructor(private val injected: Environment?) : Plugin() {

    /** Capacitor's constructor; the collaborators are created in [load]. */
    constructor() : this(null)

    /**
     * Collaborators of the plugin, injectable for tests.
     *
     * @property worker single-threaded executor for every call that touches the device.
     * @property clock monotonic milliseconds for the [FrameGuard] and the wire log.
     * @property isDebug whether this is a debug build; only then is a [WireLog] recorded.
     * @property onBackgroundError receives failures of work no call waits for (closing a detached
     *   or abandoned connection).
     */
    internal class Environment(
        val backend: UsbBackend,
        val claims: ClaimManager,
        val origin: OriginGuard,
        val picker: DevicePicker,
        val info: AppInfo,
        val worker: ExecutorService,
        val clock: () -> Long,
        val isDebug: Boolean,
        val onBackgroundError: (Throwable) -> Unit,
        val commitSpacing: CommitSpacingStore = CommitSpacingStore.process,
    )

    /** One physical attachment of a device and its bridge key. */
    private class Attachment(val device: UsbDeviceInfo, val key: String) {
        // Guarded by the session lock; every sequence reset invalidates pending Forward decisions.
        var generation = 0L
    }

    /** An open connection with everything `open` read, parsed and chose once. */
    private class Session(
        val attachment: Attachment,
        val connection: UsbConnectionHandle,
        val hidInterface: UsbInterfaceInfo,
        val rawDescriptors: ByteArray,
        val reportDescriptor: ByteArray,
        val descriptor: ParsedDescriptor,
        val interruptOut: UsbEndpointInfo?,
        val wireLog: WireLog?,
        val identity: PhysicalDeviceIdentity,
    )

    private lateinit var env: Environment
    private val guards by lazy { FrameGuards(env.commitSpacing) }
    private val lock = Any()

    // Guarded by lock.
    private val attachments = HashMap<String, Attachment>()
    private val byKey = HashMap<String, Attachment>()
    private val sessions = HashMap<String, Session>()
    private val sending = HashSet<String>()
    private var attachmentCount = 0L

    private val deviceListener = object : UsbDeviceListener {
        override fun onAttached(device: UsbDeviceInfo) = attached(device)

        override fun onDetached(device: UsbDeviceInfo) = detached(device)
    }

    override fun load() {
        env = injected ?: production()
        env.backend.addListener(deviceListener)
    }

    private fun production(): Environment {
        val activity = bridge.activity
        val backend = AndroidUsbBackend.create(activity)
        val tracker = MainFrameUrlTracker(::onDocumentStarted)
        // Bridge.Builder replaces the WebView listener list once the plugins are loaded, so the
        // tracker is added on the next main-thread turn, then catches up with the current URL.
        bridge.executeOnMainThread {
            bridge.addWebViewListener(tracker)
            tracker.update(bridge.webView.url)
        }
        val bridgeRef = bridge
        return Environment(
            backend = backend,
            claims = ClaimManager(backend),
            origin = OriginGuard({ bridgeRef.serverUrl }, { tracker.url }),
            picker = DialogDevicePicker({ bridgeRef.activity }, ContextCompat.getMainExecutor(activity)),
            info = AppInfo.from(activity),
            worker = newWorker(),
            clock = { SystemClock.elapsedRealtime() },
            isDebug = BuildConfig.DEBUG,
            onBackgroundError = { Log.w(TAG, "USB background task failed: ${ErrorCodes.messageOf(it)}") },
        )
    }

    /**
     * `{bridgeApi: 1, appVersion, usbHost, webViewVersion, liveApply}`; `usbHost` is
     * FEATURE_USB_HOST. `liveApply` (optional in the schema, absent before it existed) says the
     * [FrameGuard] accepts live applies: a valid data report 0 in AwaitCommit starts a new write.
     */
    @PluginMethod
    fun getInfo(call: PluginCall) = serve(call) {
        call.resolve(
            JSObject()
                .put("bridgeApi", BRIDGE_API)
                .put("appVersion", env.info.appVersion)
                .put("usbHost", env.info.usbHost)
                .put("webViewVersion", env.info.webViewVersion)
                .put("liveApply", LIVE_APPLY),
        )
    }

    /**
     * `{filters: [{vendorId?, productId?}]}` to `{devices}`: no match resolves `[]`, one match asks
     * the Android permission, several open the [DevicePicker] and then ask for each chosen device
     * in turn. Denied, failed and cancelled requests leave the device out, like WebHID's chooser.
     */
    @PluginMethod
    fun requestDevice(call: PluginCall) = serve(call) {
        val filters = BridgeArgs.filters(call.data)
        requireHost()
        // Requested filters can narrow the supported cable identity, never broaden it.
        val matches = env.backend.list(listOf(CB5100)).filter { device ->
            filters.isEmpty() || filters.any { it.matches(device) }
        }
        when (matches.size) {
            0 -> resolveDevices(call, emptyList())
            1 -> requestPermissions(call, matches, 0, ArrayList())
            else -> env.picker.pick(matches) { chosen -> requestPermissions(call, chosen, 0, ArrayList()) }
        }
    }

    /** `{devices}`: the attached CB5100 cables the app already has permission for. */
    @PluginMethod
    fun getDevices(call: PluginCall) = serve(call) {
        requireHost()
        resolveDevices(call, env.backend.list(listOf(CB5100)).filter { env.backend.hasPermission(it) })
    }

    /**
     * `{key}`: opens the connection, finds the HID interface, reads and parses the HID report
     * descriptor once and chooses the route. Already open resolves at once. A malformed
     * descriptor rejects with `USB_TRANSFER_FAILED` and closes the connection.
     */
    @PluginMethod
    fun open(call: PluginCall) = serve(call) {
        val attachment = attachment(BridgeArgs.key(call.data))
        if (!env.backend.hasPermission(attachment.device)) {
            throw UsbBridgeException(ErrorCodes.USB_PERMISSION_DENIED, "no USB permission for ${attachment.key}")
        }
        submit(call) {
            openSession(attachment)
            call.resolve()
        }
    }

    /** `{key}`: closes the connection (if open) after the queued work and drops the sequence. */
    @PluginMethod
    fun close(call: PluginCall) = serve(call) {
        val attachment = attachment(BridgeArgs.key(call.data))
        submit(call) {
            val session = synchronized(lock) {
                resetGuard(attachment)
                sessions.remove(attachment.key)
            }
            if (session != null) closeConnection(session)
            call.resolve()
        }
    }

    /** `{key, reportId, data}` with `data` in base64: one output report, through the guard. */
    @PluginMethod
    fun sendReport(call: PluginCall) = serve(call) {
        val key = BridgeArgs.key(call.data)
        val reportId = BridgeArgs.reportId(call.data)
        val data = BridgeArgs.data(call.data)
        val attachment = attachment(key)
        val free = synchronized(lock) {
            if (key !in sessions) throw UsbBridgeException(ErrorCodes.USB_NOT_OPEN, "$key is not open")
            sending.add(key)
        }
        if (!free) throw UsbBridgeException(ErrorCodes.USB_BUSY, "another sendReport is in progress on $key")
        try {
            env.worker.execute { send(call, attachment, reportId, data) }
        } catch (rejected: RejectedExecutionException) {
            synchronized(lock) { sending.remove(key) }
            throw UsbBridgeException(ErrorCodes.USB_TRANSFER_FAILED, "the USB bridge is shut down", rejected)
        }
    }

    /** `{key}` to `UsbDiagnostics`, from what `open` cached; no I/O. */
    @PluginMethod
    fun diagnostics(call: PluginCall) = serve(call) {
        val attachment = attachment(BridgeArgs.key(call.data))
        val session = synchronized(lock) { sessions[attachment.key] }
            ?: throw UsbBridgeException(ErrorCodes.USB_NOT_OPEN, "${attachment.key} is not open")
        val kernelDriverDetached = env.claims.diagnostics().lastOrNull {
            it.deviceKey == attachment.device.key && it.interfaceId == session.hidInterface.id
        }?.kernelDriverDetached ?: false
        call.resolve(
            UsbDiagnostics.build(
                device = deviceJson(attachment),
                info = env.info,
                rawDescriptors = session.rawDescriptors,
                hidInterface = session.hidInterface,
                reportDescriptor = session.reportDescriptor,
                descriptor = session.descriptor,
                interruptOut = session.interruptOut,
                kernelDriverDetached = kernelDriverDetached,
                wireLog = session.wireLog,
                abandonedSequences = guards.abandonedSequences(attachment.key),
            ),
        )
    }

    /** Capacitor's listener registration, behind the [OriginGuard]. */
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    override fun addListener(call: PluginCall) = serve(call) { super.addListener(call) }

    /** Capacitor's listener removal, behind the [OriginGuard]. */
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    override fun removeListener(call: PluginCall) = serve(call) { super.removeListener(call) }

    /** Capacitor's listener reset, behind the [OriginGuard]. */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    override fun removeAllListeners(call: PluginCall) = serve(call) { super.removeAllListeners(call) }

    /**
     * App in the background: every claimed interface is released and every sequence in progress
     * is dropped, so a write interrupted here can only be retried from report 0.
     */
    public override fun handleOnStop() {
        resetAllGuards()
        env.claims.releaseAll()
    }

    /** Stops listening, drops the sequences and disposes the backend after the queued work. */
    public override fun handleOnDestroy() {
        env.backend.removeListener(deviceListener)
        resetAllGuards()
        env.claims.dispose()
        synchronized(lock) { sessions.clear() }
        background { env.backend.dispose() }
        env.worker.shutdown()
    }

    /**
     * A new main-frame document started: the previous document's sequences are dropped and its
     * connections closed, so a new page can never continue a write it did not start.
     */
    internal fun onDocumentStarted() {
        resetAllGuards()
        val open = synchronized(lock) { sessions.values.toList().also { sessions.clear() } }
        if (open.isNotEmpty()) background { open.forEach(::closeConnection) }
    }

    /** Runs [block] after the [OriginGuard]; any failure rejects [call] with its code. */
    private inline fun serve(call: PluginCall, block: () -> Unit) {
        try {
            env.origin.check()
            block()
        } catch (error: Exception) {
            reject(call, error)
        }
    }

    /** Runs [block] on the worker; a failure, or a worker that refuses work, rejects [call]. */
    private fun submit(call: PluginCall, block: () -> Unit) {
        try {
            env.worker.execute {
                try {
                    block()
                } catch (error: Exception) {
                    reject(call, error)
                }
            }
        } catch (rejected: RejectedExecutionException) {
            reject(call, UsbBridgeException(ErrorCodes.USB_TRANSFER_FAILED, "the USB bridge is shut down", rejected))
        }
    }

    /** Runs [task] on the worker for no call in particular; failures go to the error sink. */
    private fun background(task: () -> Unit) {
        try {
            env.worker.execute {
                try {
                    task()
                } catch (error: Exception) {
                    env.onBackgroundError(error)
                }
            }
        } catch (rejected: RejectedExecutionException) {
            env.onBackgroundError(rejected)
        }
    }

    private fun reject(call: PluginCall, error: Throwable) {
        call.reject(ErrorCodes.messageOf(error), ErrorCodes.of(error))
    }

    private fun requireHost() {
        if (!env.backend.hasHost) throw UsbFailure.NoHost()
    }

    private fun requestPermissions(
        call: PluginCall,
        devices: List<UsbDeviceInfo>,
        index: Int,
        granted: MutableList<UsbDeviceInfo>,
    ) {
        if (index == devices.size) {
            resolveDevices(call, granted)
            return
        }
        val device = devices[index]
        try {
            env.backend.requestPermission(device) { result ->
                // A failed request (the device went away, the broker was disposed) is a denial.
                if (result.getOrDefault(false)) granted += device
                requestPermissions(call, devices, index + 1, granted)
            }
        } catch (error: Exception) {
            // Thrown by the platform instead of reported (this may run on the main thread).
            reject(call, error)
        }
    }

    /** Resolves `{devices}` with those of [devices] that are still attached, keys assigned. */
    private fun resolveDevices(call: PluginCall, devices: List<UsbDeviceInfo>) {
        try {
            val attachedNow = env.backend.list(emptyList()).mapTo(HashSet()) { it.key }
            val list = JSArray()
            devices.filter { it.key in attachedNow }.forEach { list.put(deviceJson(attachmentFor(it))) }
            call.resolve(JSObject().put("devices", list))
        } catch (error: Exception) {
            reject(call, error)
        }
    }

    private fun attachment(key: String): Attachment = synchronized(lock) { byKey[key] }
        ?: throw UsbBridgeException(ErrorCodes.USB_NOT_FOUND, "no attached USB device has the key $key")

    private fun attachmentFor(device: UsbDeviceInfo): Attachment = synchronized(lock) {
        attachments[device.key] ?: Attachment(device, "${device.key}#${++attachmentCount}").also {
            attachments[device.key] = it
            byKey[it.key] = it
        }
    }

    /** Worker thread. */
    private fun openSession(attachment: Attachment) {
        if (synchronized(lock) { attachment.key in sessions }) return
        // Attach broadcasts precede permission. Refresh now so a readable serial is not lost.
        val device = env.backend.list(listOf(CB5100)).firstOrNull { it.key == attachment.device.key }
            ?: throw UsbFailure.Detached(attachment.device.key)
        val connection = env.backend.open(device)
        try {
            val hid = env.backend.findHidInterface(device)
                ?: throw UsbBridgeException(ErrorCodes.USB_NOT_FOUND, "${attachment.key} has no HID interface")
            val raw = env.backend.rawDescriptors(connection)
            val length = UsbDescriptors.hidReportDescriptorLength(raw, hid.id, hid.alternateSetting)
                ?: MAX_REPORT_DESCRIPTOR_BYTES
            val reportDescriptor = env.backend.hidReportDescriptor(connection, hid.id, length)
            val parsed = try {
                HidReportDescriptor.parse(reportDescriptor)
            } catch (malformed: HidDescriptorException) {
                throw UsbBridgeException(
                    ErrorCodes.USB_TRANSFER_FAILED,
                    "malformed HID report descriptor: ${malformed.message}",
                    malformed,
                )
            }
            val session = Session(
                attachment = attachment,
                connection = connection,
                hidInterface = hid,
                rawDescriptors = raw,
                reportDescriptor = reportDescriptor,
                descriptor = parsed,
                interruptOut = hid.interruptOut,
                wireLog = if (env.isDebug) WireLog() else null,
                identity = PhysicalDeviceIdentity(device.vendorId, device.productId, device.serialNumber),
            )
            val stored = synchronized(lock) {
                (byKey[attachment.key] === attachment).also { current -> if (current) sessions[attachment.key] = session }
            }
            if (!stored) throw UsbFailure.Detached(device.key)
        } catch (error: Exception) {
            try {
                env.claims.onClosed(connection)
                env.backend.close(connection)
            } catch (closeError: Exception) {
                error.addSuppressed(closeError)
            }
            throw error
        }
    }

    /** Worker thread. Resolves or rejects [call] only after the key accepts a new report. */
    private fun send(call: PluginCall, attachment: Attachment, reportId: Int, data: ByteArray) {
        val key = attachment.key
        val failure: Exception? = try {
            val session = synchronized(lock) { sessions[key] }
                ?: throw UsbBridgeException(ErrorCodes.USB_NOT_OPEN, "$key is not open")
            // An open handle outlives a revoked grant: check it again before the guard and any I/O.
            if (!env.backend.hasPermission(attachment.device)) throw revoked(session)
            val generation = synchronized(lock) {
                val decision = guards.onReport(key, reportId, data, env.clock(), session.identity)
                if (decision is FrameGuard.Decision.Reject) {
                    throw UsbBridgeException(ErrorCodes.USB_GUARD_REJECTED, decision.reason.message)
                }
                attachment.generation
            }
            transmit(session, generation, reportId, data)
            null
        } catch (error: Exception) {
            synchronized(lock) { resetGuard(attachment) }
            if (error is UsbFailure.Detached) drop(attachment)
            error
        }
        synchronized(lock) { sending.remove(key) }
        if (failure == null) call.resolve() else reject(call, failure)
    }

    /**
     * Worker thread: the USB permission of [session] was revoked. Its session is closed, so the
     * page gets `USB_NOT_OPEN` until it reopens the device under a new permission. The caller
     * resets the guard. A failed close is attached to the returned `USB_PERMISSION_DENIED`.
     */
    private fun revoked(session: Session): UsbBridgeException {
        val key = session.attachment.key
        val denied = UsbBridgeException(ErrorCodes.USB_PERMISSION_DENIED, "USB permission for $key was revoked")
        synchronized(lock) { sessions.remove(key) }
        try {
            closeConnection(session)
        } catch (closeError: Exception) {
            denied.addSuppressed(closeError)
        }
        return denied
    }

    /** Worker thread: frames [data], claims the HID interface and sends it on the session's route. */
    private fun transmit(session: Session, generation: Long, reportId: Int, data: ByteArray) {
        val buffer = HidFraming.buildOutput(reportId, data, session.descriptor)
        val sent = env.claims.withClaim(session.connection, session.hidInterface) {
            // Claiming can race stop/navigation. This check linearizes the start of the transfer;
            // never hold the bridge lock during blocking backend I/O (detach must remain live).
            synchronized(lock) {
                val attachment = session.attachment
                if (attachment.generation != generation || sessions[attachment.key] !== session) {
                    throw UsbBridgeException(ErrorCodes.USB_GUARD_REJECTED, "write sequence reset before USB transfer")
                }
            }
            val endpoint = session.interruptOut
            if (endpoint != null) {
                env.backend.transferInterrupt(session.connection, endpoint, buffer, UsbBackend.DEFAULT_TIMEOUT_MS)
            } else {
                val setup = HidFraming.setReportSetup(reportId, session.hidInterface.id, buffer.size)
                env.backend.controlOut(
                    session.connection,
                    ControlSetup(setup.requestType, setup.request, setup.value, setup.index),
                    buffer,
                    UsbBackend.DEFAULT_TIMEOUT_MS,
                )
            }
        }
        if (sent != buffer.size) {
            throw UsbBridgeException(ErrorCodes.USB_TRANSFER_FAILED, "short write: $sent of ${buffer.size} bytes")
        }
        session.wireLog?.record(env.clock(), buffer)
    }

    /** Worker thread. */
    private fun closeConnection(session: Session) {
        env.claims.onClosed(session.connection)
        env.backend.close(session.connection)
    }

    private fun attached(device: UsbDeviceInfo) {
        // An attach for a name we still hold means its detach was missed: that key is gone.
        synchronized(lock) { attachments[device.key] }?.let(::drop)
        if (CB5100.matches(device)) emit(EVENT_CONNECT, attachmentFor(device))
    }

    private fun detached(device: UsbDeviceInfo) {
        synchronized(lock) { attachments[device.key] }?.let(::drop)
    }

    /**
     * Forgets [attachment] once: its key, its session and its sequence, then emits `disconnect`.
     * Runs on the detach path before the pending call of that device is rejected.
     */
    private fun drop(attachment: Attachment) {
        val session = synchronized(lock) {
            if (attachments[attachment.device.key] !== attachment) return
            attachments.remove(attachment.device.key)
            byKey.remove(attachment.key)
            resetGuard(attachment)
            sessions.remove(attachment.key)
        }
        if (session != null) background { closeConnection(session) }
        emit(EVENT_DISCONNECT, attachment)
    }

    private fun emit(event: String, attachment: Attachment) {
        if (env.origin.isAllowed()) notifyListeners(event, JSObject().put("device", deviceJson(attachment)))
    }

    private fun resetAllGuards() {
        synchronized(lock) { byKey.values.forEach(::resetGuard) }
    }

    /** Session lock held. Invalidated Forward decisions fail with USB_GUARD_REJECTED. */
    private fun resetGuard(attachment: Attachment) {
        attachment.generation++
        guards.reset(attachment.key)
    }

    private fun deviceJson(attachment: Attachment): JSObject = JSObject()
        .put("key", attachment.key)
        .put("vendorId", attachment.device.vendorId)
        .put("productId", attachment.device.productId)
        .put("productName", attachment.device.productName.orEmpty())

    companion object {
        /** Plugin name seen by the page (`registerPlugin('OpenAuriUsb')`). */
        const val NAME: String = "OpenAuriUsb"

        /** Contract version of this bridge (plan 0.19). */
        const val BRIDGE_API: Int = 1

        /**
         * `getInfo().liveApply`: an optional bridgeApi 1 capability, not a version bump. True since
         * [FrameGuard] accepts a valid data report 0 in AwaitCommit (plan Anexo D.3).
         */
        const val LIVE_APPLY: Boolean = true

        /** Event sent when a CB5100 is plugged in. */
        const val EVENT_CONNECT: String = "connect"

        /** Event sent when a device with a key is unplugged. */
        const val EVENT_DISCONNECT: String = "disconnect"

        /** Report descriptor bytes asked for when the HID descriptor does not declare its length. */
        const val MAX_REPORT_DESCRIPTOR_BYTES: Int = 4096

        /** The CB5100 DSP cable (plan RF2). */
        val CB5100: UsbFilter = UsbFilter(vendorId = 0x3302, productId = 0x8902)

        private const val TAG = "OpenAuriUsb"
        private const val WORKER_IDLE_SECONDS = 30L

        /** The production worker: one daemon thread, FIFO, that exits when idle. */
        internal fun newWorker(): ExecutorService =
            ThreadPoolExecutor(1, 1, WORKER_IDLE_SECONDS, TimeUnit.SECONDS, LinkedBlockingQueue()) { task ->
                Thread(task, "openauri-usb-bridge").apply { isDaemon = true }
            }.apply { allowCoreThreadTimeOut(true) }
    }
}

/** Argument checks of the bridge methods; every failure is [ErrorCodes.USB_BAD_ARGS]. */
internal object BridgeArgs {
    private const val VENDOR_ID = "vendorId"
    private const val PRODUCT_ID = "productId"
    private const val MAX_UINT8 = 0xFF
    private const val MAX_UINT16 = 0xFFFF

    /** Longest base64 accepted for `data`: the largest report a HID descriptor can declare. */
    val MAX_DATA_BASE64_LENGTH: Int = (HidReportDescriptor.MAX_REPORT_BYTES + 2) / 3 * 4

    /** `key`: a non-empty string. */
    fun key(data: JSObject): String {
        val key = data.opt("key")
        if (key !is String || key.isEmpty()) throw bad("key must be a non-empty string")
        return key
    }

    /** `reportId`: an integer in 0..255. */
    fun reportId(data: JSObject): Int {
        val reportId = data.opt("reportId")
        if (reportId !is Int || reportId !in 0..MAX_UINT8) throw bad("reportId must be an integer in 0..255")
        return reportId
    }

    /** `data`: standard base64 (RFC 4648, padding optional) of at most [MAX_DATA_BASE64_LENGTH] chars. */
    fun data(data: JSObject): ByteArray {
        val encoded = data.opt("data")
        if (encoded !is String) throw bad("data must be a base64 string")
        if (encoded.length > MAX_DATA_BASE64_LENGTH) throw bad("data is longer than any HID report")
        return try {
            Base64.getDecoder().decode(encoded)
        } catch (invalid: IllegalArgumentException) {
            throw UsbBridgeException(ErrorCodes.USB_BAD_ARGS, "data is not valid base64", invalid)
        }
    }

    /** `filters`: an array of `{vendorId?, productId?}` with 16-bit integers and nothing else. */
    fun filters(data: JSObject): List<UsbFilter> {
        val filters = data.opt("filters") as? JSONArray ?: throw bad("filters must be an array")
        return List(filters.length()) { index ->
            val filter = filters.opt(index) as? JSONObject ?: throw bad("filters[$index] must be an object")
            val unknown = filter.keys().asSequence().filter { it != VENDOR_ID && it != PRODUCT_ID }.toList()
            if (unknown.isNotEmpty()) throw bad("filters[$index] has unsupported members: ${unknown.joinToString()}")
            UsbFilter(uint16(filter, index, VENDOR_ID), uint16(filter, index, PRODUCT_ID))
        }
    }

    private fun uint16(filter: JSONObject, index: Int, name: String): Int? {
        if (!filter.has(name)) return null
        val value = filter.opt(name)
        if (value !is Int || value !in 0..MAX_UINT16) throw bad("filters[$index].$name must be an integer in 0..65535")
        return value
    }

    private fun bad(message: String) = UsbBridgeException(ErrorCodes.USB_BAD_ARGS, message)
}
