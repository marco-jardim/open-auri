package com.openauri.files

import android.app.Activity
import android.os.Looper
import android.webkit.CookieManager
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLStreamHandler
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class DownloadBridgeTest {
    private val url = URL("https://open-auri.com/account/export.json")
    private val direct = Executor { it.run() }

    private class Connection(url: URL) : HttpURLConnection(url) {
        var status = 200
        var length = -1L
        var mime: String? = "application/json; charset=utf-8"
        var disposition: String? = "attachment; filename=export.json"
        var stream: InputStream = ByteArrayInputStream(byteArrayOf(0, 1, -1))
        var disconnected = false
        var inputOpened = false
        override fun connect() = Unit
        override fun disconnect() { disconnected = true }
        override fun usingProxy() = false
        override fun getResponseCode() = status
        override fun getContentLengthLong() = length
        override fun getContentType() = mime
        override fun getHeaderField(name: String): String? = when (name) {
            "Content-Disposition" -> disposition
            "Location" -> "https://evil.example/stolen"
            else -> null
        }
        override fun getInputStream(): InputStream { inputOpened = true; return stream }
    }

    private class Harness {
        val network = QueuedExecutor()
        val cookieUrls = mutableListOf<String>()
        val fetched = mutableListOf<Pair<URL, String?>>()
        val browsed = mutableListOf<String>()
        val saved = mutableListOf<FileSaveRequest>()
        val errors = mutableListOf<Throwable>()
        var fetchError: Exception? = null
        var saveError: Exception? = null
        var completion: Result<Boolean> = Result.success(true)
        var browseError: Exception? = null
        val bridge = DownloadBridge(
            "https://open-auri.com",
            { name, mime, bytes, done ->
                saveError?.let { throw it }
                saved.add(FileSaveRequest.fromBytes(name, mime, bytes)); done(completion)
            },
            { target, cookie ->
                fetched.add(target to cookie)
                fetchError?.let { throw it }
                FileSaveRequest.fromBytes("export.json", "application/json", byteArrayOf(7, 8))
            },
            { cookieUrls.add(it); "session=pinned" },
            { browseError?.let { error -> throw error }; browsed.add(it) },
            { errors.add(it) }, network, Executor { it.run() },
        )
        fun start(url: String? = "https://open-auri.com/account/export?token=a") =
            bridge.onDownloadStart(url, "untrusted UA", "attachment; filename=untrusted.exe", "text/html", Long.MAX_VALUE)
    }

    @Test fun sameOriginFetchUsesOnlyExactUrlCookiesAndSavesResponseNotListenerMetadata() {
        val h = Harness()
        h.start()
        assertTrue(h.fetched.isEmpty())
        assertTrue(h.cookieUrls.isEmpty())
        h.network.runAll()
        assertEquals(listOf("https://open-auri.com/account/export?token=a"), h.cookieUrls)
        assertEquals("session=pinned", h.fetched.single().second)
        assertEquals("export.json", h.saved.single().name)
        assertEquals("application/json", h.saved.single().mime)
        assertArrayEquals(byteArrayOf(7, 8), h.saved.single().bytes)
        assertTrue(h.browsed.isEmpty())
        assertTrue(h.errors.isEmpty())
        h.start("https://OPEN-AURI.com:443/next")
        h.network.runAll()
        assertEquals(2, h.saved.size)
        h.bridge.close()
        assertTrue(h.network.isShutdown)
    }

    @Test fun everyForeignSchemeHostOrPortUsesBrowserWithoutLookingUpCookies() {
        val h = Harness()
        val foreign = listOf(
            "https://evil.example/export", "https://open-auri.com.evil.example/export", "https://open-auri.com:444/export",
            "http://open-auri.com/export", "http://open-auri.com:443/export",
        )
        foreign.forEach { h.start(it) }
        h.network.runAll()
        assertEquals(foreign, h.browsed)
        assertTrue(h.cookieUrls.isEmpty())
        assertTrue(h.fetched.isEmpty())
        assertTrue(h.saved.isEmpty())
    }

    @Test fun malformedAndCredentialedUrlsNeverReachTheNetwork() {
        val h = Harness()
        listOf(null, "not a URL", "/relative", "https://user:password@open-auri.com/file").forEach { h.start(it) }
        h.network.runAll()
        assertEquals(4, h.errors.size)
        assertTrue(h.cookieUrls.isEmpty())
        assertTrue(h.browsed.isEmpty())
        for (origin in listOf("http://open-auri.com", "https:///missing", "https://user@open-auri.com")) {
            assertThrows(IllegalArgumentException::class.java) {
                DownloadBridge(origin, { _, _, _, _ -> }, { _, _ -> error("No fetch") }, { null }, {}, {}, QueuedExecutor(), direct)
            }
        }
    }

    @Test fun failuresAreObservableIncludingNativeSaveCompletionAndExecutorRejection() {
        val h = Harness()
        h.fetchError = IOException("Offline")
        h.start(); h.network.runAll()
        assertEquals("Offline", h.errors.last().message)
        h.fetchError = null
        h.saveError = IOException("Picker unavailable")
        h.start(); h.network.runAll()
        assertEquals("Picker unavailable", h.errors.last().message)
        h.saveError = null
        h.completion = Result.failure(IOException("Disk full"))
        h.start(); h.network.runAll()
        assertEquals("Disk full", h.errors.last().message)
        h.completion = Result.success(false)
        h.start(); h.network.runAll()
        assertEquals(3, h.errors.size)
        h.browseError = IOException("No browser")
        h.start("https://foreign.example/file")
        assertEquals("No browser", h.errors.last().message)
        h.bridge.close(); h.start()
        assertTrue(h.errors.last() is java.util.concurrent.RejectedExecutionException)
    }

    @Test fun httpFetcherSendsOnlyCookieAndConfiguresBoundedNonRedirectingGet() {
        val connection = Connection(url)
        var closed = false
        connection.stream = object : ByteArrayInputStream(byteArrayOf(0, 1, -1)) {
            override fun close() { closed = true; super.close() }
        }
        val file = HttpFileFetcher { connection }.fetch(url, "session=secret")
        assertEquals(mapOf("Cookie" to listOf("session=secret")), connection.requestProperties)
        assertEquals("GET", connection.requestMethod)
        assertEquals(15_000, connection.connectTimeout)
        assertEquals(30_000, connection.readTimeout)
        assertFalse(connection.instanceFollowRedirects)
        assertFalse(connection.useCaches)
        assertTrue(connection.disconnected)
        assertTrue(closed)
        assertEquals("export.json", file.name)
        assertEquals("application/json", file.mime)
        assertArrayEquals(byteArrayOf(0, 1, -1), file.bytes)
        for (cookie in listOf(null, "")) {
            val noCookie = Connection(url)
            HttpFileFetcher { noCookie }.fetch(url, cookie)
            assertTrue(noCookie.requestProperties.isEmpty())
        }
    }

    @Test fun redirectsAndAllNonSuccessStatusesFailWithoutReadingOrFollowingLocation() {
        for (status in listOf(199, 300, 302, 307, 399, 400, 500)) {
            val connection = Connection(url).also { it.status = status }
            var opens = 0
            val error = assertThrows(IOException::class.java) {
                HttpFileFetcher { opens++; connection }.fetch(url, "session=secret")
            }
            assertEquals("Download failed: HTTP $status", error.message)
            assertEquals(1, opens)
            assertFalse(connection.instanceFollowRedirects)
            assertFalse(connection.inputOpened)
            assertTrue(connection.disconnected)
        }
        for (target in listOf(URL("http://open-auri.com/file"), URL("https://user@open-auri.com/file"))) {
            assertThrows(IllegalArgumentException::class.java) {
                HttpFileFetcher { error("Must not open non-HTTPS or credentialed URL") }.fetch(target, "secret")
            }
        }
    }

    @Test fun defaultConnectionFactoryUsesTheProvidedHttpsUrl() {
        val connection = Connection(url)
        val target = URL(null, url.toString(), object : URLStreamHandler() {
            override fun openConnection(url: URL): HttpURLConnection = connection
        })
        assertArrayEquals(byteArrayOf(0, 1, -1), HttpFileFetcher().fetch(target, null).bytes)
        assertTrue(connection.disconnected)
    }

    @Test fun declaredAndStreamingOversizeAreRefusedAndStreamsAreClosed() {
        val declared = Connection(url).also { it.length = MAX_FILE_BYTES + 1L }
        assertEquals("FILES_TOO_LARGE", assertThrows(FilesException::class.java) {
            HttpFileFetcher { declared }.fetch(url, null)
        }.code)
        assertFalse(declared.inputOpened)
        assertTrue(declared.disconnected)
        val stream = SizedStream(MAX_FILE_BYTES + 1)
        val unknown = Connection(url).also { it.stream = stream }
        assertEquals("FILES_TOO_LARGE", assertThrows(FilesException::class.java) {
            HttpFileFetcher { unknown }.fetch(url, null)
        }.code)
        assertTrue(stream.closed)
        assertTrue(unknown.disconnected)
    }

    @Test fun responseAtTheLimitIsAcceptedAndReadErrorsPropagate() {
        val limit = Connection(url).also { it.length = MAX_FILE_BYTES.toLong(); it.stream = SizedStream(MAX_FILE_BYTES) }
        assertEquals(MAX_FILE_BYTES, HttpFileFetcher { limit }.fetch(url, null).bytes.size)
        val broken = Connection(url).also {
            it.stream = object : InputStream() { override fun read(): Int = throw IOException("Connection reset") }
        }
        assertEquals("Connection reset", assertThrows(IOException::class.java) { HttpFileFetcher { broken }.fetch(url, null) }.message)
        assertTrue(broken.disconnected)
    }

    private class SizedStream(private var remaining: Int) : InputStream() {
        var closed = false
        override fun read(): Int = if (remaining-- > 0) 0 else -1
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (remaining == 0) return -1
            val count = minOf(remaining, length)
            buffer.fill(0, offset, offset + count)
            remaining -= count
            return count
        }
        override fun close() { closed = true }
    }

    @Test fun contentDispositionSupportsQuotedEscapesAndRfc5987WithSafeFallbacks() {
        val cases = mapOf(
            "attachment; filename=plain.json" to "plain.json",
            "attachment; FILENAME = \"a; b.json\"" to "a; b.json",
            "attachment; filename=\"a\\\"b.json\"" to "a\"b.json",
            "attachment; filename=\"../../etc/passwd\"" to "etcpasswd",
            "attachment; filename=fallback; filename*=UTF-8''caf%C3%A9+mix.json" to "café+mix.json",
            "attachment; filename*=UTF-8'en'%E9%9F%B3.json; filename=fallback" to "音.json",
            "attachment; filename*=ISO-8859-1''caf%E9.json" to "café.json",
            "attachment; filename*=unknown''name; filename=fallback" to "fallback",
            "attachment; filename*=UTF-8''bad%ZZ; filename=fallback" to "fallback",
            "attachment; filename*=invalid; filename=fallback" to "fallback",
            "attachment; filename*=UTF-8''; filename=fallback" to "fallback",
            "attachment; filename=\" \"" to "export.json",
            "attachment; filename=..." to "download",
        )
        cases.forEach { (header, expected) -> assertEquals(header, expected, DownloadNames.from(header, url)) }
        assertEquals("export.json", DownloadNames.from(null, url))
        assertEquals("export.json", DownloadNames.from("attachment", url))
        assertEquals("café+mix.json", DownloadNames.from(null, URL("https://open-auri.com/caf%C3%A9+mix.json")))
        assertEquals("download", DownloadNames.from(null, URL("https://open-auri.com/")))
    }

    @Test fun responseMimeIsMappedIntoTheExactAllowList() {
        for (mime in FileMimeTypes.allowed) assertEquals(mime, FileMimeTypes.forDownload(" ${mime.uppercase()}; charset=UTF-8"))
        for (mime in listOf(null, "", "text/html", "audio/wav")) assertEquals(FileMimeTypes.BINARY, FileMimeTypes.forDownload(mime))
        val connection = Connection(url).also { it.mime = "text/html"; it.disposition = null }
        val file = HttpFileFetcher { connection }.fetch(url, null)
        assertEquals(FileMimeTypes.BINARY, file.mime)
        assertEquals("export.json", file.name)
    }

    @Test fun realCookieManagerSuppliesOnlyPinnedUrlAndNetworkRunsOffMain() {
        val manager = CookieManager.getInstance()
        manager.setCookie("https://open-auri.com/account/", "session=pinned; Path=/account; Secure")
        manager.setCookie("https://foreign.example/", "foreign=never; Secure")
        val worker = Executors.newSingleThreadExecutor()
        val cookies = mutableListOf<String?>()
        val errors = mutableListOf<Throwable>()
        val bridge = DownloadBridge(
            "https://open-auri.com", { _, _, _, done -> done(Result.success(true)) },
            { _, cookie ->
                assertNotEquals(Looper.getMainLooper().thread, Thread.currentThread())
                cookies.add(cookie)
                FileSaveRequest.fromBytes("file", "text/plain", byteArrayOf())
            }, { manager.getCookie(it) }, {}, { errors.add(it) }, worker, direct,
        )
        try {
            bridge.onDownloadStart("https://open-auri.com/account/file", null, null, null, -1)
            worker.submit {}.get(5, TimeUnit.SECONDS)
            assertEquals(listOf("session=pinned"), cookies)
            assertTrue(errors.isEmpty())
        } finally {
            bridge.close()
        }
    }

    @Test fun publicConstructorOpensForeignUrlsInTheSystemBrowserOnMain() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = controller.get()
        val plugin = OpenAuriFilesPlugin()
        val bridge = DownloadBridge(activity, "https://open-auri.com", plugin)
        try {
            bridge.onDownloadStart("https://foreign.example/export", null, null, null, -1)
            shadowOf(Looper.getMainLooper()).idle()
            val intent = shadowOf(activity).nextStartedActivity
            assertEquals(android.content.Intent.ACTION_VIEW, intent.action)
            assertEquals("https://foreign.example/export", intent.dataString)
            assertTrue(intent.hasCategory(android.content.Intent.CATEGORY_BROWSABLE))
            bridge.onDownloadStart(null, null, null, null, -1)
            shadowOf(Looper.getMainLooper()).idle() // Default reporting logs malformed URLs instead of swallowing them.
        } finally {
            bridge.close()
            controller.pause().stop().destroy()
        }
    }
}
