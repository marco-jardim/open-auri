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
import androidx.activity.OnBackPressedCallback
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
import java.util.Locale

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
    private var offlineClient: OfflineAwareWebViewClient? = null

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
            bridge?.let { activeBridge ->
                offlineClient = OfflineAwareWebViewClient(activeBridge).also(activeBridge::setWebViewClient)
            }
            attachDownloads()
            if (bridge != null) {
                onBackPressedDispatcher.addCallback(this, webViewBack)
                deepLinksReady = true
                // Supersedes the start URL that Bridge.loadWebView() is already loading (that
                // first request may still go out; accepted). Only a fresh launch opens its link:
                // a recreated activity (saved state, also after process death) or a relaunch from
                // Recents gets an old intent again, and replaying it (e.g. a /#p= preset) would
                // overwrite what the user did since.
                if (isFreshLaunch(savedInstanceState, intent)) openDeepLink(intent)
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

    /**
     * Without Capacitor's App plugin, Back finished the activity even with a sheet or menu open.
     * Back is offered to the page first as a cancelable `oa:native-back` event: the site cancels
     * it while an overlay is open (closing the topmost one, or keeping a guarded one such as the
     * first-run notice). An uncanceled event (no overlay, the offline page, a script error) walks
     * the WebView history, and with no history left the system default runs (leave the app).
     */
    private val webViewBack = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            val activeBridge = bridge ?: return leaveApp()
            val webView = activeBridge.webView
            val serverOrigin = OriginGuard.originOf(activeBridge.serverUrl)
            // The bundled offline page (and anything off the site) has no handler: leave, never
            // walk back into the failed load that would show the offline page again.
            if (serverOrigin == null || OriginGuard.originOf(webView.url) != serverOrigin) return leaveApp()
            webView.evaluateJavascript(NATIVE_BACK_SCRIPT) { consumed ->
                if (isDestroyed || consumed == "true") return@evaluateJavascript
                val (urls, current) = historyForTesting?.invoke(webView) ?: webView.copyBackForwardList().let { list ->
                    (0 until list.size).map { list.getItemAtIndex(it)?.url } to list.currentIndex
                }
                val steps = BackNavigation.stepsBack(urls, current, serverOrigin)
                when (steps) {
                    0 -> leaveApp()
                    1 -> webView.goBack()
                    else -> webView.goBackOrForward(-steps)
                }
            }
        }

        private fun leaveApp() {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
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
     *
     * The running page may be writing to a cable: navigating away would interrupt the write, so
     * the page is asked first ([WRITE_IN_PROGRESS_SCRIPT]); during a write the link is dropped
     * with a short notice, otherwise (including a page that cannot answer) it is loaded.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (!deepLinksReady) return
        val webView = bridge?.webView ?: return
        val target = deepLinkTarget(intent) ?: return
        webView.evaluateJavascript(WRITE_IN_PROGRESS_SCRIPT) { writing ->
            // The answer may arrive after the activity (and its WebView) went away.
            if (isDestroyed || isFinishing) return@evaluateJavascript
            if (writing == "true") {
                Toast.makeText(this, R.string.deep_link_write_in_progress, Toast.LENGTH_SHORT).show()
            } else {
                webView.loadUrl(target)
            }
        }
    }

    override fun onDestroy() {
        // Before super: the pending offline check must not outlive (or probe) the WebView.
        offlineClient?.dispose()
        offlineClient = null
        downloads?.close()
        downloads = null
        super.onDestroy()
    }

    private fun deepLinkTarget(intent: Intent): String? =
        DeepLinks.targetFor(intent.action, intent.dataString, bridge?.serverUrl)

    /** Cold start: loads the page [intent] links to when [DeepLinks.targetFor] accepts it. */
    private fun openDeepLink(intent: Intent) {
        val target = deepLinkTarget(intent) ?: return
        bridge?.webView?.loadUrl(target)
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

        /** Must match NATIVE_BACK_EVENT in web/src/lib/components/chrome (the site's Back handler). */
        internal const val NATIVE_BACK_SCRIPT =
            "!window.dispatchEvent(new CustomEvent('oa:native-back', { cancelable: true }))"

        /** True while the site writes to a cable (public contract, web/src/lib/cable/write-flag.ts). */
        internal const val WRITE_IN_PROGRESS_SCRIPT = "window.__oaWriteInProgress === true"

        /**
         * Whether onCreate runs for a new launch. A recreation (saved state, including the restore
         * after process death) or a relaunch from Recents redelivers an old intent instead.
         */
        internal fun isFreshLaunch(savedInstanceState: Bundle?, intent: Intent): Boolean =
            savedInstanceState == null && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0

        /** Test-only: Robolectric's WebView keeps no back/forward list. Cleared after each test. */
        @Volatile
        internal var historyForTesting: ((WebView) -> Pair<List<String?>, Int>)? = null

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
 *
 * Only pages are linkable: paths under `/api` (incl. auth endpoints) and `/dados` (data dumps the
 * download bridge would fetch into a save dialog) and any `.json` resource are refused. The check
 * runs on the path as the WebView and the server will see it ([normalizedSegments]), so dot
 * segments, backslashes, escapes, case or doubled slashes cannot sneak such a path through.
 */
internal object DeepLinks {
    private const val HTTPS_PREFIX = "https://"
    private const val SCHEME_SEPARATOR = "://"
    private val AUTHORITY_END = charArrayOf('/', '?', '#')
    private val BLOCKED_FIRST_SEGMENTS = setOf("api", "dados")
    private const val BLOCKED_SUFFIX = ".json"
    private val PERCENT_ESCAPE = Regex("%[0-9A-Fa-f]{2}")
    private val TAB_OR_NEWLINE = Regex("[\t\n\r]")
    private const val HEX = 16

    /** The URL to load for an intent with [action] and [data] (`Intent.getDataString()`), or null. */
    internal fun targetFor(action: String?, data: String?, serverUrl: String?): String? {
        if (action != Intent.ACTION_VIEW || data == null) return null
        val origin = OriginGuard.originOf(data) ?: return null
        if (!origin.startsWith(HTTPS_PREFIX) || origin != OriginGuard.originOf(serverUrl)) return null
        // originOf accepted data, so it contains the scheme separator; same authority split as there.
        val authorityStart = data.indexOf(SCHEME_SEPARATOR) + SCHEME_SEPARATOR.length
        val authorityEnd = data.indexOfAny(AUTHORITY_END, authorityStart)
        val rest = if (authorityEnd < 0) "" else data.substring(authorityEnd)
        return if (isLinkablePath(rest.takeWhile { it != '?' && it != '#' })) origin + rest else null
    }

    private fun isLinkablePath(path: String): Boolean {
        val segments = normalizedSegments(path)
        if (segments.isEmpty()) return true
        return segments.first() !in BLOCKED_FIRST_SEGMENTS && !segments.last().endsWith(BLOCKED_SUFFIX)
    }

    /**
     * Path segments, lower-cased, the way Chromium resolves them: tabs and newlines dropped,
     * backslashes as slashes, `%XX` decoded once (so `%2e` is a dot), `.` and `..` resolved.
     * Empty segments are dropped too, so `//api` counts as `/api` (stricter than Chromium).
     */
    internal fun normalizedSegments(path: String): List<String> {
        val decoded = PERCENT_ESCAPE.replace(TAB_OR_NEWLINE.replace(path, "")) { escape ->
            Char(escape.value.substring(1).toInt(HEX)).toString()
        }
        val segments = ArrayDeque<String>()
        for (segment in decoded.replace('\\', '/').lowercase(Locale.ROOT).split('/')) {
            when (segment) {
                "", "." -> Unit
                ".." -> segments.removeLastOrNull()
                else -> segments.addLast(segment)
            }
        }
        return segments
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

/** Back history that skips entries off the site, such as the bundled offline page. */
internal object BackNavigation {
    /**
     * Steps back from [current] in the WebView history [urls] to the nearest entry on
     * [serverOrigin]; 0 when there is none (leave the app).
     */
    internal fun stepsBack(urls: List<String?>, current: Int, serverOrigin: String): Int {
        for (index in (current - 1) downTo 0) {
            if (OriginGuard.originOf(urls.getOrNull(index)) == serverOrigin) return current - index
        }
        return 0
    }
}