package com.openauri.app

import android.content.Context
import android.content.pm.PackageInfo
import android.os.Looper
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.ServiceWorkerWebSettings
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowWebView

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], shadows = [MainActivityBridgeHardeningTest.RecordingWebViewShadow::class, MainActivityBridgeHardeningTest.StubServiceWorkerController::class])
class MainActivityBridgeHardeningTest {
    /** Robolectric has no ServiceWorkerController; Capacitor's Bridge asks for it during init. */
    @Implements(ServiceWorkerController::class)
    class StubServiceWorkerController {
        companion object {
            @JvmStatic
            @Implementation
            fun getInstance(): ServiceWorkerController = object : ServiceWorkerController() {
                override fun getServiceWorkerWebSettings(): ServiceWorkerWebSettings =
                    throw UnsupportedOperationException("not used by the bridge")

                override fun setServiceWorkerClient(client: ServiceWorkerClient?) = Unit
            }
        }
    }

    @Implements(WebView::class)
    class RecordingWebViewShadow : ShadowWebView() {
        @Implementation
        public override fun addJavascriptInterface(value: Any, name: String) {
            events.add("add:$name")
            super.addJavascriptInterface(value, name)
        }

        @Implementation
        public override fun removeJavascriptInterface(name: String) {
            assertEquals(Looper.getMainLooper(), Looper.myLooper())
            events.add("remove:$name")
            super.removeJavascriptInterface(name)
        }

        @Implementation
        public override fun loadUrl(url: String) {
            events.add("load:$url")
            super.loadUrl(url)
        }

        companion object {
            val events = mutableListOf<String>()
        }
    }

    @After fun clearOverrides() {
        MainActivity.gateForTesting = null
        RecordingWebViewShadow.events.clear()
    }

    @Test fun removesBothNativeInterfacesAndAliasesWithoutTouchingOtherBridges() {
        val view = WebView(ApplicationProvider.getApplicationContext<Context>())
        try {
            for (name in interfaceNames + "OriginRestrictedBridge") {
                view.addJavascriptInterface(Any(), name)
                assertNotNull(shadowOf(view).getJavascriptInterface(name))
            }
            RecordingWebViewShadow.events.clear()
            BridgeHardening.harden(view)
            assertEquals(interfaceNames.map { "remove:$it" }, RecordingWebViewShadow.events)
            for (name in interfaceNames) assertNull(shadowOf(view).getJavascriptInterface(name))
            assertNotNull(shadowOf(view).getJavascriptInterface("OriginRestrictedBridge"))
        } finally {
            view.destroy()
        }
    }

    @Test fun passingGateRemovesCoreInterfacesBeforeTheFirstNavigation() {
        MainActivity.gateForTesting = { WebViewCompatGate.Result.Ok }
        ShadowWebView.setCurrentWebViewPackage(PackageInfo().apply {
            packageName = "com.google.android.webview"
            versionName = "150.0.0.0"
        })
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            val bridge = controller.get().bridge
            assertNotNull(bridge)
            val events = RecordingWebViewShadow.events
            val firstLoad = events.indexOfFirst { it.startsWith("load:") }
            assertTrue("Expected a first navigation: $events", firstLoad >= 0)
            for (name in interfaceNames) {
                val removal = events.indexOf("remove:$name")
                assertTrue("$name must be removed before the first navigation: $events", removal in 0 until firstLoad)
                assertNull(shadowOf(bridge.webView).getJavascriptInterface(name))
            }
            for (name in interfaceNames.filter { it.endsWith("AndroidInterface") }) {
                val addition = events.indexOf("add:$name")
                assertTrue("Core registration must precede removal: $events", addition in 0 until events.indexOf("remove:$name"))
            }
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun failingGateNeverCreatesABridgeOrRunsHardeningOrNavigation() {
        MainActivity.gateForTesting = { WebViewCompatGate.Result.MissingFeature }
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        try {
            assertNull(controller.get().bridge)
            assertTrue(RecordingWebViewShadow.events.isEmpty())
        } finally {
            controller.pause().stop().destroy()
        }
    }

    companion object {
        private val interfaceNames = listOf(
            "CapacitorCookies", "CapacitorHttp",
            "CapacitorCookiesAndroidInterface", "CapacitorHttpAndroidInterface",
        )
    }
}
