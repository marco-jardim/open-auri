package com.openauri.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DisclaimerTest {
    @Test
    fun legacyAckBootsStraightToEditorWithoutDisclaimerOrCableBanner() {
        WebAppScenario.launch().use { app ->
            // Backward compatibility: installs from the disclaimer era still carry the version-2
            // acknowledgement. The page must ignore it and never show a modal or the old notice.
            app.evaluate("localStorage.setItem('oa.androidDisclaimerAck', '2')")
            app.navigate("/?android-disclaimer=legacy-ack")
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
        // The lower instrument renders only once the client app has hydrated, as in DownloadFlowTest.
        app.awaitJs("window.Capacitor?.isNativePlatform() === true && document.querySelector('main.curva .lower') != null", "ready native curve editor")
    }

    private fun assertNoDisclaimer(app: WebAppScenario) {
        assertEquals("open <dialog>", false, app.evaluate("document.querySelector('dialog[open]') != null"))
        assertEquals("modal role=dialog", false, app.evaluate("document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]') != null"))
        assertEquals(
            "retired disclaimer text: ${app.evaluate("document.body.innerText.slice(0, 1500)")}",
            false,
            app.evaluate("/Galaxy A70|tested on one phone|teste em um celular/.test(document.body.innerText)"),
        )
    }
}
