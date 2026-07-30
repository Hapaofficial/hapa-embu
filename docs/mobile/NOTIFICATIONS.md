# Push Notification Architecture

## Status: architecture + token lifecycle implemented; delivery NOT enabled

No FCM or APNs credentials exist, so **no notification is claimed to work**.
Everything below the "Delivery" section is live code; delivery is documented
design awaiting credentials.

## Implemented now

- `device_tokens` table (user, platform android/ios/web, unique token,
  created/last-seen).
- `POST /api/me/device-tokens` — authenticated registration; re-registering an
  existing token reassigns it to the current user (token replacement).
- `DELETE /api/me/device-tokens` — deletes one token (body `{token}`) or all of
  the user's tokens (logout cleanup; the web client calls this on logout).
- Account deletion removes all of the user's device tokens.
- `PATCH /api/me/notification-prefs` — allow-listed boolean preferences
  (`requests`, `moderation`, `support`) stored in `users.notify_prefs`.
- `@capacitor/push-notifications` plugin installed in both native projects;
  `POST_NOTIFICATIONS` permission declared on Android.

## Planned notification events

application approved/rejected · new request · request accepted/declined/
cancelled/completed · moderation update · support update — each gated on the
matching preference.

## Privacy rules for payloads

- Never include exact pickup/destination coordinates or addresses.
- Never include message bodies — only "New message on your request".
- Deep-link by request ID only; the app authorizes on open.

## Delivery setup (Owner steps, when ready)

1. Create a Firebase project; add the Android app (package name) and download
   `google-services.json` into `android/app/` (never commit it).
2. For iOS: create an APNs key in the Apple Developer portal, upload it to
   Firebase (FCM can deliver to APNs), add `GoogleService-Info.plist` to the
   Xcode project (never commit it), enable the Push capability.
3. Backend: add a sender using the FCM HTTP v1 API with a service-account
   credential provided via env (e.g. `FCM_SERVICE_ACCOUNT_JSON`), reading
   `device_tokens` and pruning tokens FCM reports as invalid.
4. Test end-to-end on real devices before claiming notifications work.
