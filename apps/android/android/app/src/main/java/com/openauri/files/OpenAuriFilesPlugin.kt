package com.openauri.files

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.openauri.usb.MainFrameUrlTracker
import com.openauri.usb.OriginGuard
import java.io.IOException
import java.util.Base64
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal const val MAX_FILE_BYTES = 52_428_800
internal const val FILES_ORIGIN = "FILES_ORIGIN"

internal class FilesException(val code: String, message: String, cause: Throwable? = null) :
    Exception(message, cause)

internal object FileNames {
    private val unsafe = Regex("[/\\\\\\p{Cc}\\p{Cf}]")
    private val dots = Regex("\\.{2,}")
    private val whitespace = Regex("(?U)\\s+")

    fun sanitize(name: String): String {
        val clean = name.replace(unsafe, "").replace(dots, "").replace(whitespace, " ")
            .trim().trimStart { it == '.' || it.isWhitespace() }.ifEmpty { "download" }
        if (length(clean) <= 128) return clean
        val dot = clean.lastIndexOf('.')
        val extension = if (dot > 0) clean.substring(dot) else ""
        // An extension longer than the entire filename budget cannot be retained intact.
        val suffix = if (length(extension) in 1..127) extension else ""
        return clean.substring(0, clean.offsetByCodePoints(0, 128 - length(suffix))) + suffix
    }

    private fun length(value: String) = value.codePointCount(0, value.length)
}

internal object FileMimeTypes {
    const val BINARY = "application/octet-stream"
    val allowed = setOf("application/json", "text/plain", BINARY, "image/png", "image/svg+xml", "application/gzip")

    fun forDownload(value: String?): String = value?.substringBefore(';')?.trim()
        ?.lowercase(java.util.Locale.ROOT)?.takeIf { it in allowed } ?: BINARY
}

internal class FileSaveRequest(val name: String, val mime: String, val bytes: ByteArray) {
    companion object {
        fun parse(name: String?, mime: String?, base64: String?): FileSaveRequest {
            if (name == null || mime !in FileMimeTypes.allowed || base64 == null) {
                throw FilesException("FILES_BAD_ARGS", "Expected name, an allowed mime and base64 strings")
            }
            // Bound the input before the decoder can allocate. Unpadded standard base64 is accepted.
            val maxEncoded = ((MAX_FILE_BYTES.toLong() + 2) / 3) * 4
            if (base64.length > maxEncoded) tooLarge()
            val padding = when {
                base64.endsWith("==") -> 2
                base64.endsWith("=") -> 1
                else -> 0
            }
            if (base64.length.toLong() * 3 / 4 - padding > MAX_FILE_BYTES) tooLarge()
            val bytes = try {
                Base64.getDecoder().decode(base64)
            } catch (error: IllegalArgumentException) {
                throw FilesException("FILES_BAD_ARGS", "Invalid base64: ${error.message}", error)
            }
            return fromBytes(name, requireNotNull(mime), bytes)
        }

        fun fromBytes(name: String, mime: String, bytes: ByteArray): FileSaveRequest {
            if (mime !in FileMimeTypes.allowed) throw FilesException("FILES_BAD_ARGS", "Unsupported mime: $mime")
            if (bytes.size > MAX_FILE_BYTES) tooLarge()
            return FileSaveRequest(FileNames.sanitize(name), mime, bytes)
        }

        private fun tooLarge(): Nothing = throw FilesException("FILES_TOO_LARGE", "File exceeds 50 MB")
    }
}

