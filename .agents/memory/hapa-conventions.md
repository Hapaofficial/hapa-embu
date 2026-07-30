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
- **Verifying a staging deploy:** `/api/health` version is unreliable (old builds can report the same version). Probe an endpoint or frontend string that exists only in the new commit; unknown `/api` paths on old builds return the SPA HTML with 200.
- Background processes do not survive between ShellExec calls (even with nohup) — start the port-5100 test server and run all test suites in one command.
- Test-suite hygiene: tests must randomize phone/email fixtures; deactivated leftover users still hold phone/email uniqueness, so fixed values collide after a crashed run.
- **Public listing/profile queries must gate on seller `users.status='active'`**, not just the listing's own status — otherwise deleted/deactivated users' content stays publicly visible. **How to apply:** any new public or cross-user query joining a user must include the status filter; add a delete→invisible regression test.
- Render staging auto-deploy can lag far beyond an hour or silently not trigger; after pushing, don't burn time polling — verify with a commit-unique probe (sw.js cache name, `/api/health` version bumped in that commit) and, if stale, report it as an Owner-dashboard item instead of assuming a code problem.
- Reused fixture accounts accumulate state (portfolio image caps, etc.); test suites must self-clean or randomize before asserting create/upload success.
- Frontend↔API contract: media delete endpoints are module-specific (merchant logo/gallery/item-image, driver profile-photo); there is no generic authenticated provider-media DELETE. Grep the route files before wiring new SPA calls — this exact mismatch shipped once and was caught in review.
