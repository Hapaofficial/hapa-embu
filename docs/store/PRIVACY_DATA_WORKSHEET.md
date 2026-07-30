# Privacy / Data Safety Worksheet

Single source of truth for the Google Play **Data safety** form and the Apple
**App Privacy** questionnaire. Answers reflect what the code actually does.

## Data collected and linked to the user

| Data | Purpose | Shared with third parties? | Optional? |
|---|---|---|---|
| Name | Account, public provider profiles | No | Required |
| Email | Account/login | No | Email or phone required |
| Phone (+254) | Account, shown on provider profiles **only if the provider enables visibility** | No | Email or phone required |
| Location (precise) | Transport pickup/destination only, foreground, user-initiated | No (visible only to the contacted driver + support) | Optional |
| Photos | Profile/shop/portfolio images; verification documents | No | Optional (required for provider verification) |
| ID documents (verification) | Provider identity verification, private bucket, never public | No | Only for provider applicants |
| User content (requests, messages, reviews, reports) | Core marketplace function | No | — |
| Device push token | Notifications (when enabled) | Sent to FCM/APNs for delivery only | Optional |

## Not collected

No contacts, no financial/payment data, no health data, no browsing history,
no advertising identifiers, no background location, no tracking across apps.

## Handling

- Encryption in transit: yes (HTTPS only).
- At rest: managed PostgreSQL + R2 object storage; private documents encrypted
  with `DOCUMENT_ENCRYPTION_KEY`; EXIF/GPS stripped from all images.
- Deletion: full in-app account deletion + `/delete-account` page. Anonymized
  tombstone retains only safety/legal audit records.
- Data sold: **no**. Ads: **none**. Tracking (ATT): **none**.

## Apple data-type mapping

Name, Email Address, Phone Number, Precise Location, Photos or Videos,
User Content — all "Linked to user", purpose "App Functionality", no tracking.
(Matches `ios/App/App/PrivacyInfo.xcprivacy`.)
