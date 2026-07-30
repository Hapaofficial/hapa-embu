# HAPA Mobile Architecture

## Overview

HAPA ships as one Node/Express + PostgreSQL backend with a single-page vanilla-JS
frontend (`public/index.html`) that serves four surfaces:

1. **Website** — served directly by Express.
2. **PWA** — same site with `manifest.webmanifest`, `sw.js` (app-shell caching
   only, never `/api/`), and `offline.html`.
3. **Android app** — Capacitor 7 native shell (`android/`).
4. **iOS app** — Capacitor 7 native shell (`ios/`).

## Capacitor strategy: remote-server shell

Both native apps use Capacitor's `server.url` mode: the native WebView loads
the deployed HAPA site (staging or production) over HTTPS, while native
plugins (geolocation, camera, secure storage, push, status bar, splash) are
bridged into the page. This keeps a single frontend codebase, guarantees the
apps always run the same audited code as the website, and lets fixes ship
without store re-review (Apple/Google both permit this for HTML/JS content
served to a WebView-based app).

Trade-off: the apps need connectivity for first load (the service worker
provides an offline fallback page). No API base URL is hardcoded in the
frontend — all calls are relative to the origin.

## Configurations

| File | appId | Loads |
|---|---|---|
| `capacitor.config.json` (default/staging) | `ke.hapa.embu.staging` | `https://hapa-embu-staging.onrender.com` |
| `capacitor.config.production.json` | `ke.hapa.embu` | `https://hapa-embu.onrender.com` |

To build production, copy `capacitor.config.production.json` over
`capacitor.config.json` and run `npx cap sync`. **The final production
package/bundle identifier must be confirmed by the Owner before store
registration** — both IDs are placeholders that are trivial to change until
first upload.

## Native integrations

- **Secure credentials** — `capacitor-secure-storage-plugin` (Android Keystore /
  iOS Keychain). The frontend mirrors the JWT to secure storage on login and
  restores it at boot on native (`saveToken`/`secureLoadToken` in index.html).
  Cleared on logout, invalid/expired token, deactivation and deletion.
- **Geolocation** — browser `navigator.geolocation` works inside the Capacitor
  WebView and is backed by native permission prompts (`ACCESS_FINE_LOCATION`,
  `NSLocationWhenInUseUsageDescription`). Foreground-only; no background
  location permission is declared.
- **Camera/gallery** — native file inputs in the WebView open the native
  camera/photo picker; permissions are requested only on user action. Server
  strips EXIF/GPS from every upload.
- **Android back button** — `@capacitor/app` listener mirrors in-app back
  affordances and minimizes at the root.
- **Push** — `@capacitor/push-notifications` installed; token lifecycle API is
  live (`/api/me/device-tokens`); delivery requires FCM/APNs credentials (see
  NOTIFICATIONS.md).
- **Status bar / splash** — configured in `capacitor.config.json`.

## Data flow & privacy boundaries

- JWTs travel only in the `Authorization` header — never URLs, deep links or logs.
- Exact trip coordinates are stored on `service_requests` and served only via
  the authorized request endpoints (customer / addressed driver / Owner).
- Public APIs never include coordinates, private documents or signed URLs
  (regression-tested in `tests/launch-readiness.test.js`).
