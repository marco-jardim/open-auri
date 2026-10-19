package com.openauri.app

import android.content.pm.PackageInfo
import androidx.webkit.WebViewFeature

/** Pure decision with injectable platform queries; unknown or malformed versions fail closed. */
class WebViewCompatGate(
    private val featureCheck: (String) -> Boolean,
    private val currentWebViewPackage: () -> PackageInfo?,
    private val minVersion: Int = MIN_WEBVIEW_VERSION,
) {
    sealed interface Result {
        data object Ok : Result
        data class Outdated(val packageName: String, val versionName: String) : Result
        data object MissingFeature : Result
        data object UnknownPackage : Result
    }

    fun check(): Result {
        val info = currentWebViewPackage() ?: return Result.UnknownPackage
        val packageName: String? = info.packageName
        if (packageName.isNullOrBlank()) return Result.UnknownPackage
        val versionName = info.versionName ?: return Result.UnknownPackage
        val majorComponent = versionName.substringBefore('.')
        val major = majorComponent.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }
            ?.toIntOrNull() ?: return Result.UnknownPackage
        if (major < minVersion) return Result.Outdated(packageName, versionName)
        if (!featureCheck(WebViewFeature.DOCUMENT_START_SCRIPT)) return Result.MissingFeature
        // Capacitor otherwise falls back to addJavascriptInterface, exposing the bridge to all frames.
        if (!featureCheck(WebViewFeature.WEB_MESSAGE_LISTENER)) return Result.MissingFeature
        return Result.Ok
    }

    companion object {
        // Keep aligned with apps/android/capacitor.targets.mjs (Vite's Chromium baseline).
        const val MIN_WEBVIEW_VERSION = 111
        const val DEFAULT_WEBVIEW_PACKAGE = "com.google.android.webview"
    }
}
