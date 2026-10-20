package com.openauri.app

import android.app.Application
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import androidx.core.net.toUri
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.webkit.WebViewFeature
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class WebViewCompatGateTest {
    @After
    fun clearGateOverride() {
        MainActivity.gateForTesting = null
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).checkActivities(false)
    }

    @Test
    fun sufficientWebViewRequiresBothOriginSafeBridgeFeaturesAndBaselineVersion() {
        for (version in listOf("111.0.5563.0", "150.1.2.3")) {
            val checked = mutableListOf<String>()
            val gate = WebViewCompatGate(
                featureCheck = { feature ->
                    checked.add(feature)
                    true
                },
                currentWebViewPackage = { webViewPackage(version) },
            )
            assertEquals(WebViewCompatGate.Result.Ok, gate.check())
            assertEquals(listOf(WebViewFeature.DOCUMENT_START_SCRIPT, WebViewFeature.WEB_MESSAGE_LISTENER), checked)
        }
    }

    @Test
    fun lowVersionReportsActiveProviderAndVersion() {
        assertEquals(
            WebViewCompatGate.Result.Outdated("com.android.chrome", "110.0.1.2"),
            check(webViewPackage("110.0.1.2")),
        )
    }

    @Test
    fun minimumVersionIsInjectable() {
        assertEquals(
            WebViewCompatGate.Result.Outdated("com.android.chrome", "111.0"),
            WebViewCompatGate({ true }, { webViewPackage("111.0") }, minVersion = 112).check(),
        )
    }

    @Test
    fun missingDocumentStartFeatureFailsEvenWithNewVersion() {
        assertEquals(WebViewCompatGate.Result.MissingFeature, check(webViewPackage("150.0"), false))
    }

    @Test
    fun missingWebMessageListenerMustNotFallBackToAnAllFrameJavascriptInterface() {
        val gate = WebViewCompatGate(
            { it != WebViewFeature.WEB_MESSAGE_LISTENER },
            { webViewPackage("150.0") },
        )
        assertEquals(WebViewCompatGate.Result.MissingFeature, gate.check())
    }

    @Test
    fun absentOrUnknownPackageFailsClosed() {
        assertEquals(WebViewCompatGate.Result.UnknownPackage, check(null))
        assertEquals(WebViewCompatGate.Result.UnknownPackage, check(PackageInfo()))
        val unnamed = webViewPackage("111.0").apply { packageName = "" }
        assertEquals(WebViewCompatGate.Result.UnknownPackage, check(unnamed))
    }

    @Test
    fun absentOrMalformedVersionFailsClosed() {
        for (version in listOf(null, "", "invalid", ".111", "111beta.0", " 111.0", "-111.0", "999999999999.0")) {
            assertEquals("version=$version", WebViewCompatGate.Result.UnknownPackage, check(webViewPackage(version)))
        }
    }

    @Test
    fun everyFailureShowsAccessibleNativeScreenWithoutCreatingWebViewOrBridge() {
        val failures = listOf(
            WebViewCompatGate.Result.Outdated("com.android.chrome", "110.0"),
            WebViewCompatGate.Result.MissingFeature,
            WebViewCompatGate.Result.UnknownPackage,
        )
        for (failure in failures) {
            MainActivity.gateForTesting = { failure }
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    assertNull(activity.bridge)
                    assertNotNull(activity.findViewById<View>(R.id.webview_update_screen))
                    assertFalse(containsWebView(activity.findViewById(android.R.id.content)))
                    val title = activity.findViewById<TextView>(R.id.webview_update_title)
                    val body = activity.findViewById<TextView>(R.id.webview_update_body)
                    val button = activity.findViewById<Button>(R.id.webview_update_button)
                    assertEquals(activity.getString(R.string.webview_update_title), title.text.toString())
                    assertTrue(title.isAccessibilityHeading)
                    assertTrue(body.text.isNotBlank())
                    assertTrue(button.isFocusable)
                    assertTrue(button.contentDescription.isNotBlank())
                    assertTrue(button.minimumHeight >= 48 * activity.resources.displayMetrics.density)
                    val background = Color.rgb(15, 15, 14)
                    assertTrue(ColorUtils.calculateContrast(title.currentTextColor, background) >= 4.5)
                    assertTrue(ColorUtils.calculateContrast(body.currentTextColor, background) >= 4.5)
                    assertTrue(ColorUtils.calculateContrast(
                        button.currentTextColor, Color.rgb(236, 231, 221),
                    ) >= 4.5)
                }
                scenario.recreate()
                scenario.onActivity { activity ->
                    assertNull(activity.bridge)
                    assertNotNull(activity.findViewById<View>(R.id.webview_update_screen))
                    assertFalse(containsWebView(activity.findViewById(android.R.id.content)))
                }
            }
        }
    }

    @Test
    fun updateButtonOpensActiveProvidersStorePage() {
        MainActivity.gateForTesting = { WebViewCompatGate.Result.Outdated("com.android.chrome", "110.0") }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.findViewById<Button>(R.id.webview_update_button).performClick()
                val intent = shadowOf(activity).nextStartedActivity
                assertEquals(Intent.ACTION_VIEW, intent.action)
                assertEquals("market://details?id=com.android.chrome", intent.dataString)
            }
        }
    }

    @Test
    fun unknownProviderUsesDefaultStorePage() {
        MainActivity.gateForTesting = { WebViewCompatGate.Result.UnknownPackage }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.findViewById<Button>(R.id.webview_update_button).performClick()
                assertEquals(
                    "market://details?id=com.google.android.webview",
                    shadowOf(activity).nextStartedActivity.dataString,
                )
            }
        }
    }

    @Test
    fun missingPlayStoreFallsBackToHttpsForTheActiveProvider() {
        MainActivity.gateForTesting = { WebViewCompatGate.Result.Outdated("com.android.chrome", "110.0") }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val httpsIntent = Intent(
                    Intent.ACTION_VIEW,
                    "https://play.google.com/store/apps/details?id=com.android.chrome".toUri(),
                )
                shadowOf(activity.packageManager).addResolveInfoForIntent(httpsIntent, ResolveInfo().apply {
                    activityInfo = ActivityInfo().apply {
                        packageName = "com.example.browser"
                        name = "BrowserActivity"
                        exported = true
                    }
                })
                shadowOf(activity.application).checkActivities(true)
                activity.findViewById<Button>(R.id.webview_update_button).performClick()
                assertEquals(httpsIntent.dataString, shadowOf(activity).nextStartedActivity.dataString)
                assertNull(activity.bridge)
            }
        }
    }

    @Test
    fun missingStoreAndBrowserShowsLocalizedInstructionsInsteadOfCrashing() {
        MainActivity.gateForTesting = { WebViewCompatGate.Result.UnknownPackage }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                shadowOf(activity.application).checkActivities(true)
                activity.findViewById<Button>(R.id.webview_update_button).performClick()
                assertEquals(
                    activity.getString(R.string.webview_update_store_unavailable),
                    ShadowToast.getTextOfLatestToast(),
                )
                assertNull(activity.bridge)
            }
        }
    }

    @Test
    @Config(qualifiers = "pt-rBR")
    fun updateScreenIsLocalizedInBrazilianPortuguese() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        assertEquals("open-auri", context.getString(R.string.app_name))
        assertEquals("Atualize o Android System WebView", context.getString(R.string.webview_update_title))
        assertEquals("Abrir Google Play", context.getString(R.string.webview_update_button))
        assertTrue(context.getString(R.string.webview_update_body).contains("segurança"))
    }

    private fun webViewPackage(version: String?) = PackageInfo().apply {
        packageName = "com.android.chrome"
        versionName = version
    }

    private fun check(info: PackageInfo?, featureSupported: Boolean = true) =
        WebViewCompatGate({ featureSupported }, { info }).check()

    private fun containsWebView(view: View): Boolean = view is WebView ||
        (view is ViewGroup && (0 until view.childCount).any { containsWebView(view.getChildAt(it)) })
}
