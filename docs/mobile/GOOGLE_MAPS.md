# Google Maps Integration

> **Superseded:** the ride-hailing maps/GPS stage moved to a full provider
> abstraction with server-authoritative routing. See
> [`docs/maps-gps-setup.md`](../maps-gps-setup.md) for the current key matrix
> (`GOOGLE_MAPS_WEB_KEY` + `GOOGLE_MAPS_SERVER_KEY`; the old
> `GOOGLE_MAPS_BROWSER_KEY` remains a read fallback), endpoints, cost controls
> and native key injection. This file documents the earlier driver-request
> form integration, which still works unchanged.

## What is implemented

The driver/Uber-style booking flow has full Google Maps support in the shared
frontend (used identically by website, PWA, Android and iOS shells):

- **Loader** — Maps JavaScript API + Places library loaded dynamically only on
  the driver request form, only when a key is configured.
- **Pickup** — "Use my current location" (browser/native geolocation with a
  graceful denied-permission fallback), Places autocomplete (Kenya-restricted),
  map tap, draggable marker, reverse geocoding to a readable address, pickup
  note and landmark fields.
- **Destination** — autocomplete, map tap, draggable marker, reverse geocoding.
- **Route** — DirectionsService polyline, estimated distance and duration shown
  to the customer and stored on the request. No automatic fare is calculated
  (no pricing model is configured — prices are agreed with the driver).
- **Driver navigation** — accepted rides show "Navigate to pickup" / "Full
  route" links using the universal `https://www.google.com/maps/dir/?api=1`
  URL scheme, which opens the installed maps app on Android/iOS.
- **Fallback** — without a key (or if the script fails) the form silently keeps
  manual pickup/destination text entry. Nothing is faked.

## Server-side

- Coordinates validated (finite, lat ≤ ±90, lng ≤ ±180, pair-wise complete);
  submission with map points requires both pickup and destination.
- Persisted fields: `pickup_lat/lng`, `destination_lat/lng`,
  `pickup_address`, `destination_address`, `pickup_note`, `landmark`,
  `route_distance_m`, `route_duration_s`.
- Exposed **only** via authorized request endpoints. Public APIs are
  regression-tested to contain no coordinates.

## Configuration (per environment — never commit keys)

| Env var | Where | Notes |
|---|---|---|
| `GOOGLE_MAPS_BROWSER_KEY` | website staging / website production (separate keys) | Maps JavaScript API + Places API + Directions (JS). Restrict by HTTP referrer to the exact domain. Served to the page via `/api/public/config`. |

Because the native apps load the website remotely, the same referrer-restricted
browser key covers Android and iOS WebViews. If the apps are later migrated to
bundled assets, create separate Android-restricted (SHA-1 + package) and
iOS-restricted (bundle ID) keys.

## Setup steps (Owner)

1. Google Cloud Console → create project → enable **Maps JavaScript API** and
   **Places API** → attach billing.
2. Create one API key per environment; apply referrer restrictions
   (`https://hapa-embu-staging.onrender.com/*`, production domain).
3. Set `GOOGLE_MAPS_BROWSER_KEY` in the Render environment for each service.

## Current credential status

**No Google Maps key or billing account is configured.** The integration is
complete and tested with mocked/manual flows; the map UI activates the moment
the env var is set. This is an external Owner blocker, not missing code.
