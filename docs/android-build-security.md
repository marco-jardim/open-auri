# Android build verification

Run Android builds and tests from the repository root using the npm scripts. The
Gradle wrapper runner accepts task names and a small allow-list of diagnostic,
worker and cache options. It rejects task exclusions, init/settings scripts,
project relocation, arbitrary system/project properties, verification overrides
and dry runs. `--offline` is permitted: it restricts dependency resolution and
does not skip verification or release guards.

## Robolectric SDK dependency

Robolectric runs offline with SDK jars copied by `:app:prepareRobolectricSdk` from
the dedicated `robolectricSdk` Gradle configuration. Robolectric 4.17's
`DefaultSdkProvider` selects
`org.robolectric:android-all-instrumented:16-robolectric-13921718-i7` for SDK 36.
Gradle verifies this dependency before it reaches the test process. A missing or
unverified artifact fails the build instead of falling back to Robolectric's
runtime Maven downloader.

When updating that dependency, a maintainer can regenerate SHA-256 metadata with:

```text
node tools/run-gradle.mjs --maintainer-metadata --write-verification-metadata sha256 :app:testDebugUnitTest :app:koverVerifyDebug
```

Review the new checksums in
`apps/android/android/gradle/verification-metadata.xml` against a trusted artifact
source before accepting them. The runner-only `--maintainer-metadata` opt-in is
not forwarded to Gradle and does not permit any other unsafe Gradle options.
After reviewing metadata, rerun `npm run test:android` without the opt-in.

## Release assets

`:app:verifyCapacitorConfig` depends on `mergeReleaseAssets` and checks
`app/build/intermediates/assets/release/mergeReleaseAssets/capacitor.config.json`,
not the source copy. APK and bundle packaging depend on this guard. A release
source-set overlay cannot replace a valid production source config with a
staging or cleartext config unnoticed.

## Android artwork

`npm run icons:android` regenerates legacy launchers with a rounded-square mask
and an 8% transparent margin, adaptive layers and a density-independent branded
splash background. It removes the obsolete Capacitor template splash bitmaps,
while retaining the `@drawable/splash` resource name used by the launch theme.
