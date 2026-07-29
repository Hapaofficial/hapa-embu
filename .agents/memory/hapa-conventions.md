---
name: HAPA conventions
description: Durable product/security decisions for the HAPA marketplace (Embu, Kenya)
---
# HAPA conventions

- **Verified application vs public profile are separate entities.** The upgrade application + private documents are locked after approval and Owner-controlled; the public professional profile is freely editable, contains no identity data, and never reads private documents. **Why:** trust model — verification must stay immutable while marketing stays fluid.
- **Public media and private documents must never share storage.** Public media uses its own storage abstraction with PUBLIC_MEDIA_* env vars and a runtime guard refusing any bucket equal to the private-document bucket. **Why:** a config mistake must fail closed, not leak IDs into public URLs.
- **Owner moderation restores a hidden profile to its pre-hide status** (draft/paused/active), never force-publishes. Moderation never touches role, capabilities, or the application.
- Roles: every normal account stays `role='customer'`; capabilities (driver/merchant/professional) are booleans; no HTTP route may assign `role='owner'` (owner reconciled at boot only).
- All uploaded images go through the sharp sanitize pipeline (byte validation, EXIF/GPS strip, JPEG re-encode, sha256); SVG always rejected.
- Local dev quirks: workflow config lives in `.replit` which is missing on branches cut from origin/main — restore it into the working tree (untracked) but keep it out of feature commits. Local DB fixture state can revert between sessions; re-approve the professional fixture via owner API when capability tests fail.
- Git: shell push lacks credentials; use the gitPush CodeExecution callback on the checked-out branch.
