package com.openauri.usb

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.networknt.schema.InputFormat
import com.networknt.schema.Schema
import com.networknt.schema.SchemaRegistry
import com.networknt.schema.SpecificationVersion
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The bridge contract `schemas/android-usb-bridge-1.schema.json`, compiled with networknt for
 * draft 2020-12. Every [BridgeCall] and [ListenerCall] of every test validates what the plugin
 * sends through it; violations are collected here and fail the test in its `@After`.
 */
internal object BridgeSchema {
    const val PATH: String = "schemas/android-usb-bridge-1.schema.json"
    const val ID: String = "https://open-auri.com/schemas/android-usb-bridge-1.schema.json"

    val document: JSONObject by lazy { JSONObject(ProtocolFixtureTest.repoText(PATH)) }

    private val registry: SchemaRegistry by lazy { SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12) }
    private val compiled = HashMap<String, Schema>()
    private val violations: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val validated = ConcurrentHashMap<String, AtomicInteger>()

    /** Codes of every rejection validated since the last [resetCounters]. */
    val rejectedCodes: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())

    /** Names of every `$defs` entry. */
    val definitions: List<String> by lazy { document.getJSONObject("\$defs").keys().asSequence().toList() }

    /**
     * The schema of `$defs/[definition]`: the whole document with a root `$ref` to it (the `$id`
     * is dropped so each compiled copy stays independent in the registry).
     */
    @Synchronized
    fun schema(definition: String): Schema = compiled.getOrPut(definition) {
        require(definition in definitions) { "the bridge schema has no \$defs/$definition" }
        val root = JSONObject(document.toString())
        root.remove("\$id")
        root.put("\$ref", "#/\$defs/$definition")
        registry.getSchema(root.toString(), InputFormat.JSON)
    }

    /** Validation errors of [json] against `$defs/[definition]`. */
    fun errors(definition: String, json: String): List<String> =
        schema(definition).validate(json, InputFormat.JSON).map { it.toString() }

    /** Validates something the plugin sent; a violation is recorded and fails the test later. */
    fun check(definition: String, json: String, context: String) {
        validated.getOrPut(definition) { AtomicInteger() }.incrementAndGet()
        val errors = errors(definition, json)
        if (errors.isNotEmpty()) violations += "$context: $json is not a valid $definition: $errors"
    }

    /** Records a violation that is not a schema mismatch (e.g. a call completed twice). */
    fun violation(message: String) {
        violations += message
    }

    /** How many payloads were validated against [definition] since the last [resetCounters]. */
    fun validatedCount(definition: String): Int = validated[definition]?.get() ?: 0

    fun resetCounters() {
        validated.clear()
        rejectedCodes.clear()
    }

    /** Fails with every recorded violation, and clears them. */
    fun assertNoViolations() {
        val recorded = synchronized(violations) { violations.toList().also { violations.clear() } }
        assertTrue(recorded.joinToString("\n"), recorded.isEmpty())
    }
}

/**
 * A real [PluginCall] whose answer is captured instead of posted to a WebView. The request is
 * checked against `<Method>Request` ([validRequest] true: must pass; false: must fail, for the
 * USB_BAD_ARGS cases; null: not part of the schema), the answer against `<Method>Response` or
 * `Error`, and the order of answers is appended to [journal].
 */
