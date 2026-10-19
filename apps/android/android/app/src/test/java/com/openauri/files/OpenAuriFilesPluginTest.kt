package com.openauri.files

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.activity.result.ActivityResult
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.openauri.usb.OriginGuard
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.Base64
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

internal class QueuedExecutor : AbstractExecutorService() {
    private val tasks = ArrayDeque<Runnable>()
    private var stopped = false
    override fun execute(command: Runnable) {
        if (stopped) throw RejectedExecutionException("Executor stopped")
        tasks.add(command)
    }
    fun runAll() { while (tasks.isNotEmpty()) tasks.removeFirst().run() }
    override fun shutdown() { stopped = true }
    override fun shutdownNow(): MutableList<Runnable> { shutdown(); return tasks.toMutableList().also { tasks.clear() } }
    override fun isShutdown() = stopped
    override fun isTerminated() = stopped && tasks.isEmpty()
    override fun awaitTermination(timeout: Long, unit: TimeUnit) = isTerminated
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class OpenAuriFilesPluginTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val uri = Uri.parse("content://openauri.test/chosen-file")
    private val direct = Executor { it.run() }

    private class Call(data: JSObject) : PluginCall(null, "OpenAuriFiles", "test", "save", data) {
        var saved: Boolean? = null
        var code: String? = null
        var message: String? = null
        var error: Exception? = null
        override fun resolve(data: JSObject) { saved = data.getBoolean("saved") }
        override fun reject(message: String, code: String, error: Exception) {
            this.message = message; this.code = code; this.error = error
        }
    }

    private open class TestPlugin(
        private val app: Context,
        worker: ExecutorService,
        main: Executor,
        origin: OriginGuard? = OriginGuard({ "https://open-auri.com" }, { "https://open-auri.com/conta" }),
    ) : OpenAuriFilesPlugin(worker, main, origin) {
        var launched: Intent? = null
        var callback: String? = null
        var launchError: Exception? = null
        override fun getContext() = app
        override fun startActivityForResult(call: PluginCall, intent: Intent, callbackName: String) {
            launchError?.let { throw it }
            launched = intent; callback = callbackName
        }
        fun deliver(code: Int, uri: Uri? = null) = fileCreated(null, ActivityResult(code, uri?.let { Intent().setData(it) }))
        fun deliverEmptyIntent() = fileCreated(null, ActivityResult(Activity.RESULT_OK, Intent()))
        fun destroy() = handleOnDestroy()
        fun state() = saveInstanceState()
    }

    private fun call(name: String = "../../export.json", mime: String = "application/json", base64: String = "AAECA/8=") =
        Call(JSObject().put("name", name).put("mime", mime).put("base64", base64))

    private fun bad(code: String, block: () -> Unit) {
        assertEquals(code, assertThrows(FilesException::class.java) { block() }.code)
    }

    @Test fun namesStripTraversalControlsAndLeadingDotsWithoutLosingUnicode() {
        val examples = mapOf(
            "../../etc/passwd" to "etcpasswd", "a\\b" to "ab", "..." to "download", "" to "download",
            "\u0000\u001F\u007F" to "download", "a\u0000b\u001Fc\u007Fd" to "abcd",
            " . .hidden" to "hidden", "  a\u2003\u00A0 b  " to "a b", "ação-音楽-🎵.json" to "ação-音楽-🎵.json",
        )
        examples.forEach { (input, expected) -> assertEquals(input, expected, FileNames.sanitize(input)) }
        assertEquals("a".repeat(123) + ".json", FileNames.sanitize("a".repeat(300) + ".json"))
        assertEquals("a".repeat(128), FileNames.sanitize("a".repeat(300)))
        assertEquals("a." + "b".repeat(126), FileNames.sanitize("a." + "b".repeat(300)))
        assertEquals("a".repeat(128), FileNames.sanitize("a".repeat(128)))
        val unicode = FileNames.sanitize("🎵".repeat(300) + ".png")
        assertEquals(128, unicode.codePointCount(0, unicode.length))
        assertTrue(unicode.endsWith(".png"))
        assertFalse(unicode.contains('\uFFFD'))
    }

