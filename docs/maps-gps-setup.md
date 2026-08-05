# Google Maps, GPS & Live Tracking — Setup and Operations

This is the operational guide for the maps/GPS stage. All provider logic lives
in `lib/maps.js`; nothing else in the codebase talks to Google directly.

## Provider model

| `MAPS_PROVIDER` | Behaviour |
|---|---|
| unset (auto) | `google` when `GOOGLE_MAPS_SERVER_KEY` is set, otherwise `mock` |
| `google` | Real Places API (New) + Routes API. Provider failures surface as errors — fares are **never** silently estimated. |
| `mock` | Deterministic development estimates, always labelled **“Development route estimate — Google Maps not configured”** in API responses and UI. |

## Key matrix (one key per platform per environment — never shared, never committed)

| Purpose | Env/location | APIs | Restriction |
|---|---|---|---|
| Web (staging) | Render env `GOOGLE_MAPS_WEB_KEY` (value: the staging web key) | Maps JavaScript API | HTTP referrer: `https://hapa-embu-staging.onrender.com/*` |
| Web (production) | Render env `GOOGLE_MAPS_WEB_KEY` on the prod service | Maps JavaScript API | HTTP referrer: production domain only |
| Server (staging) | Render env `GOOGLE_MAPS_SERVER_KEY` | Places API (New), Routes API, Geocoding API | API restriction to exactly those 3 APIs; IP restriction if Render egress IPs are pinned |
| Server (production) | Render env `GOOGLE_MAPS_SERVER_KEY` on the prod service | same | same, production project |
| Android | `android/local.properties` → `MAPS_API_KEY=` (untracked) | Maps SDK for Android | Android app restriction: package name + signing SHA-1 (separate staging/production entries) |
| iOS | Injected in Xcode build settings / untracked config, passed to `GMSServices.provideAPIKey` if the native SDK is ever adopted | Maps SDK for iOS | iOS bundle-id restriction |

Legacy alias: `GOOGLE_MAPS_BROWSER_KEY` is still read as a fallback for the web
key; prefer `GOOGLE_MAPS_WEB_KEY` going forward.

The browser (web) key is public **by design** — its only protection is the
referrer restriction, so restrict it before deploying. The server key must
never appear in any response, log, or client bundle; Owner panels show
booleans only.

## Server endpoints

- `POST /api/maps/autocomplete` — authed, ≥3 chars, per-user pace cap
  (`MAPS_AUTOCOMPLETE_MAX_PER_10S`, default 25/10s), Kenya-restricted,
  session-token pass-through for Google’s per-session billing.
- `POST /api/maps/place-details` — resolves a selected suggestion (consumes the
  session token).
- `POST /api/maps/reverse-geocode` — coordinates → readable address.
- `GET /api/maps/config` — provider + web key + map centre for the frontend.
- `GET /api/owner/maps/status` — provider, key booleans, per-capability health,
  dispatch degraded state, route-snapshot counts.
- `GET /api/owner/location/health` — ingest accept/reject counters, presence
  freshness, ride-sample volumes.

## Route snapshots & fare integrity

Every quote stores an immutable `route_snapshots` row (provider, coords, place
IDs, distance/duration, polyline, zone, correlation ID, expiry) with a keyed
HMAC integrity hash. Ride creation re-verifies the hash and rejects rides whose
pickup/destination moved >150 m from the quoted route (`409`). Client-supplied
distances are honoured only with `MAPS_ALLOW_CLIENT_DISTANCE=true` outside
production and outside google mode (test fixtures only).

## Dispatch ETAs

Candidates are pre-filtered by haversine (cheap, no API cost), then the top
`MAPS_MATRIX_MAX_CANDIDATES` (default 5) are re-ranked by Compute Route Matrix
pickup ETA with a 30 s position-rounded cache. Matrix failure **never** blocks
dispatch — ranking falls back to haversine and the degraded state is shown on
the Owner panel and recorded on the offer as `eta_source`.

## Live driver location

- Accepted only while online or on an active ride; sequence numbers are
  monotonic (SQL-guarded) so replays are rejected.
- Plausibility gates: accuracy ≤ `LOC_MAX_ACCURACY_M` (default 250 m), speed ≤
  70 m/s, heading 0–360, client timestamp within 120 s, per-driver pace ≥
  `LOC_MIN_INTERVAL_MS` (default 350 ms) between samples.
- Adaptive client intervals from server config: `location_interval_active_s`
  (default 5 s) on a ride, `location_interval_idle_s` (default 30 s) idle.
- Bounded offline buffer (20 samples) flushed in order on reconnect.
- Precise ride samples auto-prune after `location_retention_days` (default 30).
- The service worker never caches `/api/` responses — location data is never
  written to browser caches.

## Privacy & data minimisation

- Riders see driver position only during their own active ride, with staleness
  labels (Live / Updated Xs ago / stale).
- Driver navigation deep links contain coordinates only — no names, phones,
  notes or ride identifiers.
- Owner exact-location access stays audited (`POST /api/owner/rides/:id/locations`
  requires a reason).
- Public endpoints are regression-tested to contain no coordinates.

## Cost controls

- Autocomplete: min 3 chars + 300 ms debounce client-side; server pace caps.
- Places session tokens for session-based billing.
- Matrix: candidate cap + 30 s cache; single Compute Routes call per quote.
- Field masks on every Google call (only billed fields requested).
- Set a Google Cloud budget alert on the project; quotas per API are
  recommended (start: 10k/day autocomplete, 5k/day routes for the pilot).

## Testing

`tests/maps-gps.test.js` runs fully offline in mock mode (deterministic
provider, `MAPS_FAULT_INJECT` for failure paths — dev/test only, ignored in
production). No suite ever calls Google.
