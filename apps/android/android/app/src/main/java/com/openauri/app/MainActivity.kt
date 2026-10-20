package com.openauri.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.os.Looper
import android.util.Log
import android.view.View
import android.webkit.WebView
import android.widget.Button
import android.widget.Toast
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.BridgeActivity
import com.getcapacitor.OfflineAwareWebViewClient
import com.getcapacitor.Plugin
import com.getcapacitor.annotation.CapacitorPlugin
import com.openauri.files.DownloadBridge
import com.openauri.files.OpenAuriFilesPlugin
import com.openauri.usb.OpenAuriUsbPlugin
import com.openauri.usb.OriginGuard

/**
 * Evaluate the gate before BridgeActivity.onCreate, but always call the superclass lifecycle.
 * On failure, intercept its WebView layout and skip load(): no WebView or Bridge is created,
 * no remote URL is loaded, and Capacitor's CSP-incompatible inline-script fallback cannot run.
 * BridgeActivity's remaining lifecycle callbacks already handle a null bridge.
 */
class MainActivity : BridgeActivity() {
    private var gateResult: WebViewCompatGate.Result = WebViewCompatGate.Result.UnknownPackage
    private var activePackageName = WebViewCompatGate.DEFAULT_WEBVIEW_PACKAGE
    private var downloads: DownloadBridge? = null

    /** Set once a passing gate created the bridge and onCreate wired it; deep links load only then. */
    private var deepLinksReady = false

    override fun onCreate(savedInstanceState: Bundle?) {
        val injectedGate = gateForTesting
        gateResult = if (injectedGate != null) {
            injectedGate()
        } else {
            val activePackage = WebViewCompat.getCurrentWebViewPackage(this)
            activePackageName = activePackage?.packageName?.takeIf { it.isNotBlank() }
                ?: WebViewCompatGate.DEFAULT_WEBVIEW_PACKAGE
            WebViewCompatGate(
                featureCheck = WebViewFeature::isFeatureSupported,
                currentWebViewPackage = { activePackage },
            ).check()
        }
        val result = gateResult
        if (result is WebViewCompatGate.Result.Outdated) activePackageName = result.packageName
        if (result == WebViewCompatGate.Result.Ok) {
            // Plugins only exist behind a passing gate: without it no Bridge is ever created.
            registerPlugin(OpenAuriUsbPlugin::class.java)
            registerPlugin(OpenAuriFilesPlugin::class.java)
        }

        super.onCreate(savedInstanceState)
        if (gateResult == WebViewCompatGate.Result.Ok) {
            bridge?.let { it.setWebViewClient(OfflineAwareWebViewClient(it)) }
            attachDownloads()
            if (bridge != null) {
                deepLinksReady = true
                // Supersedes the start URL that Bridge.loadWebView() is already loading.
                openDeepLink(intent)
            }
        } else {
            val screen = findViewById<View>(R.id.webview_update_screen)
            ViewCompat.setAccessibilityHeading(findViewById(R.id.webview_update_title), true)
            ViewCompat.setOnApplyWindowInsetsListener(screen) { view, insets ->
                val bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
                )
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
            ViewCompat.requestApplyInsets(screen)
            findViewById<Button>(R.id.webview_update_button).setOnClickListener { openWebViewStore() }
        }
    }

    override fun setContentView(layoutResID: Int) {
        super.setContentView(
            if (gateResult == WebViewCompatGate.Result.Ok) layoutResID else R.layout.activity_webview_update,
        )
    }

    override fun load() {
        if (gateResult != WebViewCompatGate.Result.Ok) return
        // Plugin instances load synchronously after the core plugins, before Bridge.loadWebView().
        // Waiting until super.load() returns would be too late: it already calls WebView.loadUrl().
        bridgeBuilder.addPluginInstance(BridgeHardening())
        super.load()
    }

    /**
     * Warm start (singleTask): an App Link for the running activity arrives here, on the main
     * thread. BridgeActivity.load() also calls this with the launch intent while onCreate is still
     * running; [deepLinksReady] is false then, and onCreate opens that intent itself once the
     * bridge is fully wired, so the page is loaded once. With a failing gate nothing is loaded.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (deepLinksReady) openDeepLink(intent)
    }

    override fun onDestroy() {
        downloads?.close()
        downloads = null
        super.onDestroy()
    }

    /** Loads the page [intent] links to when [DeepLinks.targetFor] accepts it; otherwise keeps the page. */
    private fun openDeepLink(intent: Intent) {
        val activeBridge = bridge ?: return
        val target = DeepLinks.targetFor(intent.action, intent.dataString, activeBridge.serverUrl) ?: return
        activeBridge.webView.loadUrl(target)
    }

