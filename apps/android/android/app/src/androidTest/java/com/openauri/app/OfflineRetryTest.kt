package com.openauri.app

import android.app.Activity
import android.app.Instrumentation.ActivityResult
import android.content.Intent
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OfflineRetryTest {
    @Before
    fun blockBrowserLaunches() {
        Intents.init()
        Intents.intending(hasAction(Intent.ACTION_VIEW)).respondWith(ActivityResult(Activity.RESULT_CANCELED, null))
    }

    @After
    fun releaseIntents() = Intents.release()

    @Test
    fun bundledOfflinePageRetriesTheConfiguredServerInsideTheWebView() {
        WebAppScenario.launch().use { app ->
            // Load the configured bundled errorPath without stopping the shared preview server.
            app.scenario.onActivity { activity ->
                val errorUrl = activity.bridge.errorUrl
                assertTrue("Capacitor must configure offline.html", errorUrl?.endsWith("/offline.html") == true)
                activity.bridge.webView.loadUrl(requireNotNull(errorUrl))
            }
            app.awaitJs("location.origin === 'https://localhost' && location.pathname === '/offline.html' && document.querySelector('#retry') != null", "bundled offline page")
            app.awaitJs("document.querySelector('#retry').textContent === 'Tentar de novo' || document.querySelector('#retry').textContent === 'Try again'", "localized retry link")
            // Q1 G8: the real hashed inline script uses location.replace to the retry sentinel.
            app.evaluate("document.querySelector('#retry').click()")
            app.awaitJs("location.origin === '$E2E_ORIGIN' && location.pathname === '/' && document.readyState === 'complete' && window.Capacitor?.isNativePlatform() === true && document.querySelector('main') != null", "retry to the pinned preview")
            assertEquals(0, Intents.getIntents().count { it.action == Intent.ACTION_VIEW })
            val info = app.promise("Capacitor.Plugins.OpenAuriUsb.getInfo()") as org.json.JSONObject
            assertEquals(1, info.getInt("bridgeApi"))
        }
    }
}
