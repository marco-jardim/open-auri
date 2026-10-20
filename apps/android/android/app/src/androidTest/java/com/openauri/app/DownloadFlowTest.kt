package com.openauri.app

import android.app.Activity
import android.app.Instrumentation.ActivityResult
import android.content.Intent
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasExtra
import androidx.test.espresso.intent.matcher.IntentMatchers.hasType
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.hamcrest.Matchers.allOf
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DownloadFlowTest {
    @Before
    fun cancelTheSystemPicker() {
        Intents.init()
        Intents.intending(hasAction(Intent.ACTION_CREATE_DOCUMENT))
            .respondWith(ActivityResult(Activity.RESULT_CANCELED, null))
    }

    @After
    fun releaseIntents() = Intents.release()

    @Test
    fun realJsonExportUsesSafWithTheDisplayedCurveNameAndCanBeCanceled() {
        WebAppScenario.launch("/").use { app ->
            app.acceptDisclaimerIfPresent()
            // Import/export is an intersection-loaded island below the curve editor.
            app.awaitJs("document.querySelector('main.curva .lower') != null", "curve editor")
            app.evaluate("document.querySelector('main.curva .lower').scrollIntoView()")
            val jsonButton = "Array.from(document.querySelectorAll('.exports button')).find(b => b.textContent.includes('JSON'))"
            app.awaitJs("($jsonButton) != null && !($jsonButton).disabled && ($jsonButton).getAttribute('aria-disabled') !== 'true'", "enabled JSON export")
            val name = app.evaluate("document.querySelector('.np-name').textContent.trim()") as String
            assertTrue("The export must have a visible curve name", name.isNotBlank())
            val expectedFile = app.evaluate("""
                document.querySelector('.np-name').textContent.trim().normalize('NFKD')
                  .replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '-')
                  .replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) + '.json'
            """.trimIndent()) as String
            // Observe the real bridge promise without replacing the plugin or its result.
            app.evaluate("""
                (() => {
                  const nativePromise = Capacitor.nativePromise;
                  window.__oaSaveResults = [];
                  Capacitor.nativePromise = function(plugin, method, options) {
                    const promise = nativePromise.call(this, plugin, method, options);
                    if (plugin === 'OpenAuriFiles' && method === 'save') {
                      promise.then(
                        result => window.__oaSaveResults.push({ state: 'resolved', saved: result.saved }),
                        error => window.__oaSaveResults.push({ state: 'rejected', error: String(error), code: error.code })
                      );
                    }
                    return promise;
                  };
                })()
            """.trimIndent())
            val expectedIntent = allOf(
                hasAction(Intent.ACTION_CREATE_DOCUMENT),
                hasExtra(Intent.EXTRA_TITLE, expectedFile),
                hasType("application/json"),
            )
            app.evaluate("($jsonButton).click()")
            awaitRecordedIntent(expectedIntent)
            // The stub returns cancellation through the real ActivityResult/Capacitor callback.
            // A second export proves that cancellation released the plugin's single-save slot.
            awaitCanceledSave(app, 1)
            app.evaluate("($jsonButton).click()")
            awaitRecordedIntent(expectedIntent, expectedCount = 2)
            awaitCanceledSave(app, 2)
            assertEquals(E2E_ORIGIN, app.evaluate("location.origin"))
        }
    }

    private fun awaitCanceledSave(app: WebAppScenario, expectedCount: Int) {
        app.awaitJs("window.__oaSaveResults.length >= $expectedCount", "SAF cancellation callback #$expectedCount", timeoutMs = 15_000)
        val result = app.evaluate("window.__oaSaveResults[${expectedCount - 1}]") as JSONObject
        assertEquals("SAF save #$expectedCount must resolve, not reject: $result", "resolved", result.getString("state"))
        assertEquals("SAF save #$expectedCount must report cancellation: $result", false, result.getBoolean("saved"))
    }
}