    /**
     * Routes WebView downloads through the files plugin, pinned to the origin of the bridge's
     * server URL. Without a usable HTTPS origin (or plugin) the WebView keeps its default handling.
     */
    private fun attachDownloads() {
        val activeBridge = bridge ?: return
        val files = activeBridge.getPlugin(FILES_PLUGIN)?.instance as? OpenAuriFilesPlugin
        val origin = OriginGuard.originOf(activeBridge.serverUrl)
        if (files == null || origin == null) {
            Log.w(TAG, "Downloads not attached: missing files plugin or server origin")
            return
        }
        val downloadBridge = try {
            DownloadBridge(this, origin, files)
        } catch (notHttps: IllegalArgumentException) {
            Log.w(TAG, "Downloads not attached: the server origin is not HTTPS", notHttps)
            return
        }
        downloads = downloadBridge
        activeBridge.webView.setDownloadListener(downloadBridge)
    }

    private fun openWebViewStore() {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, "market://details?id=$activePackageName".toUri()))
        } catch (error: ActivityNotFoundException) {
            Log.i(TAG, "Google Play app unavailable; trying the HTTPS store page", error)
            try {
                startActivity(Intent(
                    Intent.ACTION_VIEW,
                    "https://play.google.com/store/apps/details?id=$activePackageName".toUri(),
                ))
            } catch (fallbackError: ActivityNotFoundException) {
                Log.w(TAG, "No handler for the WebView update page", fallbackError)
                Toast.makeText(this, R.string.webview_update_store_unavailable, Toast.LENGTH_LONG).show()
            }
        }
    }

    companion object {
        private const val TAG = "MainActivity"
        private const val FILES_PLUGIN = "OpenAuriFiles"

        /** Test-only injection, set before ActivityScenario launch and cleared after each test. */
        @Volatile
        internal var gateForTesting: (() -> WebViewCompatGate.Result)? = null
    }
}

/**
 * Maps a launch or new intent to the page the WebView should open, e.g. a verified App Link to
 * `https://open-auri.com/c/<id>`. Capacitor keeps the intent data but always loads its start URL.
 *
 * MainActivity is exported, so any app can send it a VIEW intent with arbitrary data, not only
 * verified links. Only an https URL without user info whose origin equals the origin of the
 * bridge's server URL is accepted (compared with [OriginGuard.originOf]); anything else yields null
 * and the WebView keeps its page (fail closed). A server URL over http (debug or e2e builds)
 * therefore never deep-links.
 *
 * The target is rebuilt as the normalized server origin plus the link's path, query and fragment,
 * so the WebView navigates to exactly the authority that was compared, not to raw authority text
 * another URL parser could read differently.
 */
internal object DeepLinks {
    private const val HTTPS_PREFIX = "https://"
    private const val SCHEME_SEPARATOR = "://"
    private val AUTHORITY_END = charArrayOf('/', '?', '#')

    /** The URL to load for an intent with [action] and [data] (`Intent.getDataString()`), or null. */
    internal fun targetFor(action: String?, data: String?, serverUrl: String?): String? {
        if (action != Intent.ACTION_VIEW || data == null) return null
        val origin = OriginGuard.originOf(data) ?: return null
        if (!origin.startsWith(HTTPS_PREFIX) || origin != OriginGuard.originOf(serverUrl)) return null
        // originOf accepted data, so it contains the scheme separator; same authority split as there.
        val authorityStart = data.indexOf(SCHEME_SEPARATOR) + SCHEME_SEPARATOR.length
        val authorityEnd = data.indexOfAny(AUTHORITY_END, authorityStart)
        return if (authorityEnd < 0) origin else origin + data.substring(authorityEnd)
    }
}

/**
 * Native-only initialization hook. It adds no methods of its own; the standard Plugin methods it
 * inherits (addListener, checkPermissions...) are reachable only through the origin-pinned bridge.
 */
@CapacitorPlugin(name = "OpenAuriBridgeHardening")
internal class BridgeHardening : Plugin() {
    override fun load() {
        harden(bridge.webView)
    }

    companion object {
        /**
         * Core Plugin.load() adds the all-frame interfaces before this hook runs. Removal is
         * synchronous on the UI thread and precedes the first loadUrl, so it takes effect on
         * the very first document, without a reload or an exposed initial navigation.
         * The site uses browser cookies/fetch, not these native cookie/HTTP interfaces.
         */
        internal fun harden(webView: WebView) {
            check(Looper.myLooper() == Looper.getMainLooper()) { "Bridge hardening requires the UI thread" }
            webView.removeJavascriptInterface("CapacitorCookies")
            webView.removeJavascriptInterface("CapacitorHttp")
            // Actual names in the pinned Capacitor version; also remove the plugin-name aliases above.
            webView.removeJavascriptInterface("CapacitorCookiesAndroidInterface")
            webView.removeJavascriptInterface("CapacitorHttpAndroidInterface")
        }
    }
}
