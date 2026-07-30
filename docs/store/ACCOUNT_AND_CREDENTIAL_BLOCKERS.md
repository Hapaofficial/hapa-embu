# External Owner Accounts & Credentials Required

Everything in this file is outside the codebase and can only be provided by
the Owner. Each item lists exactly what unblocks.

| # | Item | Unblocks | Notes |
|---|---|---|---|
| 1 | Google Cloud project + billing, `GOOGLE_MAPS_BROWSER_KEY` per environment | Live map pickup/destination UI (code is complete; manual entry works today) | Referrer-restrict each key |
| 2 | Firebase project (FCM) + APNs key | Push notification delivery (token lifecycle already live) | google-services.json / GoogleService-Info.plist never committed |
| 3 | Transactional email provider (e.g. env-configured SMTP/API) | Password recovery emails (UI currently shows a truthful unavailable message) | |
| 4 | Apple Developer Program account | TestFlight, App Store submission, Universal Links | Requires Mac + Xcode for archive |
| 5 | Google Play Console account | Play internal testing, submission, App Links | Upload keystore created by Owner, backed up offline |
| 6 | Final package name / bundle ID confirmation | Store registration (placeholders: `ke.hapa.embu[.staging]`) | Permanent once uploaded |
| 7 | Signing credentials (Android upload key; Apple certs/profiles) | Release builds | Never committed to git |
| 8 | Legal/company information: legal entity name, official address, support email, privacy contact, registration details | Final Terms/Privacy pages, store listing fields | Currently env-driven via SUPPORT_/LEGAL_ vars; nothing invented |
| 9 | Kenyan lawyer review (Data Protection Act 2019, consumer law, ODPC registration if required) | Legal sign-off before launch | Checklist in DEPLOYMENT_GUIDE.md |
| 10 | Staging Owner password (`OWNER_PASSWORD` on the staging service) | Destructive staging E2E acceptance run | Only via environment configuration; never printed |
| 11 | Mac with Xcode | iOS archive/build verification | Android needs any machine with JDK + Android SDK |
