package com.openauri.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DisclaimerTest {
    @Test
    fun firstUseBootsStraightToEditorWithoutDisclaimerOrCableBanner() {
        WebAppScenario.launch().use { app ->
            // Isolate first use from the order in which the other device specs run.
            app.evaluate("localStorage.removeItem('oa.androidDisclaimerAck')")
            app.navigate("/?android-disclaimer=fresh")
            awaitEditor(app)
            assertNoDisclaimer(app)

            app.scenario.recreate()
            awaitEditor(app)
            assertNoDisclaimer(app)

            app.navigate("/cabo")
            app.awaitJs("document.querySelector('button.connect:not(:disabled):not([aria-disabled=\"true\"])') != null", "ready cable page")
            assertEquals(null, app.evaluate("document.querySelector('aside.banner a[href=\"/docs#android-resgate\"]')"))
            assertNoDisclaimer(app)
        }
    }

    private fun awaitEditor(app: WebAppScenario) {
        // The editor's loading status disappears only once the client app is ready.
        app.awaitJs("window.Capacitor?.isNativePlatform() === true && document.querySelector('main.curva') != null && document.querySelector('main.curva > p.visually-hidden[role=\"status\"]') == null", "ready native curve editor")
    }

    private fun assertNoDisclaimer(app: WebAppScenario) {
        assertEquals(null, app.evaluate("document.querySelector('dialog [data-ack]')"))
        assertEquals(null, app.evaluate("localStorage.getItem('oa.androidDisclaimerAck')"))
    }
}
