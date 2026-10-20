package com.getcapacitor

import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.openauri.usb.OriginGuard

/**
 * HTTP error pages belong to the site; only network failures use Capacitor's local errorPath.
 * This package gives access to Bridge's package-private listener getter, preserving callbacks.
 *
 * A main-frame network error is not proof that nothing will load: when the site's service worker
 * answers an offline navigation from its precache, the WebView first reports the failed network
 * fetch (net::ERR_NAME_NOT_RESOLVED and similar) and finishes an interim about:blank, then commits
 * the cached document. The bundled offline page is therefore shown only when the page settles on
 * something other than the site's document (a [siteProbe]), e.g. on a first launch before the
 * service worker exists, or when nothing commits within [SETTLE_TIMEOUT_MS]. A page still blank
 * at that timeout gets one more [SETTLE_TIMEOUT_MS] (a slow service worker boot may still commit).
 *
 * The offline page's retry reloads the main-frame URL whose network failure led there (e.g. a
 * deep link) when it is on the server's origin, otherwise the server URL.
 */
class OfflineAwareWebViewClient(private val activeBridge: Bridge) : BridgeWebViewClient(activeBridge) {
    internal enum class ErrorKind { NETWORK, HTTP }

    /** What the main frame shows, as reported by [siteProbe]. */
    internal enum class PageState { SITE, BLANK, OTHER }

    /** Reports what the WebView currently shows; overridable in tests. */
    internal var siteProbe: (WebView, (PageState) -> Unit) -> Unit = { view, result ->
        view.evaluateJavascript(SITE_DOCUMENT_PROBE) { value -> result(pageStateOf(value)) }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var pendingCheck: Runnable? = null

    /** The last main-frame URL that failed with a network error; the retry candidate. */
    private var lastFailedUrl: String? = null

    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
        // Do not call super: Capacitor redirects every main-frame HTTP error to errorPath.
        receivedError(view, request.isForMainFrame, ErrorKind.HTTP)
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        receivedError(view, request.isForMainFrame, ErrorKind.NETWORK, request.url?.toString())
    }

    override fun onPageFinished(view: WebView, url: String?) {
        super.onPageFinished(view, url)
        val check = pendingCheck ?: return
        siteProbe(view) { state ->
            // An interim blank page keeps waiting for the cached document or the timeout.
            if (state != PageState.BLANK && pendingCheck === check) settle(view, state)
        }
    }

    /**
     * Shared callback seam: keeps listener notifications and main-frame-only network fallback.
     * [failedUrl] is the request URL of the failure, remembered for the retry.
     */
    internal fun receivedError(view: WebView, isMainFrame: Boolean, kind: ErrorKind, failedUrl: String? = null) {
        activeBridge.webViewListeners?.forEach { listener ->
            when (kind) {
                ErrorKind.NETWORK -> listener.onReceivedError(view)
                ErrorKind.HTTP -> listener.onReceivedHttpError(view)
            }
        }
        if (shouldShowOfflinePage(isMainFrame, kind)) {
            lastFailedUrl = failedUrl
            scheduleCheck(view, extended = false)
        }
    }

    /**
     * Cancels a pending offline decision so the delayed check neither keeps the WebView (and its
     * activity) alive nor probes a destroyed WebView. Call before the activity is destroyed.
     */
    fun dispose() {
        pendingCheck?.let(handler::removeCallbacks)
        pendingCheck = null
    }

    private fun scheduleCheck(view: WebView, extended: Boolean) {
        pendingCheck?.let(handler::removeCallbacks)
        lateinit var check: Runnable
        check = Runnable {
            siteProbe(view) { state ->
                // Still the interim blank page: a slow service worker boot may yet commit the
                // cached document, so wait once more before judging (BLANK or OTHER then: offline).
                if (pendingCheck === check) {
                    if (state == PageState.BLANK && !extended) scheduleCheck(view, extended = true) else settle(view, state)
                }
            }
        }
        pendingCheck = check
        handler.postDelayed(check, SETTLE_TIMEOUT_MS)
    }

    private fun settle(view: WebView, state: PageState) {
        pendingCheck?.let(handler::removeCallbacks)
        pendingCheck = null
        if (state != PageState.SITE) activeBridge.errorUrl?.let(view::loadUrl)
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (request.isForMainFrame && request.url.toString() == RETRY_URL) {
            retryUrl(lastFailedUrl, activeBridge.serverUrl)?.let(view::loadUrl)
            return true
        }
        return super.shouldOverrideUrlLoading(view, request)
    }

    companion object {
        private const val RETRY_URL = "https://localhost/__openauri_retry"
        internal const val SETTLE_TIMEOUT_MS = 4000L

        /**
         * "site" when the site's app shell (which links its web manifest) is shown, "blank" for
         * the interim about:blank, "other" for anything else (e.g. Chromium's network error page).
         */
        internal const val SITE_DOCUMENT_PROBE =
            "(document.querySelector('link[rel=\"manifest\"][href$=\"manifest.webmanifest\"]') ? 'site' : " +
                "(location.href === 'about:blank' ? 'blank' : 'other'))"

        /** evaluateJavascript returns the JSON encoding of the value: a quoted string here. */
        internal fun pageStateOf(value: String?): PageState = when (value) {
            "\"site\"" -> PageState.SITE
            "\"blank\"" -> PageState.BLANK
            else -> PageState.OTHER
        }

        internal fun shouldShowOfflinePage(isMainFrame: Boolean, kind: ErrorKind): Boolean =
            isMainFrame && kind == ErrorKind.NETWORK

        /** [failedUrl] when it is on [serverUrl]'s origin (OriginGuard rules), else [serverUrl]. */
        internal fun retryUrl(failedUrl: String?, serverUrl: String?): String? {
            val serverOrigin = OriginGuard.originOf(serverUrl) ?: return serverUrl
            return if (OriginGuard.originOf(failedUrl) == serverOrigin) failedUrl else serverUrl
        }
    }
}
