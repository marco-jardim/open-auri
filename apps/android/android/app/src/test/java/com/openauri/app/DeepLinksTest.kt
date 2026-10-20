package com.openauri.app

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.os.Bundle
import android.os.Looper
import androidx.core.net.toUri
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.CapConfig
import com.getcapacitor.OfflineAwareWebViewClient
import com.openauri.usb.OriginGuard
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast
import org.robolectric.shadows.ShadowWebView

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], shadows = [MainActivityBridgeHardeningTest.RecordingWebViewShadow::class, MainActivityBridgeHardeningTest.StubServiceWorkerController::class])
class DeepLinksTest {
    @After fun clearOverrides() {
        MainActivity.gateForTesting = null
        MainActivity.historyForTesting = null
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

    @Test fun onlyPagesAreLinkableNotApiDataDumpsOrJson() {
        val pages = listOf(
            "/", "/c/abc", "/u/someone", "/#p=AbC123", "/?tab=1#p=x", "/docs/api", "/c/api", "/apix",
            "/dados-abertos", "/c/x?format=.json", "/c/x#.json", "/manifest.webmanifest", "/c/a/../b",
        )
        for (path in pages) {
            assertEquals(path, "$SERVER$path", DeepLinks.targetFor(Intent.ACTION_VIEW, "$SERVER$path", SERVER))
        }
        assertEquals("$SERVER?tab=1", DeepLinks.targetFor(Intent.ACTION_VIEW, "$SERVER?tab=1", SERVER))
        val blocked = listOf(
            "/api", "/api/", "/api/auth/session", "/API/Auth", "/dados", "/dados/", "/dados/dump/all",
            "/c/x.json", "/c/X.JSON", "/c/x.json?y=1#z", "/c/x.json/", "/c/x%2Ejson",
            // Spellings the WebView or the server resolve to the same blocked path.
            "/c/../api/auth", "/%2e%2e/api/x", "/c/%2E%2E/dados/x", "/./api", "//api/auth", "/%61pi/x",
            "/api%2Fauth", "/c\\..\\api\\auth", "/a\tpi/x", "/da\r\ndos/x",
        )
        for (path in blocked) {
            assertNull(path, DeepLinks.targetFor(Intent.ACTION_VIEW, "$SERVER$path", SERVER))
        }
    }

    @Test fun pathSegmentsAreNormalizedLikeTheWebView() {
        assertEquals(listOf("b", "c"), DeepLinks.normalizedSegments("/C/./a/../%2e%2E/B%2f\\c//"))
        assertEquals(emptyList<String>(), DeepLinks.normalizedSegments(""))
        assertEquals(emptyList<String>(), DeepLinks.normalizedSegments("/../.."))
        // Invalid escapes stay as they are; valid ones are decoded exactly once.
        assertEquals(listOf("100%", "%4", "%zz"), DeepLinks.normalizedSegments("/100%/%4/%zz"))
        assertEquals(listOf("%2e", "api"), DeepLinks.normalizedSegments("/%252e/api"))
    }

    @Test fun onlyAFreshLaunchOpensTheLaunchIntent() {
        val view = Intent(Intent.ACTION_VIEW, "https://open-auri.com/c/abc".toUri())
        assertTrue(MainActivity.isFreshLaunch(null, view))
        assertTrue(MainActivity.isFreshLaunch(null, Intent(view).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)))
        assertFalse(MainActivity.isFreshLaunch(Bundle(), view))
        assertFalse(MainActivity.isFreshLaunch(null, Intent(view).addFlags(
            Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY or Intent.FLAG_ACTIVITY_NEW_TASK,
        )))
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

    @Test fun recreationDoesNotReplayTheLaunchLink() {
        val origin = httpsServerOrigin(CapConfig.loadDefault(ApplicationProvider.getApplicationContext<Context>()).serverUrl)
        val link = "$origin/#p=preset"
        passingGate()
        val controller = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_VIEW, link.toUri()))
        try {
            controller.setup()
            assertEquals("load:$link", loads().last())
            MainActivityBridgeHardeningTest.RecordingWebViewShadow.events.clear()
            // In-process recreation (e.g. a font scale change outside configChanges).
            controller.recreate()
            assertNotNull(controller.get().bridge)
            val loads = loads()
            assertTrue("The new bridge loads its start URL: $loads", loads.isNotEmpty())
            assertFalse("A preset link must not be re-applied: $loads", "load:$link" in loads)
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun aRestoreAfterProcessDeathOrARelaunchFromRecentsDoesNotReplayTheLink() {
        val origin = httpsServerOrigin(CapConfig.loadDefault(ApplicationProvider.getApplicationContext<Context>()).serverUrl)
        val link = "$origin/c/abc"
        passingGate()
        val restored = loadsAfterLaunch(Intent(Intent.ACTION_VIEW, link.toUri()), Bundle())
        assertTrue("$restored", restored.isNotEmpty() && "load:$link" !in restored)
        val recents = Intent(Intent.ACTION_VIEW, link.toUri()).addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
        val relaunched = loadsAfterLaunch(recents, null)
        assertTrue("$relaunched", relaunched.isNotEmpty() && "load:$link" !in relaunched)
    }

    @Test fun newIntentLoadsSameOriginLinksAndIgnoresOthers() {
        passingGate()
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            val origin = httpsServerOrigin(controller.get().bridge.serverUrl)
            val web = shadowOf(controller.get().bridge.webView)
            MainActivityBridgeHardeningTest.RecordingWebViewShadow.events.clear()

            val link = Intent(Intent.ACTION_VIEW, "$origin:443/c/abc?x=1#top".toUri())
            controller.newIntent(link)
            assertSame(link, controller.get().intent)
            assertEquals(MainActivity.WRITE_IN_PROGRESS_SCRIPT, web.lastEvaluatedJavascript)
            web.lastEvaluatedJavascriptCallback.onReceiveValue("false")
            assertEquals(listOf("load:$origin/c/abc?x=1#top"), loads())

            MainActivityBridgeHardeningTest.RecordingWebViewShadow.events.clear()
            val answered = web.lastEvaluatedJavascriptCallback
            controller.newIntent(Intent(Intent.ACTION_VIEW, "https://evil.example/c/abc".toUri()))
            controller.newIntent(Intent(Intent.ACTION_VIEW, "$origin/api/auth/session".toUri()))
            controller.newIntent(Intent(Intent.ACTION_MAIN))
            assertSame("Refused links do not even ask the page", answered, web.lastEvaluatedJavascriptCallback)
            assertEquals(emptyList<String>(), loads())
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun aWarmLinkDuringAWriteIsDroppedWithANotice() {
        passingGate()
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            val activity = controller.get()
            val origin = httpsServerOrigin(activity.bridge.serverUrl)
            val web = shadowOf(activity.bridge.webView)
            MainActivityBridgeHardeningTest.RecordingWebViewShadow.events.clear()

            controller.newIntent(Intent(Intent.ACTION_VIEW, "$origin/c/abc".toUri()))
            assertEquals(MainActivity.WRITE_IN_PROGRESS_SCRIPT, web.lastEvaluatedJavascript)
            assertEquals("Nothing loads before the page answers", emptyList<String>(), loads())
            web.lastEvaluatedJavascriptCallback.onReceiveValue("true")
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(emptyList<String>(), loads())
            assertEquals(activity.getString(R.string.deep_link_write_in_progress), ShadowToast.getTextOfLatestToast())

            // A page that cannot answer (no script result) does not block the link.
            controller.newIntent(Intent(Intent.ACTION_VIEW, "$origin/u/someone".toUri()))
            web.lastEvaluatedJavascriptCallback.onReceiveValue("null")
            assertEquals(listOf("load:$origin/u/someone"), loads())
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun destroyCancelsThePendingOfflineCheck() {
        passingGate()
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val bridge = controller.get().bridge
        val client = bridge.webViewClient as OfflineAwareWebViewClient
        var probes = 0
        client.siteProbe = { _, result -> probes++; result(OfflineAwareWebViewClient.PageState.OTHER) }
        client.receivedError(bridge.webView, true, OfflineAwareWebViewClient.ErrorKind.NETWORK)
        controller.pause().stop().destroy()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(2 * OfflineAwareWebViewClient.SETTLE_TIMEOUT_MS + 1))
        assertEquals("No probe of the destroyed WebView", 0, probes)
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
            val webView = activity.bridge.webView
            val origin = httpsServerOrigin(activity.bridge.serverUrl)
            val web = org.robolectric.Shadows.shadowOf(webView)
            var history = listOf("$origin/docs", "$origin/c/abc") to 1
            MainActivity.historyForTesting = { history }
            web.setCanGoBack(true) // Robolectric counts goBack() only when it may go back.
            fun back(pageAnswer: String) {
                activity.onBackPressedDispatcher.onBackPressed()
                assertEquals(MainActivity.NATIVE_BACK_SCRIPT, web.lastEvaluatedJavascript)
                web.lastEvaluatedJavascriptCallback.onReceiveValue(pageAnswer)
            }
            back("\"consumed\"") // An open overlay consumed Back.
            assertEquals(0, web.goBackInvocations)
            assertTrue(!activity.isFinishing)
            back("\"history\"") // No overlay: previous page.
            assertEquals(1, web.goBackInvocations)
            assertTrue(!activity.isFinishing)
            history = listOf("$origin/", "https://localhost/offline.html", "$origin/") to 2
            back("\"history\"") // After a retry: skip the offline page (two steps back).
            assertEquals(3, web.goBackInvocations)
            assertTrue(!activity.isFinishing)
            history = listOf("$origin/docs", "$origin/") to 1
            back("null") // An older page without the contract: history as before.
            assertEquals(4, web.goBackInvocations)
            assertTrue(!activity.isFinishing)
            history = listOf("$origin/") to 0
            back("\"history\"") // No history on the site: leave.
            assertTrue(activity.isFinishing)
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun theFirstRunNoticeLetsBackLeaveWithoutWalkingHistory() {
        passingGate()
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            val activity = controller.get()
            httpsServerOrigin(activity.bridge.serverUrl)
            val web = org.robolectric.Shadows.shadowOf(activity.bridge.webView)
            web.setCanGoBack(true)
            MainActivity.historyForTesting = { listOf("https://open-auri.com/docs", "https://open-auri.com/") to 1 }
            activity.onBackPressedDispatcher.onBackPressed()
            assertTrue(web.lastEvaluatedJavascript.contains("__oaWriteInProgress"))
            web.lastEvaluatedJavascriptCallback.onReceiveValue("\"leave\"")
            assertEquals(0, web.goBackInvocations)
            assertTrue(activity.isFinishing)
        } finally {
            controller.pause().stop().destroy()
        }
    }
    @Test fun backOnTheOfflinePageLeavesWithoutAskingThePage() {
        passingGate()
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            val activity = controller.get()
            httpsServerOrigin(activity.bridge.serverUrl)
            val web = org.robolectric.Shadows.shadowOf(activity.bridge.webView)
            activity.bridge.webView.loadUrl("https://localhost/offline.html")
            activity.onBackPressedDispatcher.onBackPressed()
            assertTrue(web.lastEvaluatedJavascript != MainActivity.NATIVE_BACK_SCRIPT)
            assertTrue(activity.isFinishing)
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun backHistorySkipsEntriesOffTheSite() {
        val s = SERVER
        val offline = "https://localhost/offline.html"
        assertEquals(2, BackNavigation.stepsBack(listOf("$s/", offline, "$s/"), 2, s))
        assertEquals(1, BackNavigation.stepsBack(listOf("$s/", "$s/docs"), 1, s))
        assertEquals(0, BackNavigation.stepsBack(listOf(offline, "$s/"), 1, s))
        assertEquals(0, BackNavigation.stepsBack(listOf("$s/"), 0, s))
        assertEquals(0, BackNavigation.stepsBack(listOf(null, "https://evil.example/", "$s/x"), 2, s))
        assertEquals(1, BackNavigation.stepsBack(listOf("$s:443/a", "$s/b"), 1, s))
    }
    private fun passingGate() {
        MainActivity.gateForTesting = { WebViewCompatGate.Result.Ok }
        ShadowWebView.setCurrentWebViewPackage(PackageInfo().apply {
            packageName = "com.google.android.webview"
            versionName = "150.0.0.0"
        })
    }

    private fun loads() = MainActivityBridgeHardeningTest.RecordingWebViewShadow.events.filter { it.startsWith("load:") }

    /** The navigations of one full launch with [intent] (restored from [savedState] when given). */
    private fun loadsAfterLaunch(intent: Intent, savedState: Bundle?): List<String> {
        val controller = Robolectric.buildActivity(MainActivity::class.java, intent)
        try {
            if (savedState == null) controller.setup() else controller.setup(savedState)
            assertNotNull(controller.get().bridge)
            return loads()
        } finally {
            controller.pause().stop().destroy()
            MainActivityBridgeHardeningTest.RecordingWebViewShadow.events.clear()
        }
    }

    /**
     * The activity tests need the synced https server URL; an http (e2e) sync skips them
     * (accepted: the helper tests above still run, and e2e builds never deep-link).
     */
    private fun httpsServerOrigin(serverUrl: String?): String {
        val origin = OriginGuard.originOf(serverUrl)
        assumeTrue("Deep links need an https server URL, not $serverUrl", origin?.startsWith("https://") == true)
        return checkNotNull(origin)
    }

    companion object {
        private const val SERVER = "https://open-auri.com"
    }
}
