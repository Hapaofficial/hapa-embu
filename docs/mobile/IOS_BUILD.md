# iOS Build Guide

## Prerequisites (require a Mac — not available in this environment)

- macOS with current Xcode
- CocoaPods (`sudo gem install cocoapods`)
- Apple Developer Program membership (Owner account)

> **Honest status:** the project (`ios/App`) is complete — Info.plist usage
> descriptions, PrivacyInfo.xcprivacy, Capacitor plugins — but no archive/build
> has been run because Xcode is macOS-only. The first `pod install`, simulator
> run and archive must be done on a Mac.

## Steps

```bash
npm install
npx cap sync ios
cd ios/App && pod install
npx cap open ios          # opens Xcode
```

In Xcode:
1. Select the App target → Signing & Capabilities → choose the Owner's team.
2. Set the bundle identifier (staging: `ke.hapa.embu.staging`; production ID is
   an Owner decision — **do not** register the final ID without confirmation).
3. Set Marketing Version / Build number.
4. Product → Archive → Distribute (TestFlight first).

## Staging vs production

Use two schemes or simply swap `capacitor.config.json` (staging default) with
`capacitor.config.production.json`, then `npx cap sync ios`.

## Privacy configuration already in place

- `NSLocationWhenInUseUsageDescription` — foreground pickup selection only
- `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`,
  `NSPhotoLibraryAddUsageDescription`
- `PrivacyInfo.xcprivacy` — declares collected data types (name, phone, email,
  precise location, photos; all app-functionality, no tracking) and accessed
  API reasons (UserDefaults CA92.1, file timestamps C617.1)
- No background modes, no always-location, no private APIs

## Push capability

When enabling notifications: add the Push Notifications capability in Xcode
and configure APNs (see NOTIFICATIONS.md). Do not enable before credentials
exist.
