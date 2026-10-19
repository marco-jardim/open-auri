package com.openauri.files

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.widget.Toast
import com.openauri.app.R
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLDecoder
import java.util.Locale
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal typealias SaveDownload = (String, String, ByteArray, (Result<Boolean>) -> Unit) -> Unit

/**
 * Attach with bridge.webView.setDownloadListener(DownloadBridge(context, origin, files)).
 * DownloadListener supplies neither the original method nor its body: only replayable GET
 * attachments work here. Non-2xx replays abort without saving or retrying and notify the user.
 * T2.2 moves POST exports to fetch + OpenAuriFiles.save on the web side.
 */
class DownloadBridge internal constructor(
    pinnedOrigin: String,
    private val save: SaveDownload,
    private val fetch: (URL, String?) -> FileSaveRequest,
    private val cookies: (String) -> String?,
    private val browse: (String) -> Unit,
    private val onError: (Throwable) -> Unit,
    private val network: ExecutorService,
    private val main: Executor,
) : DownloadListener, AutoCloseable {
    constructor(
        context: Context,
        pinnedOrigin: String,
        files: OpenAuriFilesPlugin,
        onError: (Throwable) -> Unit = { reportDownloadFailure(context, it) },
    ) : this(
        pinnedOrigin, files::saveBytes, HttpFileFetcher()::fetch,
        { CookieManager.getInstance().getCookie(it) },
        { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it)).addCategory(Intent.CATEGORY_BROWSABLE)) },
        onError, Executors.newSingleThreadExecutor(), Executor { Handler(Looper.getMainLooper()).post(it) },
    )

    private val pinned = URI(pinnedOrigin)

    init {
        require(pinned.scheme.equals("https", true) && pinned.host != null && pinned.rawUserInfo == null) {
            "Pinned server origin must be HTTPS without credentials"
        }
    }

    override fun onDownloadStart(url: String?, userAgent: String?, contentDisposition: String?, mimetype: String?, contentLength: Long) {
        try {
            val target = URI(requireNotNull(url) { "Missing download URL" })
            require(target.host != null && target.rawUserInfo == null) { "Invalid download URL" }
            if (!sameOrigin(pinned, target)) {
                main.execute {
                    try {
                        browse(url)
                    } catch (error: Exception) {
                        onError(error)
                    }
                }
                return
            }
            network.execute {
                try {
                    // Neither the WebView's headers nor cookies from any other URL are forwarded.
                    val file = fetch(target.toURL(), cookies(url))
                    main.execute {
                        try {
                            save(file.name, file.mime, file.bytes) { result -> result.exceptionOrNull()?.let(onError) }
                        } catch (error: Exception) {
                            onError(error)
                        }
                    }
                } catch (error: Exception) {
                    report(error)
                }
            }
        } catch (error: Exception) {
            report(error)
        }
    }

    private fun report(error: Exception) = main.execute { onError(error) }

    override fun close() {
        network.shutdown()
    }

    private fun sameOrigin(left: URI, right: URI): Boolean =
        left.scheme.equals(right.scheme, true) && left.host.equals(right.host, true) && port(left) == port(right)

    private fun port(uri: URI): Int = if (uri.port == -1) 443 else uri.port
}

/** DownloadBridge delivers every error on its main executor, including native save failures. */
internal fun reportDownloadFailure(context: Context, error: Throwable) {
    Log.e("OpenAuriFiles", "Download failed", error)
    Toast.makeText(context, R.string.files_download_failed, Toast.LENGTH_LONG).show()
}

/** No automatic redirects: even a same-origin redirect must be reviewed by the caller. */
internal class HttpFileFetcher(private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }) {
    fun fetch(url: URL, cookie: String?): FileSaveRequest {
        require(url.protocol.equals("https", true) && url.userInfo == null) { "Downloads require HTTPS without credentials" }
        val connection = open(url)
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "GET"
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.useCaches = false
            if (!cookie.isNullOrEmpty()) connection.setRequestProperty("Cookie", cookie)
            val status = connection.responseCode
            if (status !in 200..299) throw IOException("Download failed: HTTP $status")
            if (connection.contentLengthLong > MAX_FILE_BYTES) throw FilesException("FILES_TOO_LARGE", "File exceeds 50 MB")
            val bytes = connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count == -1) break
                    if (output.size().toLong() + count > MAX_FILE_BYTES) throw FilesException("FILES_TOO_LARGE", "File exceeds 50 MB")
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            return FileSaveRequest.fromBytes(
                DownloadNames.from(connection.getHeaderField("Content-Disposition"), url),
                FileMimeTypes.forDownload(connection.contentType), bytes,
            )
        } finally {
            connection.disconnect()
        }
    }
}

internal object DownloadNames {
    private val parameter = Regex("(?:^|;)\\s*(filename\\*|filename)\\s*=\\s*(?:\"((?:\\\\.|[^\"\\\\])*)\"|([^;]*))", RegexOption.IGNORE_CASE)
    private val escape = Regex("\\\\(.)")
    private val badPercent = Regex("%(?![0-9a-fA-F]{2})")

    fun from(disposition: String?, url: URL): String {
        var plain: String? = null
        var extended: String? = null
        for (match in parameter.findAll(disposition.orEmpty())) {
            val value = match.groups[2]?.value?.replace(escape) { it.groupValues[1] } ?: match.groupValues[3].trim()
            if (match.groupValues[1].endsWith('*')) extended = decodeExtended(value) else plain = value.takeIf { it.isNotBlank() }
        }
        return FileNames.sanitize(extended ?: plain ?: Uri.decode(url.path.substringAfterLast('/')))
    }

    private fun decodeExtended(value: String): String? {
        val parts = value.split('\'', limit = 3)
        if (parts.size != 3 || badPercent.containsMatchIn(parts[2])) return null
        val charset = when (parts[0].lowercase(Locale.ROOT)) {
            "utf-8" -> Charsets.UTF_8
            "iso-8859-1" -> Charsets.ISO_8859_1
            else -> return null
        }
        return URLDecoder.decode(parts[2].replace("+", "%2B"), charset.name()).takeIf { it.isNotBlank() }
    }
}
