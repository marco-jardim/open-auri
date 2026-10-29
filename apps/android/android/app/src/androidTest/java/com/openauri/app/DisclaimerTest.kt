package com.openauri.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DisclaimerTest {
    @Test
    fun firstUseNoticePersistsAcrossRecreationAndCableKeepsTheBanner() {
        WebAppScenario.launch().use { app ->
            // Isolate first use from the order in which the other device specs run.
            app.evaluate("localStorage.removeItem('oa.androidDisclaimerAck')")
            app.navigate("/?android-disclaimer=fresh")
            app.awaitJs("document.querySelector('dialog[open] [data-ack]') != null", "first-use untested-cable modal")
            val title = app.evaluate("document.querySelector('dialog[open] h2').textContent.trim()")
            assertTrue("The modal must use the G.1 title: $title", title in listOf(
                "Gravação pelo app: teste em um celular",
                "Writing from the app: tested on one phone",
            ))
            app.evaluate("document.querySelector('dialog[open] [data-ack]').click()")
            app.awaitJs("document.querySelector('dialog[open] [data-ack]') == null && localStorage.getItem('oa.androidDisclaimerAck') != null", "persisted acknowledgement")
            val acceptedVersion = app.evaluate("localStorage.getItem('oa.androidDisclaimerAck')")

            app.scenario.recreate()
            // Wait for the lazy notice to mount again before checking it is closed.
            app.awaitJs("window.Capacitor?.isNativePlatform() === true && document.querySelector('dialog [data-ack]') != null", "native notice after activity recreation")
            assertEquals(acceptedVersion, app.evaluate("localStorage.getItem('oa.androidDisclaimerAck')"))
            assertEquals(null, app.evaluate("document.querySelector('dialog[open] [data-ack]')"))

            app.navigate("/cabo")
            app.awaitJs("document.querySelector('aside.banner a[href=\"/docs#android-resgate\"]') != null", "persistent recovery banner on /cabo")
            assertEquals(title, app.evaluate("document.querySelector('aside.banner').getAttribute('aria-label')"))
            assertEquals(null, app.evaluate("document.querySelector('dialog[open] [data-ack]')"))
        }
    }
}
