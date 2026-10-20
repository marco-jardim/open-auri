package com.openauri.usb

import android.content.Context
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class OriginGuardTest {

    @Test
    fun originsAreNormalizedFromTheAuthorityOnly() {
        val cases = mapOf(
            "https://open-auri.com" to "https://open-auri.com",
            "https://open-auri.com/" to "https://open-auri.com",
            "HTTPS://Open-Auri.COM/Cabo?x=1#y" to "https://open-auri.com",
            "https://open-auri.com:443/cabo" to "https://open-auri.com",
            "https://open-auri.com:8443/cabo" to "https://open-auri.com:8443",
            "https://open-auri.com?tab=1" to "https://open-auri.com",
            "https://open-auri.com#top" to "https://open-auri.com",
            "https://open-auri.com/c/a b|{}^`" to "https://open-auri.com",
            "http://10.0.2.2:5173/cabo" to "http://10.0.2.2:5173",
            "http://example.com:80/" to "http://example.com",
            "http://[::1]:8080/" to "http://[::1]:8080",
        )
        for ((url, origin) in cases) assertEquals(url, origin, OriginGuard.originOf(url))
    }

    @Test
    fun urlsWithoutAVerifiableOriginHaveNone() {
        val rejected = listOf(
            null,
            "",
            "open-auri.com",
            "://open-auri.com",
            "about:blank",
            "data:text/html,https://open-auri.com",
            "blob:https://open-auri.com/0b9c",
            "file:///sdcard/open-auri.html",
            "javascript://open-auri.com",
            "ftp://open-auri.com/",
            "https://user@open-auri.com/",
            "https://user:secret@open-auri.com/",
            "https:///cabo",
            "https://open auri.com/",
            "https://open-auri.com\\@evil.example/",
            "https://open_auri.com/",
        )
        for (url in rejected) assertNull(url, OriginGuard.originOf(url))
    }

    @Test
    fun onlyThePinnedOriginIsAllowed() {
        val pinned = "https://open-auri.com"
        val allowed = listOf("https://open-auri.com/cabo", "https://OPEN-AURI.com:443/", "https://open-auri.com")
        val refused = listOf(
            "https://evil.example/",
            "http://open-auri.com/",
            "https://open-auri.com:8443/",
            "https://open-auri.com.evil.example/",
            "https://staging.open-auri.com/",
            "https://localhost/offline.html",
            "https://evil.example/?next=https://open-auri.com/",
            null,
        )
        for (url in allowed) {
            val guard = OriginGuard({ pinned }, { url })
            assertTrue(url, guard.isAllowed())
            guard.check()
        }
        for (url in refused) {
            val guard = OriginGuard({ pinned }, { url })
            assertFalse(url.toString(), guard.isAllowed())
            val error = assertThrows(UsbBridgeException::class.java) { guard.check() }
            assertEquals(ErrorCodes.USB_ORIGIN, error.code)
        }
        assertFalse(OriginGuard({ null }, { "https://open-auri.com/" }).isAllowed())
        assertFalse(OriginGuard({ "not a url" }, { "https://open-auri.com/" }).isAllowed())
        assertTrue(OriginGuard({ "http://10.0.2.2:5173" }, { "http://10.0.2.2:5173/cabo" }).isAllowed())
    }

    @Test
    fun guardReadsBothUrlsOnEveryCheck() {
        var page: String? = "https://open-auri.com/"
        var server: String? = "https://open-auri.com"
        val guard = OriginGuard({ server }, { page })
        assertTrue(guard.isAllowed())
        page = "https://evil.example/"
        assertFalse(guard.isAllowed())
        page = "https://open-auri.com/"
        server = "https://staging.open-auri.com"
        assertFalse(guard.isAllowed())
    }

    @Test
    fun trackerFollowsTheMainFrameAndReportsEachNewDocument() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        var documents = 0
        val tracker = MainFrameUrlTracker { documents++ }
        assertNull(tracker.url)
        val webView = WebView(context)
        webView.loadUrl("https://open-auri.com/cabo")
        tracker.onPageStarted(webView)
        assertEquals("https://open-auri.com/cabo", tracker.url)
        assertEquals(1, documents)
        tracker.onPageCommitVisible(webView, "https://open-auri.com/docs")
        assertEquals("https://open-auri.com/docs", tracker.url)
        tracker.onPageCommitVisible(webView, null)
        assertNull(tracker.url)
        tracker.onPageLoaded(webView)
        assertEquals("https://open-auri.com/cabo", tracker.url)
        tracker.update("https://evil.example/")
        assertEquals("https://evil.example/", tracker.url)
        assertEquals(1, documents)
        val guard = OriginGuard({ "https://open-auri.com" }, { tracker.url })
        assertFalse(guard.isAllowed())
        tracker.update("https://open-auri.com/")
        assertTrue(guard.isAllowed())
    }
}
