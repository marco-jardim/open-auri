package com.openauri.app

import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class BridgeBootTest {
    @Test
    fun bridgeBootsUnderTheRealCspAndHttpErrorsStayOnTheSite() {
        WebAppScenario.launch().use { app ->
            assertEquals(E2E_ORIGIN, app.evaluate("location.origin"))
            app.awaitJs("window.Capacitor?.isNativePlatform() === true", "native Capacitor bridge")
            assertEquals(true, app.evaluate("Capacitor.isPluginAvailable('OpenAuriUsb')"))
            assertEquals(true, app.evaluate("Capacitor.isPluginAvailable('OpenAuriFiles')"))
            val info = app.promise("Capacitor.Plugins.OpenAuriUsb.getInfo()") as JSONObject
            assertEquals(1, info.getInt("bridgeApi"))

            // Fetch the actual response header, not a weaker CSP installed by the test.
            val csp = app.promise("""
                fetch(location.href).then(r => [
                  r.headers.get('content-security-policy') || '',
                  ...Array.from(document.querySelectorAll('meta[http-equiv="content-security-policy" i]'), m => m.content)
                ].join(';'))
            """.trimIndent()) as String
            val scripts = csp.split(';').first { it.trim().startsWith("script-src ") }
            assertTrue("Preview must keep production script nonces or prerendered hashes: $csp", scripts.contains("'nonce-") || scripts.contains("'sha256-"))
            assertTrue("Inline bridge injection must not be allowed by the policy", !scripts.contains("'unsafe-inline'"))
            app.assertNoCspViolations()

            // Q1 G4: use MainActivity's normal gate and installed client, without injecting a client.
            val missing = "/__android_instrumentation_missing_page__"
            val status = app.promise("fetch('$missing').then(r => r.status)") as Number
            assertEquals(404, status.toInt())
            app.navigate(missing)
            app.awaitJs("location.pathname === '$missing' && document.body.innerText.includes('404')", "site HTTP 404 content")
            assertEquals(E2E_ORIGIN, app.evaluate("location.origin"))
            assertEquals(null, app.evaluate("document.querySelector('#retry')"))
            app.assertNoCspViolations()
        }
    }
}

internal const val E2E_ORIGIN = "http://10.0.2.2:4173"

/** Shared by the five device specs; all WebView operations run on the activity's main thread. */
internal class WebAppScenario private constructor(val scenario: ActivityScenario<MainActivity>) : AutoCloseable {
    fun evaluate(expression: String, timeoutMs: Long = 10_000): Any? {
        require(timeoutMs > 0)
        val reply = AtomicReference<String>()
        val completed = CountDownLatch(1)
        scenario.onActivity { activity ->
            activity.bridge.webView.evaluateJavascript(expression) { value ->
                reply.set(value)
                completed.countDown()
            }
        }
        assertTrue("JavaScript callback timed out after ${timeoutMs}ms: $expression", completed.await(timeoutMs, TimeUnit.MILLISECONDS))
        val raw = reply.get()
        if (raw == null || raw == "null" || raw == "undefined") return null
        return JSONTokener(raw).nextValue().takeUnless { it == JSONObject.NULL }
    }

    fun awaitJs(expression: String, description: String, timeoutMs: Long = 60_000) {
        require(timeoutMs > 0)
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (true) {
            val remainingMs = deadline - SystemClock.elapsedRealtime()
            if (remainingMs <= 0) break
            try {
                if (evaluate("(() => { try { return Boolean($expression); } catch (_) { return false; } })()", minOf(10_000L, remainingMs)) == true) return
            } catch (error: AssertionError) {
                throw AssertionError("JavaScript polling failed while waiting for $description", error)
            }
            val sleepMs = minOf(100L, deadline - SystemClock.elapsedRealtime())
            if (sleepMs > 0) SystemClock.sleep(sleepMs)
        }
        val diagnostics = runCatching {
            evaluate("JSON.stringify({ page: location.href, body: document.body?.innerText.slice(0, 1500) })", timeoutMs = 1_000)
        }.getOrElse { "Page diagnostics unavailable: ${it.message}" }
        throw AssertionError("Timed out after ${timeoutMs}ms waiting for $description; condition=$expression; $diagnostics")
    }

    fun promise(expression: String): Any? {
        evaluate("""
            (() => {
              window.__oaAsyncResult = { state: 'pending' };
              Promise.resolve().then(() => ($expression)).then(
                value => window.__oaAsyncResult = { state: 'resolved', value },
                error => window.__oaAsyncResult = { state: 'rejected', error: String(error) }
              );
            })()
        """.trimIndent())
        awaitJs("window.__oaAsyncResult?.state !== 'pending' && window.__oaAsyncResult != null", "promise: $expression")
        val result = evaluate("window.__oaAsyncResult") as JSONObject
        assertEquals("JavaScript promise failed: $result", "resolved", result.getString("state"))
        return result.opt("value").takeUnless { it == JSONObject.NULL }
    }

    fun navigate(path: String) {
        val url = E2E_ORIGIN + path
        scenario.onActivity { it.bridge.webView.loadUrl(url) }
        awaitJs("location.href === ${JSONObject.quote(url)} && document.readyState === 'complete'", "navigation to $url")
    }

    fun acceptDisclaimerIfPresent() {
        // Native detection and this lazy island finish after document.readyState.
        awaitJs("document.querySelector('dialog [data-ack]') != null || document.querySelector('aside.banner a[href=\"/docs#android-resgate\"]') != null", "Android untested-cable notice")
        evaluate("document.querySelector('dialog[open] [data-ack]')?.click()")
        awaitJs("document.querySelector('dialog[open] [data-ack]') == null", "disclaimer dismissal")
    }

    fun assertNoCspViolations() {
        assertEquals(true, evaluate("window.__oaDocumentStart === true"))
        assertEquals("CSP violations: ${evaluate("JSON.stringify(window.__oaCspViolations)")}", 0, (evaluate("window.__oaCspViolations.length") as Number).toInt())
    }

    override fun close() = scenario.close()

    companion object {
        fun launch(path: String = "/"): WebAppScenario {
            val app = WebAppScenario(ActivityScenario.launch(MainActivity::class.java))
            try {
                app.scenario.onActivity { activity ->
                    assertNotNull("The real WebView compatibility gate must pass", activity.bridge)
                    assertEquals("Build with --target e2e, never the production origin", E2E_ORIGIN, activity.bridge.serverUrl)
                    assertTrue(WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT))
                    // The first load can start during onCreate. Observe a fresh full navigation so
                    // the listener is present before any page script or bridge boot in that document.
                    WebViewCompat.addDocumentStartJavaScript(activity.bridge.webView, """
                        window.__oaDocumentStart = true;
                        window.__oaCspViolations = [];
                        document.addEventListener('securitypolicyviolation', event => {
                          window.__oaCspViolations.push({
                            directive: event.effectiveDirective,
                            blockedURI: event.blockedURI,
                            source: event.sourceFile
                          });
                        });
                    """.trimIndent(), setOf(E2E_ORIGIN))
                    activity.bridge.webView.stopLoading()
                }
                app.navigate("$path${if ('?' in path) '&' else '?'}android-instrumentation=1")
                app.awaitJs("window.__oaDocumentStart === true && window.Capacitor?.isNativePlatform() === true && document.querySelector('main') != null", "observed real app boot")
                return app
            } catch (error: Throwable) {
                app.close()
                throw error
            }
        }
    }
}
