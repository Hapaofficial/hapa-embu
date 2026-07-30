# Deep Links (Android App Links / iOS Universal Links)

## Link surface

Shareable, safe-to-expose paths (no JWTs, no signed URLs, no private document
IDs, no trip coordinates):

- `/p/<id>` — Professional public profile
- `/m/<id>` — Merchant public profile
- `/d/<id>` — Driver public profile
- `/l/<id>` — Merchant listing
- `/?listing=<id>` — existing listing link format (already handled by the SPA)

Request links (`/requests/<id>` style) must remain behind authentication — the
app opens them only after login and the API enforces ownership.

## Association endpoints (implemented, env-gated)

The server serves both association files **only when real values are
configured** — nothing is invented:

- `GET /.well-known/assetlinks.json` — requires `ANDROID_PACKAGE_NAME` and
  `ANDROID_CERT_SHA256` (SHA-256 fingerprint of the release signing cert;
  after Play App Signing enrollment use the fingerprint from Play Console →
  App integrity).
- `GET /.well-known/apple-app-site-association` — requires `IOS_APP_ID`
  (`TEAMID.bundle.id`); serves paths `/p/*`, `/m/*`, `/d/*`, `/l/*`.

Until those env vars are set on the production website, both endpoints return
404 and OS-level link handling simply stays inactive.

## Native project steps (when identifiers are final)

- **Android**: add an `intent-filter` with `android:autoVerify="true"` for the
  production domain in `AndroidManifest.xml`.
- **iOS**: add the Associated Domains capability
  (`applinks:<production-domain>`) in Xcode.

Do this only after the Owner confirms the production domain and identifiers.
