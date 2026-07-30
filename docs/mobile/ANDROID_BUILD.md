# Android Build Guide

## Prerequisites (not available in the Replit build environment)

- JDK 17+
- Android Studio (or command-line Android SDK, `ANDROID_HOME` set)
- Android SDK Platform for the current Play-required target (verify at
  https://developer.android.com/google/play/requirements/target-sdk at build time)

> **Honest status:** the Replit environment used to prepare this project has no
> Java/Android SDK, so no APK/AAB has been produced here. The Gradle project is
> generated and configured; the steps below are the standard Capacitor build
> path and must be run on a machine with the Android toolchain.

## Steps

```bash
npm install
npx cap sync android          # copies web assets + plugin config
cd android
./gradlew assembleDebug       # debug APK: app/build/outputs/apk/debug/
./gradlew bundleRelease       # release AAB: app/build/outputs/bundle/release/
```

Or open `android/` in Android Studio and use Build > Generate Signed Bundle.

## Staging vs production

Default `capacitor.config.json` points at staging with appId
`ke.hapa.embu.staging`. For production:

```bash
cp capacitor.config.production.json capacitor.config.json
npx cap sync android
```

Then update `android/app/build.gradle` `applicationId` to the confirmed
production package name (Owner decision) before the first Play upload —
package names are permanent once uploaded.

## Release configuration checklist

- [ ] `applicationId` confirmed by Owner
- [ ] `versionCode` incremented (integer, monotonic), `versionName` set (e.g. 1.7.0)
- [ ] `targetSdkVersion` meets current Google Play policy
- [ ] `minifyEnabled true` + default ProGuard rules for release (R8)
- [ ] `debuggable false` in release build type (Gradle default)
- [ ] Signing: create an **upload key** (`keytool -genkeypair`), keep it out of
      git (never commit keystores), back it up offline, enroll in
      **Play App Signing** so Google holds the app signing key
- [ ] No development URLs — release must use the production config

## Permissions declared

`INTERNET`, `ACCESS_COARSE/FINE_LOCATION` (foreground only), `CAMERA`,
`READ_MEDIA_IMAGES`, `POST_NOTIFICATIONS`. **No** background location.