    @Test fun namesStripBidiFormattingAndEveryC1Control() {
        assertEquals("agpj.json", FileNames.sanitize("a\u202Egpj.json"))
        val controls = (0x80..0x9F) + (0x202A..0x202E) + (0x2066..0x2069) + listOf(0x200E, 0x200F)
        for (control in controls) assertEquals("ab.json", FileNames.sanitize("a${control.toChar()}b.json"))
    }

    @Test fun unknownOriginRejectsBeforeParsingOrLaunchingSaf() {
        val worker = QueuedExecutor()
        val plugin = TestPlugin(context, worker, direct, null)
        val invalid = Call(JSObject())
        plugin.save(invalid)
        worker.runAll()
        assertEquals("FILES_ORIGIN", invalid.code)
        assertNull(plugin.launched)
    }

    @Test fun originGuardTracksNavigationAndRejectsLocalErrorPageBeforeArgumentsOrBusy() {
        val worker = QueuedExecutor()
        var current: String? = "https://open-auri.com/conta"
        val plugin = TestPlugin(context, worker, direct, OriginGuard({ "https://open-auri.com" }, { current }))
        val first = call()
        plugin.save(first)
        for (url in listOf(null, "https://localhost/offline.html", "https://evil.example", "https://open-auri.com:444/")) {
            current = url
            val denied = Call(JSObject())
            plugin.save(denied)
            assertEquals("FILES_ORIGIN", denied.code)
            assertNull(plugin.launched)
        }
        current = "https://OPEN-AURI.com:443/conta"
        val stillBusy = call()
        plugin.save(stillBusy)
        assertEquals("FILES_BUSY", stillBusy.code)
        worker.runAll()
        assertNotNull(plugin.launched)
        plugin.deliver(Activity.RESULT_CANCELED)
        assertEquals(false, first.saved)
        val retry = call()
        plugin.save(retry); worker.runAll(); plugin.deliver(Activity.RESULT_CANCELED)
        assertEquals(false, retry.saved)
    }

    @Test fun parsingRequiresStringsAndExactlyTheMimeAllowList() {
        for (mime in FileMimeTypes.allowed) {
            val request = FileSaveRequest.parse("a", mime, "YQ==")
            assertEquals(mime, request.mime)
            assertEquals("a", request.name)
            assertArrayEquals(byteArrayOf(97), request.bytes)
        }
        for (mime in listOf(null, "text/html", "text/plain; charset=utf-8", "TEXT/PLAIN", "")) {
            bad("FILES_BAD_ARGS") { FileSaveRequest.parse("a", mime, "") }
        }
        bad("FILES_BAD_ARGS") { FileSaveRequest.parse(null, "text/plain", "") }
        bad("FILES_BAD_ARGS") { FileSaveRequest.parse("a", "text/plain", null) }
        bad("FILES_BAD_ARGS") { FileSaveRequest.fromBytes("a", "text/html", byteArrayOf()) }
        assertArrayEquals(byteArrayOf(), FileSaveRequest.parse("", "text/plain", "").bytes)
        assertArrayEquals(byteArrayOf(97), FileSaveRequest.parse("a", "text/plain", "YQ").bytes)
        for (encoded in listOf("%bad", "Y Q==", "A", "==", "AAA=AA==")) {
            bad("FILES_BAD_ARGS") { FileSaveRequest.parse("a", "text/plain", encoded) }
        }
    }

    @Test fun fiftyMegabytesAreAcceptedExactly() {
        val bytes = ByteArray(MAX_FILE_BYTES) { (it % 251).toByte() }
        val request = FileSaveRequest.parse("big.bin", FileMimeTypes.BINARY, Base64.getEncoder().encodeToString(bytes))
        assertArrayEquals(bytes, request.bytes)
    }

    @Test fun oversizeIsRefusedBeforeDecodeIncludingSameEncodedLengthAsTheLimit() {
        val bytes = ByteArray(MAX_FILE_BYTES + 1)
        bad("FILES_TOO_LARGE") { FileSaveRequest.parse("big", FileMimeTypes.BINARY, Base64.getEncoder().encodeToString(bytes)) }
        bad("FILES_TOO_LARGE") { FileSaveRequest.fromBytes("big", FileMimeTypes.BINARY, bytes) }
        // Invalid alphabet deliberately proves the encoded-length check runs before decoding.
        bad("FILES_TOO_LARGE") { FileSaveRequest.parse("big", FileMimeTypes.BINARY, "%".repeat(((MAX_FILE_BYTES + 2) / 3) * 4 + 1)) }
    }

