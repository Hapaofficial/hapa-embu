# Mobile Security

## Credential storage

- Native: JWT mirrored to `capacitor-secure-storage-plugin` — Android Keystore
  / iOS Keychain backed. Restored at boot; localStorage acts only as an
  in-session cache inside the WebView.
- Cleared on: logout, 401 (invalid/expired token), account deactivation,
  account deletion. Server-side `token_version` invalidates all sessions on
  password change/deactivation/deletion regardless of client state.
- JWTs never appear in URLs, query parameters, deep links, HTML attributes,
  logs or analytics (regression-tested).

## Transport & content

- HTTPS only (`server.cleartext: false`, `allowMixedContent: false`).
- CSP allows scripts only from self + maps.googleapis.com.
- Authenticated media is fetched with the Authorization header and rendered
  via blob URLs that are revoked on navigation/logout.

## Location privacy

- Foreground-only geolocation, requested only on user action.
- Exact trip coordinates: visible only to the requesting customer, addressed
  driver and Owner support. Never in public APIs, logs or deep links.
- No continuous tracking, no location history beyond the request record.

## Uploads

- MIME + magic-byte validation, size limits, malformed-image rejection,
  SVG/polyglot rejection, EXIF/GPS stripping via sharp re-encoding.
- Public media and private verification documents live in separate buckets
  with a startup guard refusing cross-configuration.

## What is intentionally NOT implemented

- No background location, automatic dispatch, or live driver tracking.
- No payment processing (no M-Pesa/card simulation).
- Notification payloads will exclude exact locations and message bodies by
  default (see NOTIFICATIONS.md).