/** All callers, including native downloads, share one user-confirmed SAF operation. */
@CapacitorPlugin(name = "OpenAuriFiles")
open class OpenAuriFilesPlugin internal constructor(
    private val worker: ExecutorService = Executors.newSingleThreadExecutor(),
    private val main: Executor = Executor { Handler(Looper.getMainLooper()).post(it) },
    private var origin: OriginGuard? = null,
) : Plugin() {
    private class Pending(val call: PluginCall, val request: FileSaveRequest)
    private val busy = AtomicBoolean(false)
    private val pending = AtomicReference<Pending?>()

    override fun load() {
        if (origin != null) return
        val activeBridge = bridge ?: return
        val tracker = MainFrameUrlTracker { }
        origin = OriginGuard({ activeBridge.serverUrl }, { tracker.url })
        // Bridge.Builder replaces the listener list after loading plugins. Catch up on the next turn.
        activeBridge.executeOnMainThread {
            activeBridge.addWebViewListener(tracker)
            tracker.update(activeBridge.webView.url)
        }
    }

    /** Reject off-origin JavaScript with FILES_ORIGIN before parsing or reserving the SAF slot. */
    @PluginMethod
    fun save(call: PluginCall) {
        if (origin?.isAllowed() != true) {
            main.execute {
                val error = FilesException(FILES_ORIGIN, "The page is not on the pinned origin")
                call.reject(requireNotNull(error.message), error.code, error)
            }
            return
        }
        submit(call) {
            FileSaveRequest.parse(call.getString("name"), call.getString("mime"), call.getString("base64"))
        }
    }

    /** Native entry point. Completion is delivered on the main thread, including cancellation. */
    fun saveBytes(name: String, mime: String, bytes: ByteArray, completion: (Result<Boolean>) -> Unit) {
        val call = object : PluginCall(null, "OpenAuriFiles", UUID.randomUUID().toString(), "save", JSObject()) {
            override fun resolve(data: JSObject) {
                bridge?.releaseCall(this)
                completion(Result.success(data.getBoolean("saved")))
            }

            override fun reject(message: String, code: String, error: Exception) {
                bridge?.releaseCall(this)
                completion(Result.failure(FilesException(code, message, error)))
            }
        }
        submit(call) { FileSaveRequest.fromBytes(name, mime, bytes) }
    }

    private fun submit(call: PluginCall, parse: () -> FileSaveRequest) {
        if (!busy.compareAndSet(false, true)) {
            main.execute { call.reject("Another save is in progress", "FILES_BUSY", FilesException("FILES_BUSY", "Another save is in progress")) }
            return
        }
        try {
            worker.execute {
                try {
                    val request = parse()
                    main.execute {
                        try {
                            pending.set(Pending(call, request))
                            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                                .setType(request.mime).putExtra(Intent.EXTRA_TITLE, request.name)
                            startActivityForResult(call, intent, "fileCreated")
                        } catch (error: Exception) {
                            pending.set(null)
                            fail(call, error)
                        }
                    }
                } catch (error: Exception) {
                    fail(call, error)
                }
            }
        } catch (error: Exception) {
            fail(call, error)
        }
    }

    @ActivityCallback
    protected fun fileCreated(call: PluginCall?, result: ActivityResult) {
        val active = pending.getAndSet(null) ?: return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            finish(active.call, false)
            return
        }
        try {
            worker.execute {
                try {
                    context.contentResolver.openOutputStream(uri, "w").use { stream ->
                        if (stream == null) throw IOException("No output stream for $uri")
                        stream.write(active.request.bytes)
                    }
                    finish(active.call, true)
                } catch (error: Exception) {
                    fail(active.call, error)
                }
            }
        } catch (error: Exception) {
            fail(active.call, error)
        }
    }

    private fun finish(call: PluginCall, saved: Boolean) = main.execute {
        busy.set(false)
        call.resolve(JSObject().put("saved", saved))
    }

    private fun fail(call: PluginCall, error: Exception) = main.execute {
        busy.set(false)
        val code = if (error is FilesException) error.code else "FILES_IO"
        call.reject(error.message ?: error.toString(), code, error)
    }

    // Never put a potentially 50 MB base64 payload in an Activity state Bundle.
    override fun saveInstanceState(): Bundle? = null

    override fun handleOnDestroy() {
        worker.shutdown()
    }
}