internal open class BridgeCall(
    private val method: String,
    data: JSObject = JSObject(),
    private val journal: MutableList<String>? = null,
    validRequest: Boolean? = true,
) : PluginCall(null, OpenAuriUsbPlugin.NAME, "call-${ids.incrementAndGet()}", method, data) {

    private val done = CountDownLatch(1)
    private val completions = AtomicInteger()

    /** True once resolved. */
    @Volatile var resolved: Boolean = false
        private set

    /** The resolved payload; null for a resolve without data. */
    @Volatile var payload: JSObject? = null
        private set

    /** Code of the rejection. */
    @Volatile var code: String? = null
        private set

    /** Message of the rejection. */
    @Volatile var message: String? = null
        private set

    /** Whether the call was answered at all. */
    val completed: Boolean
        get() = done.count == 0L

    init {
        val requestDefinition = "${definitionPrefix(method)}Request"
        when (validRequest) {
            true -> {
                val errors = BridgeSchema.errors(requestDefinition, data.toString())
                if (errors.isNotEmpty()) BridgeSchema.violation("$method request $data is not a valid $requestDefinition: $errors")
            }
            false -> if (BridgeSchema.errors(requestDefinition, data.toString()).isEmpty()) {
                BridgeSchema.violation("$method request $data is invalid for the plugin but valid for $requestDefinition")
            }
            null -> Unit
        }
    }

    override fun resolve(data: JSObject) {
        checkResponse(data.toString())
        payload = data
        finish("resolve:$method")
        resolved = true
    }

    override fun resolve() {
        checkResponse("null")
        finish("resolve:$method")
        resolved = true
    }

    override fun reject(msg: String?, code: String?, ex: Exception?, data: JSObject?) {
        val error = JSObject()
        error.put("message", msg)
        error.put("code", code)
        if (data != null) error.put("data", data)
        BridgeSchema.check("Error", error.toString(), "$method rejection")
        code?.let { BridgeSchema.rejectedCodes += it }
        this.code = code
        this.message = msg
        finish("reject:$method:$code")
    }

    /** Waits (bounded) for the answer. */
    fun await(): BridgeCall {
        assertTrue("$method was not answered", done.await(5, TimeUnit.SECONDS))
        return this
    }

    /** The keys of a `{devices}` answer. */
    fun deviceKeys(): List<String> {
        val devices = checkNotNull(payload) { "$method resolved without payload (code $code)" }.getJSONArray("devices")
        return List(devices.length()) { devices.getJSONObject(it).getString("key") }
    }

    private fun checkResponse(json: String) {
        if (method in LISTENER_METHODS) return
        BridgeSchema.check("${definitionPrefix(method)}Response", json, "$method response")
    }

    private fun finish(entry: String) {
        if (completions.incrementAndGet() > 1) BridgeSchema.violation("$method answered twice ($entry)")
        journal?.add(entry)
        done.countDown()
    }

    companion object {
        private val ids = AtomicInteger()

        /** Capacitor's listener methods: their payloads are Capacitor's, not the bridge's. */
        val LISTENER_METHODS = setOf("addListener", "removeListener", "removeAllListeners")

        fun definitionPrefix(method: String): String = method.replaceFirstChar { it.uppercase() }
    }
}

/**
 * The `addListener` call of [eventName]: every event the plugin notifies through it is checked
 * against `ConnectEvent` / `DisconnectEvent` and journaled as `event:<name>:<key>`.
 */
