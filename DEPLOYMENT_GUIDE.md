# Deploy HAPA v1.6 on Render

1. Upload the **contents** of this folder to the root of the `hapa-embu` GitHub repository.
2. Keep Render Root Directory empty.
3. Confirm Environment contains the variables listed below.
4. Use **Manual Deploy → Clear build cache & deploy** after replacing an older package.
5. Check `/api/health`; it should report `version: 1.6.0` and `database: postgres`.
6. Log in with the owner email/password.

## Environment variables

### Required
- `DATABASE_URL` — PostgreSQL connection string.
- `JWT_SECRET` — long random string; changing it logs everyone out.
- `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME` — the single owner account.

### Auth / payments / recovery modes
- `AUTH_MODE` — **must NOT be `demo` in production.** Demo mode returns verification codes in API responses and relaxes rate limits.
- `PAYMENT_MODE` — keep `off` (no payment processing is implemented).
- `RECOVERY_MODE` — `demo` for testing; `live` with Resend (email) and/or Twilio (SMS) env vars per README.md.

### Storage
- `PUBLIC_MEDIA_STORAGE_MODE` — `s3` or `local`; with `s3` set `PUBLIC_MEDIA_S3_BUCKET`, `PUBLIC_MEDIA_S3_ENDPOINT`, `PUBLIC_MEDIA_S3_REGION`, `PUBLIC_MEDIA_S3_ACCESS_KEY_ID`, `PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY`, optional `PUBLIC_MEDIA_S3_FORCE_PATH_STYLE`.
- `DOCUMENT_STORAGE_MODE` — `s3` or `local`; with `s3` set `DOCUMENT_S3_BUCKET`, `DOCUMENT_S3_ENDPOINT`, `DOCUMENT_S3_ACCESS_KEY_ID`, `DOCUMENT_S3_SECRET_ACCESS_KEY`, and `DOCUMENT_ENCRYPTION_KEY` (verification documents are encrypted at rest).

### Site info (shown on the Help & Support page; all optional, hidden when unset)
- `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `LEGAL_ENTITY_NAME`, `LEGAL_ADDRESS`.

### Google Maps (optional — map booking UI activates when set)
- `GOOGLE_MAPS_BROWSER_KEY` — referrer-restricted Maps JavaScript API + Places key,
  one per environment. Without it, transport booking uses manual location entry.
  See docs/mobile/GOOGLE_MAPS.md.

### Mobile deep links (optional — association files 404 until set)
- `ANDROID_PACKAGE_NAME`, `ANDROID_CERT_SHA256` — enables `/.well-known/assetlinks.json`.
- `IOS_APP_ID` (`TEAMID.bundle.id`) — enables `/.well-known/apple-app-site-association`.
  See docs/mobile/DEEPLINKS.md.

## v1.6 notes
- Migrations in `sql/schema.sql` are additive and idempotent; they run automatically at boot.
- New modules: merchant shops + products, driver profiles, unified customer↔provider requests with reviews, account settings (profile edit / password change / deactivation), generic reports, owner audit log.
- PWA: `manifest.webmanifest` + `sw.js` (service worker never caches `/api/` responses).