    @Test fun pluginMetadataAndSafIntentUseCapacitorActivityResultsAndNeverWriteBeforeConsent() {
        assertEquals("OpenAuriFiles", requireNotNull(OpenAuriFilesPlugin::class.java.getAnnotation(CapacitorPlugin::class.java)).name)
        assertNotNull(OpenAuriFilesPlugin::class.java.getConstructor())
        assertNotNull(OpenAuriFilesPlugin::class.java.getDeclaredMethod("fileCreated", PluginCall::class.java, ActivityResult::class.java).getAnnotation(ActivityCallback::class.java))
        val worker = QueuedExecutor()
        val plugin = TestPlugin(context, worker, direct)
        val output = ByteArrayOutputStream()
        shadowOf(context.contentResolver).registerOutputStream(uri, output)
        val call = call()
        plugin.save(call)
        assertNull(plugin.launched)
        assertNull(call.saved)
        worker.runAll()
        val intent = requireNotNull(plugin.launched)
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.action)
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE))
        assertEquals("application/json", intent.type)
        assertEquals("export.json", intent.getStringExtra(Intent.EXTRA_TITLE))
        assertEquals("fileCreated", plugin.callback)
        assertNull(plugin.state())
        assertEquals(0, output.size())
        plugin.deliver(Activity.RESULT_OK, uri)
        assertEquals(0, output.size())
        worker.runAll()
        assertEquals(true, call.saved)
        assertArrayEquals(byteArrayOf(0, 1, 2, 3, -1), output.toByteArray())
        plugin.deliver(Activity.RESULT_OK, uri) // Duplicate activity results cannot write again.
        worker.runAll()
        assertEquals(5, output.size())
        plugin.destroy()
        assertTrue(worker.isShutdown)
    }

    @Test fun cancelAndNullUriResolveFalseAndReleaseTheSlot() {
        val worker = QueuedExecutor()
        val plugin = TestPlugin(context, worker, direct)
        for ((code, chosen) in listOf(Activity.RESULT_CANCELED to uri, Activity.RESULT_OK to null, Activity.RESULT_CANCELED to null)) {
            val call = call()
            plugin.save(call); worker.runAll()
            plugin.deliver(code, chosen)
            assertEquals(false, call.saved)
            assertNull(call.error)
        }
        val empty = call()
        plugin.save(empty); worker.runAll(); plugin.deliverEmptyIntent()
        assertEquals(false, empty.saved)
    }

    @Test fun onlyOneSaveCanParseChooseOrWriteAtATime() {
        val worker = QueuedExecutor()
        val plugin = TestPlugin(context, worker, direct)
        val first = call()
        plugin.save(first)
        fun busy() {
            val concurrent = call()
            plugin.save(concurrent)
            assertEquals("FILES_BUSY", concurrent.code)
        }
        busy()
        worker.runAll(); busy()
        shadowOf(context.contentResolver).registerOutputStream(uri, ByteArrayOutputStream())
        plugin.deliver(Activity.RESULT_OK, uri); busy()
        worker.runAll()
        val next = call()
        plugin.save(next); worker.runAll(); plugin.deliver(Activity.RESULT_CANCELED)
        assertEquals(false, next.saved)
    }

    @Test fun badArgumentsIoAndLaunchErrorsArePropagatedAndDoNotLeaveBusySet() {
        val worker = QueuedExecutor()
        val plugin = TestPlugin(context, worker, direct)
        val invalid = call(mime = "text/html")
        plugin.save(invalid); worker.runAll()
        assertEquals("FILES_BAD_ARGS", invalid.code)
        assertNull(plugin.launched)
        plugin.launchError = IOException("Picker unavailable")
        val launch = call()
        plugin.save(launch); worker.runAll()
        assertEquals("FILES_IO", launch.code)
        assertEquals("Picker unavailable", launch.message)
        plugin.launchError = null
        val broken = object : OutputStream() { override fun write(value: Int) { throw IOException("Disk full") } }
        shadowOf(context.contentResolver).registerOutputStream(uri, broken)
        val io = call()
        plugin.save(io); worker.runAll(); plugin.deliver(Activity.RESULT_OK, uri); worker.runAll()
        assertEquals("FILES_IO", io.code)
        assertEquals("Disk full", io.message)
        assertTrue(io.error is IOException)
        val retry = call()
        plugin.save(retry); worker.runAll(); plugin.deliver(Activity.RESULT_CANCELED)
        assertEquals(false, retry.saved)
        plugin.launchError = IOException()
        val noMessage = call()
        plugin.save(noMessage); worker.runAll()
        assertEquals("FILES_IO", noMessage.code)
        assertEquals("java.io.IOException", noMessage.message)
    }

    @Test fun executorRejectionWhileSubmittingOrWritingIsReported() {
        val worker = QueuedExecutor()
        val plugin = TestPlugin(context, worker, direct)
        val writing = call()
        plugin.save(writing); worker.runAll(); plugin.destroy()
        plugin.deliver(Activity.RESULT_OK, uri)
        assertEquals("FILES_IO", writing.code)
        val submitting = call()
        plugin.save(submitting)
        assertEquals("FILES_IO", submitting.code)
    }

    @Test fun nativeDownloadsUseTheSameSlotAndSafCompletion() {
        val worker = QueuedExecutor()
        val plugin = TestPlugin(context, worker, direct)
        var result: Result<Boolean>? = null
        plugin.saveBytes("a\\b.txt", "text/plain", byteArrayOf(42)) { result = it }
        worker.runAll()
        var busy: Result<Boolean>? = null
        plugin.saveBytes("next", "text/plain", byteArrayOf()) { busy = it }
        assertEquals("FILES_BUSY", (busy?.exceptionOrNull() as FilesException).code)
        val output = ByteArrayOutputStream()
        shadowOf(context.contentResolver).registerOutputStream(uri, output)
        plugin.deliver(Activity.RESULT_OK, uri); worker.runAll()
        assertEquals(true, result?.getOrThrow())
        assertArrayEquals(byteArrayOf(42), output.toByteArray())
        plugin.saveBytes("next", "text/plain", byteArrayOf()) { result = it }
        worker.runAll(); plugin.deliver(Activity.RESULT_CANCELED)
        assertEquals(false, result?.getOrThrow())
        plugin.saveBytes("bad", "text/html", byteArrayOf()) { result = it }
        worker.runAll()
        assertEquals("FILES_BAD_ARGS", (result?.exceptionOrNull() as FilesException).code)
    }

    @Test fun defaultExecutorsWriteOffMainAndCompleteOnMain() {
        var launched = false
        val plugin = object : OpenAuriFilesPlugin() {
            override fun getContext(): Context = this@OpenAuriFilesPluginTest.context
            override fun startActivityForResult(call: PluginCall, intent: Intent, callbackName: String) { launched = true }
            fun deliver() = fileCreated(null, ActivityResult(Activity.RESULT_OK, Intent().setData(uri)))
            fun destroy() = handleOnDestroy()
        }
        var writeThread: Thread? = null
        val output = object : ByteArrayOutputStream() {
            override fun write(bytes: ByteArray, offset: Int, length: Int) {
                writeThread = Thread.currentThread()
                super.write(bytes, offset, length)
            }
        }
        shadowOf(context.contentResolver).registerOutputStream(uri, output)
        var completed = false
        try {
            plugin.saveBytes("file", "text/plain", byteArrayOf(17)) {
                assertEquals(Looper.getMainLooper(), Looper.myLooper())
                assertEquals(true, it.getOrThrow())
                completed = true
            }
            await { launched }
            plugin.deliver()
            await { completed }
            assertNotNull(writeThread)
            assertNotEquals(Looper.getMainLooper().thread, writeThread)
            assertArrayEquals(byteArrayOf(17), output.toByteArray())
        } finally {
            plugin.destroy()
        }
    }

    private fun await(condition: () -> Boolean) {
        repeat(200) {
            shadowOf(Looper.getMainLooper()).idle()
            if (condition()) return
            Thread.sleep(10)
        }
        fail("Timed out waiting for file saver")
    }
}
