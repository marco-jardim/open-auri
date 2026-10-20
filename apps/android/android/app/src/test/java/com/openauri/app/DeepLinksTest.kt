package com.openauri.app

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import androidx.core.net.toUri
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.CapConfig
import com.openauri.usb.OriginGuard
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowWebView

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], shadows = [MainActivityBridgeHardeningTest.RecordingWebViewShadow::class, MainActivityBridgeHardeningTest.StubServiceWorkerController::class])
class DeepLinksTest {
    @After fun clearOverrides() {
        MainActivity.gateForTesting = null
        MainActivityBridgeHardeningTest.RecordingWebViewShadow.events.clear()
    }

    @Test fun sameOriginLinksKeepPathQueryAndFragment() {
        val cases = mapOf(
            "https://open-auri.com/c/abc" to "https://open-auri.com/c/abc",
            "https://open-auri.com/c/abc?x=1&y=2#top" to "https://open-auri.com/c/abc?x=1&y=2#top",
            "https://open-auri.com/c/a%20b/?q=%2F#f/g" to "https://open-auri.com/c/a%20b/?q=%2F#f/g",
            "https://open-auri.com?tab=1" to "https://open-auri.com?tab=1",
            "https://open-auri.com#top" to "https://open-auri.com#top",
            "https://open-auri.com" to "https://open-auri.com",
            "https://open-auri.com/" to "https://open-auri.com/",
        )
        for ((data, target) in cases) {
            assertEquals(data, target, DeepLinks.targetFor(Intent.ACTION_VIEW, data, SERVER))
        }
        assertEquals(
            "https://open-auri.com/c/abc",
            DeepLinks.targetFor(Intent.ACTION_VIEW, "https://open-auri.com/c/abc", "https://open-auri.com/start?x=1"),
        )
    }

    @Test fun originsAreNormalizedAndTheTargetUsesTheNormalizedOrigin() {
        val cases = mapOf(
            "https://open-auri.com:443/x" to "https://open-auri.com/x",
            "https://open-auri.com:443" to "https://open-auri.com",
            "HTTPS://Open-Auri.COM/C/Abc?Q=1" to "https://open-auri.com/C/Abc?Q=1",
        )
        for ((data, target) in cases) {
            assertEquals(data, target, DeepLinks.targetFor(Intent.ACTION_VIEW, data, SERVER))
        }
        assertEquals(
            "https://open-auri.com/x",
            DeepLinks.targetFor(Intent.ACTION_VIEW, "https://open-auri.com/x", "https://OPEN-AURI.com:443/"),
        )
    }

    @Test fun everythingElseFailsClosed() {
        val foreignData = listOf(
            null,
            "",
            "https://evil.example/c/abc",
            "https://www.open-auri.com/c/abc",
            "https://open-auri.com.evil.example/c/abc",
            "https://open-auri.com:8443/c/abc",
            "http://open-auri.com/c/abc",
            "https://user@open-auri.com/c/abc",
            "https://user:secret@open-auri.com/c/abc",
            "https://evil.example@open-auri.com/c/abc",
            "https://evil.example\\@open-auri.com/c/abc",
            "https:///c/abc",
            "https:open-auri.com/c/abc",
            " https://open-auri.com/c/abc",
            "javascript:alert(1)",
            "intent://open-auri.com/c/abc#Intent;scheme=https;end",
            "file:///sdcard/c/abc",
            "content://open-auri.com/c/abc",
        )
        for (data in foreignData) {
            assertNull("$data", DeepLinks.targetFor(Intent.ACTION_VIEW, data, SERVER))
        }
        for (action in listOf(null, Intent.ACTION_MAIN, Intent.ACTION_SEND, "android.intent.action.view")) {
            assertNull("$action", DeepLinks.targetFor(action, "https://open-auri.com/c/abc", SERVER))
        }
        for (server in listOf(null, "", "not a url", "https://evil.example", "https://user@open-auri.com")) {
            assertNull("$server", DeepLinks.targetFor(Intent.ACTION_VIEW, "https://open-auri.com/c/abc", server))
        }
        // Debug and e2e builds serve over http: same origin, but deep links stay https-only.
        assertNull(DeepLinks.targetFor(Intent.ACTION_VIEW, "http://10.0.2.2:4173/c/abc", "http://10.0.2.2:4173"))
    }

