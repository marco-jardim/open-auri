package com.openauri.app

import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebViewClient
import com.getcapacitor.CapConfig
import com.getcapacitor.JSObject
import com.getcapacitor.OfflineAwareWebViewClient
import com.getcapacitor.PluginCall
import com.getcapacitor.WebViewListener
import com.openauri.files.OpenAuriFilesPlugin
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowWebView

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class OfflineAwareWebViewClientTest {
    class TestActivity : BridgeActivity() {
        override fun onCreate(state: Bundle?) {
            config = CapConfig.Builder(this)
                .setServerUrl("https://staging.open-auri.com")
                .setErrorPath("offline.html")
                .setResolveServiceWorkerRequests(false)
                .create()
            registerPlugin(OpenAuriFilesPlugin::class.java)
            super.onCreate(state)
        }
    }

    private lateinit var controller: ActivityController<TestActivity>
    private lateinit var client: OfflineAwareWebViewClient
    private lateinit var view: WebView
    private var httpErrors = 0
    private var networkErrors = 0

    @Before fun setUp() {
        ShadowWebView.setCurrentWebViewPackage(PackageInfo().apply {
            packageName = "com.google.android.webview"
            versionName = "150.0.0.0"
        })
        controller = Robolectric.buildActivity(TestActivity::class.java)
        controller.setup()
        val bridge = controller.get().bridge
        view = bridge.webView
        client = OfflineAwareWebViewClient(bridge)
        bridge.setWebViewClient(client)
        bridge.addWebViewListener(object : WebViewListener() {
            override fun onReceivedHttpError(view: WebView) { httpErrors++ }
            override fun onReceivedError(view: WebView) { networkErrors++ }
        })
    }

    @After fun tearDown() { controller.pause().stop().destroy() }

    private fun request(url: String, main: Boolean = true) = object : WebResourceRequest {
        override fun getUrl() = Uri.parse(url)
        override fun isForMainFrame() = main
        override fun isRedirect() = false
        override fun hasGesture() = true
        override fun getMethod() = "GET"
        override fun getRequestHeaders() = emptyMap<String, String>()
    }

    @Test fun httpErrorsKeepTheSites404410And500PagesAndNotifyListeners() {
        for (main in listOf(true, false)) for (status in listOf(404, 410, 500)) {
            val url = "https://staging.open-auri.com/c/missing-$status"
            view.loadUrl(url)
            client.onReceivedHttpError(view, request(url, main), WebResourceResponse(
                "text/html", "UTF-8", status, "Not available", emptyMap(), null,
            ))
            assertEquals(url, shadowOf(view).lastLoadedUrl)
        }
        assertEquals(6, httpErrors)
    }

    @Test fun upstreamHttpErrorRedirectReproducesTheOriginalFalseOfflinePage() {
        val url = "https://staging.open-auri.com/c/missing"
        view.loadUrl(url)
        BridgeWebViewClient(controller.get().bridge).onReceivedHttpError(view, request(url),
            WebResourceResponse("text/html", "UTF-8", 404, "Not found", emptyMap(), null))
        assertEquals("https://localhost/offline.html", shadowOf(view).lastLoadedUrl)
    }

    private val OFFLINE = "https://localhost/offline.html"
    private val STATE = OfflineAwareWebViewClient.PageState.entries

    private fun idlePastSettle() = shadowOf(Looper.getMainLooper()).idleFor(
        java.time.Duration.ofMillis(OfflineAwareWebViewClient.SETTLE_TIMEOUT_MS + 1),
    )

    @Test fun onlyMainFrameNetworkErrorsLoadTheBundledOfflinePage() {
        val url = "https://staging.open-auri.com/c/example"
        var probes = 0
        client.siteProbe = { _, result -> probes++; result(OfflineAwareWebViewClient.PageState.OTHER) }
        view.loadUrl(url)
        client.receivedError(view, false, OfflineAwareWebViewClient.ErrorKind.NETWORK)
        client.onPageFinished(view, url)
        assertEquals(url, shadowOf(view).lastLoadedUrl)
        assertEquals(0, probes)
        client.receivedError(view, true, OfflineAwareWebViewClient.ErrorKind.NETWORK)
        // The decision waits for the page to settle: a service worker may still answer it.
        assertEquals(url, shadowOf(view).lastLoadedUrl)
        client.onPageFinished(view, url)
        assertEquals(OFFLINE, shadowOf(view).lastLoadedUrl)
        assertEquals(1, probes)
        assertEquals(2, networkErrors)
        idlePastSettle()
        assertEquals(1, probes)
    }

    @Test fun anInterimBlankPageWaitsAndTheCachedSiteDocumentIsKept() {
        val url = "https://staging.open-auri.com/biblioteca"
        val states = ArrayDeque(listOf(STATE[1], STATE[0]))
        client.siteProbe = { _, result -> result(states.removeFirst()) }
        view.loadUrl(url)
        client.receivedError(view, true, OfflineAwareWebViewClient.ErrorKind.NETWORK)
        client.onPageFinished(view, "about:blank")
        assertEquals(url, shadowOf(view).lastLoadedUrl)
        client.onPageFinished(view, url)
        idlePastSettle()
        assertEquals(url, shadowOf(view).lastLoadedUrl)
        assertTrue(states.isEmpty())
    }

    @Test fun aBlankPageThatNeverCommitsIsJudgedAfterTheSettleTimeout() {
        val url = "https://staging.open-auri.com/"
        var probes = 0
        client.siteProbe = { _, result -> probes++; result(OfflineAwareWebViewClient.PageState.BLANK) }
        view.loadUrl(url)
        client.receivedError(view, true, OfflineAwareWebViewClient.ErrorKind.NETWORK)
        client.receivedError(view, true, OfflineAwareWebViewClient.ErrorKind.NETWORK)
        client.onPageFinished(view, "about:blank")
        assertEquals(url, shadowOf(view).lastLoadedUrl)
        idlePastSettle()
        assertEquals(OFFLINE, shadowOf(view).lastLoadedUrl)
        assertEquals(2, probes)
        // Nothing is pending afterwards: a later finish probes nothing.
        client.onPageFinished(view, OFFLINE)
        assertEquals(2, probes)
    }

    @Test fun theSiteShownAtTheTimeoutKeepsIt() {
        val url = "https://staging.open-auri.com/docs"
        client.siteProbe = { _, result -> result(OfflineAwareWebViewClient.PageState.SITE) }
        view.loadUrl(url)
        client.receivedError(view, true, OfflineAwareWebViewClient.ErrorKind.NETWORK)
        idlePastSettle()
        assertEquals(url, shadowOf(view).lastLoadedUrl)
    }

    @Test fun theProductionProbeMapsTheEvaluatedValue() {
        assertTrue(OfflineAwareWebViewClient.SITE_DOCUMENT_PROBE.contains("manifest.webmanifest"))
        assertEquals(STATE[0], OfflineAwareWebViewClient.pageStateOf("\"site\""))
        assertEquals(STATE[1], OfflineAwareWebViewClient.pageStateOf("\"blank\""))
        for (value in listOf("\"other\"", "null", null, "site", "")) {
            assertEquals(OfflineAwareWebViewClient.PageState.OTHER, OfflineAwareWebViewClient.pageStateOf(value))
        }
        var evaluated: String? = null
        val probingView = object : WebView(controller.get()) {
            override fun evaluateJavascript(script: String, resultCallback: android.webkit.ValueCallback<String>?) {
                evaluated = script
                resultCallback?.onReceiveValue("\"blank\"")
            }
        }
        var shown: OfflineAwareWebViewClient.PageState? = null
        OfflineAwareWebViewClient(controller.get().bridge).siteProbe(probingView) { shown = it }
        assertEquals(OfflineAwareWebViewClient.SITE_DOCUMENT_PROBE, evaluated)
        assertEquals(OfflineAwareWebViewClient.PageState.BLANK, shown)
    }
    @Test fun offlineDecisionIsLimitedToMainFrameNetworkErrors() {
        for (main in listOf(true, false)) for (kind in OfflineAwareWebViewClient.ErrorKind.entries) {
            assertEquals(main && kind == OfflineAwareWebViewClient.ErrorKind.NETWORK,
                OfflineAwareWebViewClient.shouldShowOfflinePage(main, kind))
        }
    }

    @Test fun productionFilesPluginUsesMainFrameTrackerAndRejectsTheLocalOfflineOrigin() {
        val files = controller.get().bridge.getPlugin("OpenAuriFiles").instance as OpenAuriFilesPlugin
        shadowOf(Looper.getMainLooper()).idle() // Install the production tracker after Bridge.Builder.
        for ((url, expected) in listOf(
            "https://staging.open-auri.com/conta" to "FILES_BAD_ARGS",
            "https://localhost/offline.html" to "FILES_ORIGIN",
            "https://staging.open-auri.com/conta" to "FILES_BAD_ARGS",
        )) {
            view.loadUrl(url)
            client.onPageStarted(view, url, null)
            var code: String? = null
            val call = object : PluginCall(null, "OpenAuriFiles", "origin-test", "save", JSObject()) {
                override fun reject(message: String, errorCode: String, error: Exception) { code = errorCode }
            }
            files.save(call)
            for (attempt in 0 until 200) {
                shadowOf(Looper.getMainLooper()).idle()
                if (code != null) break
                Thread.sleep(10)
            }
            assertEquals(url, expected, code)
            assertNull(shadowOf(controller.get()).nextStartedActivity)
        }
    }

    @Test fun exactMainFrameRetrySentinelLoadsTheConfiguredServerInsideTheWebView() {
        view.loadUrl("https://localhost/offline.html")
        assertTrue(client.shouldOverrideUrlLoading(view, request("https://localhost/__openauri_retry")))
        assertEquals("https://staging.open-auri.com", shadowOf(view).lastLoadedUrl)
        assertNull(shadowOf(controller.get()).nextStartedActivity)
    }

    @Test fun lookalikesAndSubframesKeepCapacitorNavigationPolicy() {
        val urls = listOf(
            "https://localhost/__openauri_retry/", "https://localhost/__openauri_retry?x=1",
            "https://localhost/__openauri_retry#fragment", "https://localhost:443/__openauri_retry",
            "http://localhost/__openauri_retry", "https://other.example/__openauri_retry",
            "https://staging.open-auri.com/__openauri_retry",
        )
        val base = BridgeWebViewClient(controller.get().bridge)
        for (url in urls) {
            view.loadUrl("https://localhost/offline.html")
            assertEquals(url, base.shouldOverrideUrlLoading(view, request(url)), client.shouldOverrideUrlLoading(view, request(url)))
            assertEquals("https://localhost/offline.html", shadowOf(view).lastLoadedUrl)
        }
        assertEquals(
            base.shouldOverrideUrlLoading(view, request("https://localhost/__openauri_retry", false)),
            client.shouldOverrideUrlLoading(view, request("https://localhost/__openauri_retry", false)),
        )
        assertEquals("https://localhost/offline.html", shadowOf(view).lastLoadedUrl)
    }
}
