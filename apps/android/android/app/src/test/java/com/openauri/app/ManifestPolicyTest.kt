package com.openauri.app

import android.app.Application
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.PermissionInfo
import androidx.test.core.app.ApplicationProvider
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.w3c.dom.Element

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ManifestPolicyTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val androidNamespace = "http://schemas.android.com/apk/res/android"

    // AGP's merged output includes dependency permissions and intent filters. Never parse the
    // source manifest as a substitute: that would hide permissions introduced by dependencies.
    private val manifest by lazy {
        val merged = File("build/intermediates/merged_manifest/debug").walkTopDown()
            .filter { it.isFile && it.name == "AndroidManifest.xml" }.toList()
        assertEquals("Expected exactly one AGP merged debug manifest", 1, merged.size)
        parse(merged.single())
    }

    @Test
    fun mergedPermissionsAreExactlyInternetAndAndroidXSignatureSelfPermission() {
        val selfPermission = "${context.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
        val expected = setOf("android.permission.INTERNET", selfPermission)
        assertEquals(expected, manifest.children("uses-permission").map { it.android("name") }.toSet())
        assertTrue(manifest.children("uses-permission-sdk-23").isEmpty())

        val packaged = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
        assertEquals(expected, packaged.requestedPermissions.orEmpty().toSet())
        // AndroidX Core uses this self-only signature permission for RECEIVER_NOT_EXPORTED on
        // API < 33. Keep it, not a dangerous/runtime permission and not access to device data.
        val declaration = manifest.children("permission").single()
        assertEquals(selfPermission, declaration.android("name"))
        assertEquals("signature", declaration.android("protectionLevel"))
        val permission = context.packageManager.getPermissionInfo(selfPermission, 0)
        assertEquals(PermissionInfo.PROTECTION_SIGNATURE, permission.protectionLevel)
    }

    @Test
    fun backupIsOffAndCleartextIsOffWithExplicitPolicyResources() {
        val application = manifest.children("application").single()
        assertEquals("false", application.android("allowBackup"))
        assertEquals("false", application.android("usesCleartextTraffic"))
        assertEquals("@xml/network_security_config", application.android("networkSecurityConfig"))
        assertEquals("@xml/backup_rules", application.android("fullBackupContent"))
        assertEquals("@xml/data_extraction_rules", application.android("dataExtractionRules"))
        val flags = context.applicationInfo.flags
        assertEquals(0, flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
        assertEquals(0, flags and ApplicationInfo.FLAG_USES_CLEARTEXT_TRAFFIC)
    }

    @Test
    fun usbHostIsOptionalAndLauncherAndFileProviderArePreserved() {
        val usb = manifest.children("uses-feature").single { it.android("name") == "android.hardware.usb.host" }
        assertEquals("false", usb.android("required"))
        val activity = mainActivity()
        assertEquals("singleTask", activity.android("launchMode"))
        assertEquals("true", activity.android("exported"))
        assertTrue(activity.children("intent-filter").any { filter ->
            filter.children("action").any { it.android("name") == "android.intent.action.MAIN" } &&
                filter.children("category").any { it.android("name") == "android.intent.category.LAUNCHER" }
        })
        val provider = manifest.children("application").single().children("provider")
            .single { it.android("name") == "androidx.core.content.FileProvider" }
        assertEquals("${context.packageName}.fileprovider", provider.android("authorities"))
        assertEquals("false", provider.android("exported"))
        assertEquals("true", provider.android("grantUriPermissions"))
        assertTrue(provider.children("meta-data").any { it.android("resource") == "@xml/file_paths" })
    }

    @Test
    fun verifiedHttpsAppLinkCoversAllPaths() {
        val filter = mainActivity().children("intent-filter").single { it.android("autoVerify") == "true" }
        assertEquals(setOf("android.intent.action.VIEW"), filter.children("action").map { it.android("name") }.toSet())
        assertEquals(
            setOf("android.intent.category.DEFAULT", "android.intent.category.BROWSABLE"),
            filter.children("category").map { it.android("name") }.toSet(),
        )
        val data = filter.children("data").single()
        assertEquals("https", data.android("scheme"))
        assertEquals("open-auri.com", data.android("host"))
        for (attribute in listOf("path", "pathPrefix", "pathPattern", "pathAdvancedPattern", "query", "fragment")) {
            assertFalse(data.hasAttributeNS(androidNamespace, attribute))
        }
    }

    @Test
    fun allBackupAndTransferDomainsAreExcluded() {
        val domains = setOf(
            "root", "file", "database", "sharedpref", "external",
            "device_root", "device_file", "device_database", "device_sharedpref",
        )
        val backup = parse(File("src/main/res/xml/backup_rules.xml"))
        val extraction = parse(File("src/main/res/xml/data_extraction_rules.xml"))
        val sections = listOf(backup) + extraction.children("cloud-backup") + extraction.children("device-transfer")
        assertEquals(3, sections.size)
        for (section in sections) {
            assertTrue(section.children("include").isEmpty())
            assertEquals(domains, section.children("exclude").map { it.getAttribute("domain") }.toSet())
            assertTrue(section.children("exclude").all { it.getAttribute("path") == "." })
        }
    }

    @Test
    fun cleartextIsAllowedOnlyForDebugEmulatorHostAndOnlySystemCertificatesAreTrusted() {
        for (variant in listOf("main", "debug")) {
            val config = parse(File("src/$variant/res/xml/network_security_config.xml"))
            val base = config.children("base-config").single()
            assertEquals("false", base.getAttribute("cleartextTrafficPermitted"))
            val certificates = base.children("trust-anchors").single().children("certificates").single()
            assertEquals("system", certificates.getAttribute("src"))
            assertTrue(config.children("debug-overrides").isEmpty())
            val domains = config.children("domain-config")
            if (variant == "main") {
                assertTrue(domains.isEmpty())
            } else {
                val domainConfig = domains.single()
                assertEquals("true", domainConfig.getAttribute("cleartextTrafficPermitted"))
                assertTrue(domainConfig.children("trust-anchors").isEmpty())
                assertTrue(domainConfig.children("domain-config").isEmpty())
                val domain = domainConfig.children("domain").single()
                assertEquals("10.0.2.2", domain.textContent)
                assertEquals("false", domain.getAttribute("includeSubdomains"))
            }
        }
    }

    private fun mainActivity() = manifest.children("application").single().children("activity")
        .single { it.android("name") == "${context.packageName}.MainActivity" }

    private fun parse(file: File): Element = DocumentBuilderFactory.newInstance().apply {
        isNamespaceAware = true
        setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
    }.newDocumentBuilder().parse(file).documentElement

    private fun Element.android(name: String): String = getAttributeNS(androidNamespace, name)

    private fun Element.children(tag: String): List<Element> = (0 until childNodes.length)
        .mapNotNull { childNodes.item(it) as? Element }.filter { it.tagName == tag }
}