    @Test fun coldStartLoadsTheLinkedPageOnceAfterTheStartUrl() {
        val origin = httpsServerOrigin(CapConfig.loadDefault(ApplicationProvider.getApplicationContext<Context>()).serverUrl)
        val link = "$origin/c/abc?x=1#top"
        passingGate()
        val controller = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_VIEW, link.toUri()))
        try {
            controller.setup()
            assertNotNull(controller.get().bridge)
            val loads = loads()
            assertTrue("Capacitor's start URL loads first: $loads", loads.size >= 2)
            assertEquals("The link supersedes the start URL: $loads", "load:$link", loads.last())
            assertEquals("The link loads exactly once: $loads", 1, loads.count { it == "load:$link" })
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun newIntentLoadsSameOriginLinksAndIgnoresOthers() {
        passingGate()
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            val origin = httpsServerOrigin(controller.get().bridge.serverUrl)
            MainActivityBridgeHardeningTest.RecordingWebViewShadow.events.clear()

            val link = Intent(Intent.ACTION_VIEW, "$origin:443/c/abc?x=1#top".toUri())
            controller.newIntent(link)
            assertSame(link, controller.get().intent)
            assertEquals(listOf("load:$origin/c/abc?x=1#top"), loads())

            MainActivityBridgeHardeningTest.RecordingWebViewShadow.events.clear()
            controller.newIntent(Intent(Intent.ACTION_VIEW, "https://evil.example/c/abc".toUri()))
            controller.newIntent(Intent(Intent.ACTION_MAIN))
            assertEquals(emptyList<String>(), loads())
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun failingGateIgnoresLaunchAndNewIntents() {
        MainActivity.gateForTesting = { WebViewCompatGate.Result.MissingFeature }
        val launch = Intent(Intent.ACTION_VIEW, "https://open-auri.com/c/abc".toUri())
        val controller = Robolectric.buildActivity(MainActivity::class.java, launch).setup()
        try {
            val next = Intent(Intent.ACTION_VIEW, "https://open-auri.com/c/def".toUri())
            controller.newIntent(next)
            assertSame(next, controller.get().intent)
            assertNull(controller.get().bridge)
            assertTrue(MainActivityBridgeHardeningTest.RecordingWebViewShadow.events.isEmpty())
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun backIsOfferedToThePageBeforeHistoryAndLeavingTheApp() {
        passingGate()
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            val activity = controller.get()
            val web = org.robolectric.Shadows.shadowOf(activity.bridge.webView)
            fun back(pageAnswer: String) {
                activity.onBackPressedDispatcher.onBackPressed()
                assertEquals(MainActivity.NATIVE_BACK_SCRIPT, web.lastEvaluatedJavascript)
                web.lastEvaluatedJavascriptCallback.onReceiveValue(pageAnswer)
            }
            web.setCanGoBack(true)
            back("true") // An open overlay consumed Back.
            assertEquals(0, web.goBackInvocations)
            assertTrue(!activity.isFinishing)
            back("false") // No overlay: previous page.
            assertEquals(1, web.goBackInvocations)
            assertTrue(!activity.isFinishing)
            web.setCanGoBack(false)
            back("null") // No overlay and no history (or a page without the handler): leave.
            assertEquals(1, web.goBackInvocations)
            assertTrue(activity.isFinishing)
        } finally {
            controller.pause().stop().destroy()
        }
    }
    private fun passingGate() {
        MainActivity.gateForTesting = { WebViewCompatGate.Result.Ok }
        ShadowWebView.setCurrentWebViewPackage(PackageInfo().apply {
            packageName = "com.google.android.webview"
            versionName = "150.0.0.0"
        })
    }

    private fun loads() = MainActivityBridgeHardeningTest.RecordingWebViewShadow.events.filter { it.startsWith("load:") }

    /** The activity tests need the synced https server URL; an http (e2e) sync skips them. */
    private fun httpsServerOrigin(serverUrl: String?): String {
        val origin = OriginGuard.originOf(serverUrl)
        assumeTrue("Deep links need an https server URL, not $serverUrl", origin?.startsWith("https://") == true)
        return checkNotNull(origin)
    }

    companion object {
        private const val SERVER = "https://open-auri.com"
    }
}