internal class ListenerCall(private val eventName: String, private val journal: MutableList<String>? = null) :
    BridgeCall("addListener", JSObject().put("eventName", eventName), journal, validRequest = null) {

    /** Device keys of the events received, in order. */
    val keys: MutableList<String> = Collections.synchronizedList(mutableListOf())

    override fun resolve(data: JSObject) {
        val definition = "${BridgeCall.definitionPrefix(eventName)}Event"
        BridgeSchema.check(definition, data.toString(), "$eventName event")
        val key = data.getJSONObject("device").getString("key")
        keys += key
        journal?.add("event:$eventName:$key")
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class BridgeSchemaTest {

    @After
    fun noViolations() {
        BridgeSchema.assertNoViolations()
    }

    @Test
    fun documentIsDraft202012WithThePublishedId() {
        assertEquals("https://json-schema.org/draft/2020-12/schema", BridgeSchema.document.getString("\$schema"))
        assertEquals(BridgeSchema.ID, BridgeSchema.document.getString("\$id"))
        BridgeSchema.definitions.forEach { BridgeSchema.schema(it) }
    }

    @Test
    fun errorCodeEnumIsAnexoC() {
        val enum = BridgeSchema.document.getJSONObject("\$defs").getJSONObject("ErrorCode").getJSONArray("enum")
        assertEquals(ErrorCodes.ALL, List(enum.length()) { enum.getString(it) })
    }

    @Test
    fun everyPluginMethodHasARequestAndAResponse() {
        val methods = OpenAuriUsbPlugin::class.java.declaredMethods
            .filter { it.isAnnotationPresent(PluginMethod::class.java) }
            .map { it.name }
            .filterNot { it in BridgeCall.LISTENER_METHODS }
            .toSet()
        assertEquals(setOf("getInfo", "requestDevice", "getDevices", "open", "close", "sendReport", "diagnostics"), methods)
        for (method in methods) {
            val prefix = BridgeCall.definitionPrefix(method)
            assertTrue("$prefix Request", "${prefix}Request" in BridgeSchema.definitions)
            assertTrue("$prefix Response", "${prefix}Response" in BridgeSchema.definitions)
        }
        assertTrue("ConnectEvent" in BridgeSchema.definitions)
        assertTrue("DisconnectEvent" in BridgeSchema.definitions)
    }

    @Test
    fun schemaRejectsPayloadsOutsideTheContract() {
        val device = """{"key":"/dev/bus/usb/001/002#1","vendorId":13058,"productId":35074,"productName":"USB DSP Audio"}"""
        assertValid("NativeDeviceInfo", device)
        assertValid("ConnectEvent", """{"device":$device}""")
        assertValid("GetInfoResponse", """{"bridgeApi":1,"appVersion":"1.0.0","usbHost":true,"webViewVersion":"140.0"}""")
        assertValid("GetInfoResponse", """{"bridgeApi":1,"appVersion":"1.0.0","usbHost":true,"webViewVersion":"140.0","liveApply":true}""")
        assertValid("GetInfoResponse", """{"bridgeApi":1,"appVersion":"1.0.0","usbHost":true,"webViewVersion":"140.0","liveApply":false}""")
        assertValid("Error", """{"code":"USB_TIMEOUT","message":"timed out"}""")
        assertValid("OpenResponse", "null")
        assertValid("SendReportRequest", """{"key":"k","reportId":203,"data":"AQID"}""")
        assertValid("SendReportRequest", """{"key":"k","reportId":0,"data":""}""")
        assertValid("RequestDeviceRequest", """{"filters":[]}""")
        val invalid = mapOf(
            "NativeDeviceInfo" to listOf(
                """{"key":"/dev/bus/usb/001/002","vendorId":1,"productId":1,"productName":""}""",
                """{"key":"a#0","vendorId":1,"productId":1,"productName":""}""",
                """{"key":"a#1","vendorId":65536,"productId":1,"productName":""}""",
                """{"key":"a#1","vendorId":1,"productId":1}""",
                """{"key":"a#1","vendorId":1,"productId":1,"productName":"","serial":"x"}""",
            ),
            "GetInfoResponse" to listOf(
                """{"bridgeApi":2,"appVersion":"1","usbHost":true,"webViewVersion":"1"}""",
                """{"bridgeApi":1,"appVersion":"","usbHost":true,"webViewVersion":"1"}""",
                """{"bridgeApi":1,"appVersion":"1","usbHost":"yes","webViewVersion":"1"}""",
                """{"bridgeApi":1,"appVersion":"1","usbHost":true,"webViewVersion":"1","liveApply":"yes"}""",
            ),
            "Error" to listOf(
                """{"code":"USB_OTHER","message":"x"}""",
                """{"message":"x"}""",
                """{"code":"USB_BUSY","message":"x","data":{}}""",
            ),
            "OpenResponse" to listOf("{}"),
            "SendReportRequest" to listOf(
                """{"key":"","reportId":1,"data":""}""",
                """{"key":"k","reportId":256,"data":""}""",
                """{"key":"k","reportId":1.5,"data":""}""",
                """{"key":"k","reportId":1,"data":"A"}""",
                """{"key":"k","reportId":1,"data":"AA="}""",
                """{"key":"k","reportId":1,"data":"AA AA"}""",
            ),
            "RequestDeviceRequest" to listOf("{}", """{"filters":[{"usagePage":65280}]}"""),
            "DiagnosticsResponse" to listOf("{}"),
            "Hex" to listOf("\"0A\"", "\"abc\""),
        )
        for ((definition, samples) in invalid) {
            for (sample in samples) {
                assertTrue("$sample must not be a valid $definition", BridgeSchema.errors(definition, sample).isNotEmpty())
            }
        }
    }

    @Test
    fun diagnosticsSchemaAcceptsTheWireLogAndRejectsMalformedEntries() {
        val base = JSONObject(
            """{"device":{"key":"d#1","vendorId":1,"productId":2,"productName":""},"appVersion":"1",""" +
                """"androidVersion":"16 (API 36)","webViewVersion":"unknown","rawDescriptorsHex":"1201",""" +
                """"hidInterfaceId":2,"endpoints":[{"address":4,"type":"isochronous","direction":"out","maxPacketSize":64}],""" +
                """"reportDescriptorHex":"","outputReports":[{"reportId":203,"bytes":31}],"transfer":"control",""" +
                """"paddedLength":32,"kernelDriverDetached":false}""",
        )
        assertValid("UsbDiagnostics", base.toString())
        // abandonedSequences is optional (absent in older apps) and never negative.
        base.put("abandonedSequences", 3)
        assertValid("UsbDiagnostics", base.toString())
        base.put("abandonedSequences", -1)
        assertTrue(BridgeSchema.errors("UsbDiagnostics", base.toString()).isNotEmpty())
        base.remove("abandonedSequences")
        base.put("wireLog", JSArray().put(JSObject().put("atMs", 5).put("hex", "cb00")))
        assertValid("UsbDiagnostics", base.toString())
        base.put("wireLog", JSArray().put(JSObject().put("atMs", 5)))
        assertTrue(BridgeSchema.errors("UsbDiagnostics", base.toString()).isNotEmpty())
        base.put("wireLog", JSArray())
        base.put("transfer", "bulk")
        assertTrue(BridgeSchema.errors("UsbDiagnostics", base.toString()).isNotEmpty())
    }

    /**
     * Drives every method, both events and every error code through the plugin and checks that
     * each response definition, both events and the error object were validated at least once.
     */
    @Test
    fun everyResponseEventAndErrorOfThePluginMatchesTheSchema() {
        BridgeSchema.resetCounters()
        for (debug in listOf(false, true)) exerciseTheWholeContract(debug)
        val expected = listOf(
            "GetInfoResponse", "RequestDeviceResponse", "GetDevicesResponse", "OpenResponse", "CloseResponse",
            "SendReportResponse", "DiagnosticsResponse", "ConnectEvent", "DisconnectEvent", "Error",
        )
        for (definition in expected) {
            assertTrue("nothing was validated against $definition", BridgeSchema.validatedCount(definition) > 0)
        }
        assertEquals(ErrorCodes.ALL.toSet(), BridgeSchema.rejectedCodes.toSet())
    }

    private fun exerciseTheWholeContract(debug: Boolean) {
        val first = FakeUsbBackend.cable("/dev/bus/usb/001/002")
        val second = FakeUsbBackend.cable("/dev/bus/usb/001/003")
        val harness = UsbPluginHarness(devices = listOf(first, second), isDebug = debug)
        assertTrue(harness.call("getInfo").resolved)
        assertEquals(emptyList<String>(), harness.call("getDevices").deviceKeys())
        val keys = harness.requestDevice(listOf(JSObject().put("vendorId", 0x3302))).deviceKeys()
        assertEquals(2, keys.size)
        val key = keys.first()
        assertEquals(keys, harness.call("getDevices").deviceKeys())
        assertTrue(harness.open(key).resolved)
        harness.writeCurve(key, ProtocolFixtureTest.neutral).forEach { assertTrue(it.resolved) }
        assertTrue(harness.diagnostics(key).resolved)
        assertTrue(harness.close(key).resolved)

        // One rejection of every code of Anexo C.
        val reports = ProtocolFixtureTest.neutral.reports
        val badArgs = JSObject().put("key", key).put("reportId", 300).put("data", "")
        assertEquals(ErrorCodes.USB_BAD_ARGS, harness.call("sendReport", badArgs, validRequest = false).code)
        assertEquals(ErrorCodes.USB_NOT_FOUND, harness.open("/dev/bus/usb/009/009#9").code)
        assertEquals(ErrorCodes.USB_NOT_OPEN, harness.send(key, 0xCB, reports[0]).code)
        assertTrue(harness.open(key).resolved)
        assertEquals(ErrorCodes.USB_GUARD_REJECTED, harness.send(key, 0xCB, ProtocolConstants.commitReport()).code)
        harness.fake.faults.failAtReport = harness.fake.attempts
        assertEquals(ErrorCodes.USB_TRANSFER_FAILED, harness.send(key, 0xCB, reports[0]).code)
        harness.fake.faults.timeoutAtReport = harness.fake.attempts
        assertEquals(ErrorCodes.USB_TIMEOUT, harness.send(key, 0xCB, reports[0]).code)
        harness.worker.queued = true
        val pending = harness.send(key, 0xCB, reports[0])
        assertEquals(ErrorCodes.USB_BUSY, harness.send(key, 0xCB, reports[0]).code)
        harness.worker.runAll()
        harness.worker.queued = false
        assertTrue(pending.resolved)
        harness.fake.faults.detachAtReport = harness.fake.attempts
        assertEquals(ErrorCodes.USB_DETACHED, harness.send(key, 0xCB, reports[1]).code)
        harness.fake.attach(FakeUsbBackend.cable("/dev/bus/usb/001/004"))
        assertEquals(ErrorCodes.USB_PERMISSION_DENIED, harness.open(harness.connects.keys.last()).code)
        harness.pageUrl = "https://example.com/"
        assertEquals(ErrorCodes.USB_ORIGIN, harness.call("getInfo").code)
        harness.pageUrl = UsbPluginHarness.PAGE
        harness.fake.hostSupported = false
        assertEquals(ErrorCodes.USB_NO_HOST, harness.call("getDevices").code)
        harness.fake.hostSupported = true
        harness.fake.detach(second.key)
        assertEquals(keys, harness.disconnects.keys)
    }

    private fun assertValid(definition: String, json: String) {
        val errors = BridgeSchema.errors(definition, json)
        assertTrue("$json is not a valid $definition: $errors", errors.isEmpty())
    }
}
