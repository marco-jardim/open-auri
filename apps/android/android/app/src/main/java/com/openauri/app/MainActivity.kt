package com.openauri.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.Toast
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.BridgeActivity

/**
 * Evaluate the gate before BridgeActivity.onCreate, but always call the superclass lifecycle.
 * On failure, intercept its WebView layout and skip load(): no WebView or Bridge is created,
 * no remote URL is loaded, and Capacitor's CSP-incompatible inline-script fallback cannot run.
 * BridgeActivity's remaining lifecycle callbacks already handle a null bridge.
 */
class MainActivity : BridgeActivity() {
    private var gateResult: WebViewCompatGate.Result = WebViewCompatGate.Result.UnknownPackage
    private var activePackageName = WebViewCompatGate.DEFAULT_WEBVIEW_PACKAGE

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

        super.onCreate(savedInstanceState)
        if (gateResult != WebViewCompatGate.Result.Ok) {
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
        if (gateResult == WebViewCompatGate.Result.Ok) super.load()
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

        /** Test-only injection, set before ActivityScenario launch and cleared after each test. */
        @Volatile
        internal var gateForTesting: (() -> WebViewCompatGate.Result)? = null
    }
}
