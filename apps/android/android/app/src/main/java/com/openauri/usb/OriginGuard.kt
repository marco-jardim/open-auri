package com.openauri.usb

import android.webkit.WebView
import com.getcapacitor.WebViewListener
import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

/**
 * Second, independent origin check of the USB bridge (plan RS1, invariant 0.12.4).
 *
 * Capacitor only hands bridge messages from its allowed origins to the plugins (the
 * `addWebMessageListener` rules, which include `server.url`). This guard checks again, in the
 * plugin and before any work: the origin of the WebView's main-frame URL must equal the origin of
 * the pinned server URL (`bridge.getServerUrl()`). A missing URL, an unparsable one, one with
 * credentials or a scheme other than http and https all count as a mismatch: the guard fails
 * closed.
 *
 * Origins are compared normalized: scheme and host in lower case, the port made explicit (443 for
 * https, 80 for http). Only `scheme://authority` is parsed, so an unusual path or query of a
 * legitimate page cannot make the check fail.
 *
 * The guard covers the main frame. Frames of other origins are kept out by Capacitor's own origin
 * rules, which decide which frames may post bridge messages at all.
 *
 * @param pinnedUrl the pinned server URL, read on every check.
 * @param currentUrl the WebView's current main-frame URL, read on every check; it must be safe to
 *   call from any thread (see [MainFrameUrlTracker]).
 */
class OriginGuard(private val pinnedUrl: () -> String?, private val currentUrl: () -> String?) {

    /** Whether the current page is on the pinned origin. */
    fun isAllowed(): Boolean {
        val pinned = originOf(pinnedUrl()) ?: return false
        return pinned == originOf(currentUrl())
    }

    /** @throws UsbBridgeException with [ErrorCodes.USB_ORIGIN] when [isAllowed] is false. */
    fun check() {
        if (!isAllowed()) {
            throw UsbBridgeException(ErrorCodes.USB_ORIGIN, "the page is not on the pinned origin")
        }
    }

    companion object {
        private const val HTTPS = "https"
        private const val HTTP = "http"
        private const val HTTPS_PORT = 443
        private const val HTTP_PORT = 80
        private const val SCHEME_SEPARATOR = "://"
        private val AUTHORITY_END = charArrayOf('/', '?', '#')

        /**
         * Normalized origin of [url], `scheme://host` plus `:port` when the port is not the
         * scheme's default; null when [url] is null, unparsable, not http(s), without a host or
         * with user info.
         */
        fun originOf(url: String?): String? {
            if (url == null) return null
            val separator = url.indexOf(SCHEME_SEPARATOR)
            if (separator <= 0) return null
            val scheme = url.substring(0, separator).lowercase(Locale.ROOT)
            val defaultPort = when (scheme) {
                HTTPS -> HTTPS_PORT
                HTTP -> HTTP_PORT
                else -> return null
            }
            val authorityStart = separator + SCHEME_SEPARATOR.length
            val authorityEnd = url.indexOfAny(AUTHORITY_END, authorityStart).let { if (it < 0) url.length else it }
            val authority = parseAuthority("$scheme$SCHEME_SEPARATOR${url.substring(authorityStart, authorityEnd)}")
                ?: return null
            val host = authority.host
            if (host == null || authority.rawUserInfo != null) return null
            val port = if (authority.port == -1) defaultPort else authority.port
            val origin = "$scheme$SCHEME_SEPARATOR${host.lowercase(Locale.ROOT)}"
            return if (port == defaultPort) origin else "$origin:$port"
        }

        private fun parseAuthority(value: String): URI? = try {
            URI(value)
        } catch (malformed: URISyntaxException) {
            // A URL Java cannot parse has no origin we can vouch for: the caller fails closed.
            null
        }
    }
}

/**
 * Tracks the WebView's main-frame URL for [OriginGuard] without touching the WebView off the main
 * thread (`WebView.getUrl()` is main-thread only).
 *
 * Capacitor's `BridgeWebViewClient` calls this listener on the main thread. `onPageStarted` fires
 * when a main-frame navigation commits, before the new document runs any script, and right after
 * Capacitor dropped every JS listener (`Bridge.reset()`); the URL read there is published through
 * a volatile field that the plugin thread reads.
 *
 * Race window: between a cross-origin commit and the main-thread dispatch of `onPageStarted` the
 * field still holds the previous origin. Bridge messages of the new document are posted to the
 * same main looper after that commit, so they are judged with the new URL; a message the previous
 * document queued before navigating may be judged with the new one. The field starts null, so
 * every call fails until the first page reports its URL (fail closed).
 *
 * @param onDocumentStarted runs on the main thread after each main-frame navigation, once [url]
 *   holds the new URL.
 */
class MainFrameUrlTracker(private val onDocumentStarted: () -> Unit) : WebViewListener() {

    /** The last main-frame URL reported by the WebView; null until the first page starts. */
    @Volatile var url: String? = null
        private set

    /** Records [newUrl]; main thread only. */
    fun update(newUrl: String?) {
        url = newUrl
    }

    override fun onPageStarted(webView: WebView) {
        update(webView.url)
        onDocumentStarted()
    }

    override fun onPageCommitVisible(view: WebView, url: String?) {
        update(url)
    }

    override fun onPageLoaded(webView: WebView) {
        update(webView.url)
    }
}
