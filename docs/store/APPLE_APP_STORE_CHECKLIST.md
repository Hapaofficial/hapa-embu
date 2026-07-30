# Apple App Store Submission Checklist

Verify all requirements against current Apple documentation at submission time
(https://developer.apple.com/app-store/review/guidelines/). No submission is
made from this repo; these are the Owner's manual steps.

## Accounts & identity (Owner)

- [ ] Apple Developer Program membership (organization or individual)
- [ ] Confirm final bundle identifier (current placeholder: `ke.hapa.embu`)
- [ ] Create the App ID and app record in App Store Connect

## Build

- [ ] Mac with current Xcode; `pod install`; production capacitor config synced
- [ ] Signing via the Owner's team (never commit certificates/profiles)
- [ ] Archive → upload to TestFlight → test on real devices

## Review-critical items already implemented in the app

- [x] In-app account deletion (Account → Delete account permanently) — required
      for apps with account creation
- [x] Externally accessible deletion page (`/delete-account`)
- [x] User-generated content controls: reporting (users, profiles, listings,
      reviews, media, problems), blocking via Owner moderation, moderation queue
- [x] Permission usage descriptions (location when-in-use, camera, photos)
- [x] PrivacyInfo.xcprivacy privacy manifest
- [x] No background location, no tracking, no private APIs

## App Store Connect metadata

- [ ] Fill fields from docs/store/STORE_METADATA.md
- [ ] Support URL and Privacy Policy URL (must be live production pages)
- [ ] App Privacy questionnaire — use docs/store/PRIVACY_DATA_WORKSHEET.md
- [ ] Age rating questionnaire (expected 4+/12+ depending on UGC answers)
- [ ] Export compliance: standard HTTPS only → "exempt" encryption answer
- [ ] Reviewer notes + demo account (create a dedicated demo customer account
      on production; never reuse the Owner account)
- [ ] Screenshots per current required device sizes

## Before "Submit for Review"

- [ ] Production website live and stable (apps load it remotely)
- [ ] Legal pages reviewed by Kenyan counsel (see legal checklist)
- [ ] Push disabled unless APNs is genuinely configured and tested
