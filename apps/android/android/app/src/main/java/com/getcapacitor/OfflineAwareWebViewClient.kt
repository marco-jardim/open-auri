package com.getcapacitor

import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView

/**
 * HTTP error pages belong to the site; only network failures use Capacitor's local errorPath.
 * This package gives access to Bridge's package-private listener getter, preserving callbacks.
 */
class OfflineAwareWebViewClient(private val activeBridge: Bridge) : BridgeWebViewClient(activeBridge) {
    internal enum class ErrorKind { NETWORK, HTTP }

    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
        // Do not call super: Capacitor redirects every main-frame HTTP error to errorPath.
        receivedError(view, request.isForMainFrame, ErrorKind.HTTP)
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        receivedError(view, request.isForMainFrame, ErrorKind.NETWORK)
    }

    /** Shared callback seam: keeps listener notifications and main-frame-only network fallback. */
    internal fun receivedError(view: WebView, isMainFrame: Boolean, kind: ErrorKind) {
        activeBridge.webViewListeners?.forEach { listener ->
            when (kind) {
                ErrorKind.NETWORK -> listener.onReceivedError(view)
                ErrorKind.HTTP -> listener.onReceivedHttpError(view)
            }
        }
        if (shouldShowOfflinePage(isMainFrame, kind)) {
            activeBridge.errorUrl?.let(view::loadUrl)
        }
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (request.isForMainFrame && request.url.toString() == RETRY_URL) {
            activeBridge.serverUrl?.let(view::loadUrl)
            return true
        }
        return super.shouldOverrideUrlLoading(view, request)
    }

    companion object {
        private const val RETRY_URL = "https://localhost/__openauri_retry"

        internal fun shouldShowOfflinePage(isMainFrame: Boolean, kind: ErrorKind): Boolean =
            isMainFrame && kind == ErrorKind.NETWORK
    }
}
