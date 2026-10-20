package com.openauri.app

import android.app.Activity
import android.app.Instrumentation.ActivityResult
import android.content.Intent
import android.os.SystemClock
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.VerificationModes.times
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasData
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.hamcrest.Matcher
import org.hamcrest.Matchers.allOf
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ExternalNavigationTest {
    @Before
    fun captureIntents() {
        Intents.init()
        Intents.intending(hasAction(Intent.ACTION_VIEW)).respondWith(ActivityResult(Activity.RESULT_CANCELED, null))
    }

    @After
    fun releaseIntents() = Intents.release()

    @Test
    fun internalLinksStayInTheWebViewAndExternalLinksOpenTheBrowser() {
        WebAppScenario.launch().use { app ->
            app.acceptDisclaimerIfPresent()
            app.awaitJs("document.querySelector('a[href=\"/cabo\"]') != null", "internal cable link")
            app.evaluate("document.querySelector('a[href=\"/cabo\"]').click()")
            app.awaitJs("location.origin === '$E2E_ORIGIN' && location.pathname === '/cabo'", "internal WebView navigation")
            app.awaitJs("document.querySelector('aside.banner a[href=\"/docs#android-resgate\"]') != null", "cable page hydration")
            assertEquals(0, Intents.getIntents().count { it.action == Intent.ACTION_VIEW })

            // A real anchor click exercises shouldOverrideUrlLoading, unlike WebView.loadUrl.
            app.evaluate("""
                (() => {
                  const link = document.createElement('a');
                  link.href = 'https://kuba.audio/';
                  link.textContent = 'Kuba';
                  document.body.append(link);
                  link.click();
                })()
            """.trimIndent())
            awaitRecordedIntent(allOf(hasAction(Intent.ACTION_VIEW), hasData("https://kuba.audio/")))
            assertEquals(E2E_ORIGIN, app.evaluate("location.origin"))
            assertEquals("/cabo", app.evaluate("location.pathname"))
        }
    }
}

/** Renderer and plugin callbacks are asynchronous and are not Espresso idling resources. */
internal fun awaitRecordedIntent(matcher: Matcher<Intent>, expectedCount: Int = 1, timeoutMs: Long = 15_000) {
    require(expectedCount > 0 && timeoutMs > 0)
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (Intents.getIntents().count { matcher.matches(it) } < expectedCount) {
        val remainingMs = deadline - SystemClock.elapsedRealtime()
        if (remainingMs <= 0) break
        SystemClock.sleep(minOf(100L, remainingMs))
    }
    val recorded = Intents.getIntents()
    assertEquals("Expected $expectedCount intent(s) matching $matcher within ${timeoutMs}ms; recorded=$recorded", expectedCount, recorded.count { matcher.matches(it) })
    Intents.intended(matcher, times(expectedCount))
}
