# Google Play Submission Checklist

Verify all requirements against current Google Play policy at submission time
(https://play.google.com/console/about/ and the target-SDK policy page).
No submission is made from this repo; these are the Owner's manual steps.

## Accounts & identity (Owner)

- [ ] Google Play Console developer account (one-time fee, identity verification)
- [ ] Confirm final package name (current placeholder: `ke.hapa.embu`) —
      permanent after first upload
- [ ] Create the app in Play Console (app access: all functionality behind
      login → provide demo credentials)

## Build & signing

- [ ] Machine with JDK + Android SDK; `npx cap sync android`; production config
- [ ] Create an upload keystore; back it up offline; NEVER commit it
- [ ] Enroll in Play App Signing
- [ ] `./gradlew bundleRelease` → upload AAB to Internal testing first
- [ ] targetSdk meets current policy; versionCode strategy documented in
      docs/mobile/ANDROID_BUILD.md

## Policy items already implemented in the app

- [x] Account deletion in-app + external URL (`/delete-account`) — required by
      the account-deletion policy
- [x] UGC moderation: reporting, Owner moderation queue, hide/restore, audit
- [x] Foreground-only location with in-context rationale (booking flow)
- [x] No background location (avoids the sensitive-permission review track)
- [x] Photo/camera permissions requested only on user action

## Play Console declarations

- [ ] Data safety form — use docs/store/PRIVACY_DATA_WORKSHEET.md
- [ ] Content rating questionnaire (IARC)
- [ ] Ads declaration: **no ads**
- [ ] Target audience: 18+ (marketplace with contact exchange)
- [ ] App access instructions + demo account
- [ ] Store listing from docs/store/STORE_METADATA.md
- [ ] Privacy policy URL (live production page)

## Rollout

- [ ] Internal testing → closed testing (Google may require a closed-testing
      period with a minimum tester count for new personal accounts — verify
      current rules) → production with staged rollout
- [ ] Rollback plan: docs/store/RELEASE_AND_ROLLBACK.md
