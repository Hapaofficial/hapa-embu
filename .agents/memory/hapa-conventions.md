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
- Local dev quirks: workflow config lives in `.replit` which is missing on branches cut from origin/main — restore it into the working tree (untracked) but keep it out of feature commits. Local DB fixture state can revert between sessions; re-approve the professional fixture via owner API when capability tests fail. Never put `pkill -f "node server.js"` (or any pattern that appears literally elsewhere in the same shell command) in a test-run command — pkill matches the shell's own command line and kills the session with exit −1 and no output; hide the pattern behind a variable (`S=server; pkill -f "node $S.js"`).
- Stale-cache defense: every authenticated fetch goes through `api()` which sets `cache:'no-store'`; the app shell (`index.html`, catch-all route) and `sw.js` are served `no-cache, must-revalidate`; the shell defines a `HAPA_SHELL` version constant. **Why:** a live "history empty" report was only explainable by stale HTTP-cached shell/API responses (the API was ETag/304-cacheable before the no-store middleware); these three layers make that class unreproducible and diagnosable. **How to apply:** never add authenticated endpoints that opt into caching; keep the version marker bumped with the SW cache name.
- Owner accounting surfaces (ride search/CSV/driver-earnings): all filters must go through the shared parameterized filter builder; default owner ride details never include raw coordinates — exact locations only via the reason-required, audited endpoint. CSV exports need BOM+CRLF+formula-injection neutralization and an audit entry. **Why:** privacy/audit posture confirmed by architect review and enforced by tests/ride-ops-accounting.test.js as a release gate.
- Git: shell push lacks credentials; use the gitPush CodeExecution callback on the checked-out branch.
- **Verifying a staging deploy:** `/api/health` version is unreliable (old builds can report the same version). Probe an endpoint or frontend string that exists only in the new commit; unknown `/api` paths on old builds return the SPA HTML with 200.
- Background processes do not survive between ShellExec calls (even with nohup) — start the port-5100 test server and run all test suites in one command.
- Test-suite hygiene: tests must randomize phone/email fixtures; deactivated leftover users still hold phone/email uniqueness, so fixed values collide after a crashed run.
- **Public listing/profile queries must gate on seller `users.status='active'`**, not just the listing's own status — otherwise deleted/deactivated users' content stays publicly visible. **How to apply:** any new public or cross-user query joining a user must include the status filter; add a delete→invisible regression test.
- Render staging auto-deploy can lag far beyond an hour or silently not trigger; after pushing, don't burn time polling — verify with a commit-unique probe (sw.js cache name, `/api/health` version bumped in that commit) and, if stale, report it as an Owner-dashboard item instead of assuming a code problem.
- Reused fixture accounts accumulate state (portfolio image caps, etc.); test suites must self-clean or randomize before asserting create/upload success.
- **Render installs use pinned pnpm via `bash scripts/render-build.sh`, never npm.** Render's npm crashed pre-startup ("Exit handler never called!") once the Capacitor toolchain entered the dependency graph. Mobile/Capacitor packages must stay in devDependencies (server imports none); prod install is `corepack pnpm install --prod --frozen-lockfile`. Keep pnpm-lock.yaml in sync with package.json (`pnpm install --lockfile-only`). `corepack enable` can fail on read-only node dirs — always invoke as `corepack pnpm`.
- Frontend↔API contract: media delete endpoints are module-specific (merchant logo/gallery/item-image, driver profile-photo); there is no generic authenticated provider-media DELETE. Grep the route files before wiring new SPA calls — this exact mismatch shipped once and was caught in review.

- UI design system (v1.7.1+): light theme is canonical. `--hapa-*` tokens in public/index.html are the source of truth; legacy vars (--bg,--p,--a,--ok,--bad…) are aliases of them — restyle by remapping tokens, never reintroduce hardcoded dark hexes. Orange = primary actions/active nav only, green = success/verified only, red = destructive only. Owner destructive/status actions must use the promise-based hapaConfirm modal (browser confirm/prompt is banned for those flows). Bump sw.js CACHE version whenever index.html ships.

## Kenya-scale geography (v1.8)
- Geo hierarchy lives in `geo_areas` (country>county>sub_county>town>zone), seeded idempotently at boot via `deps.seedGeo` (routes/geo.js): Kenya + 47 counties, only Embu + `zone-embu-pilot` active. Expansion = Owner activates areas by config; never hardcode Embu in DB/copy — messaging is "Launching first in Embu".
- Public exposure rule: an area is public/fare-estimable only if its FULL ancestor chain is active (recursive CTE). Pausing a county hides its zones even if their rows stay active.
- Fare rate cards (`fare_rate_cards`) resolve nearest-ancestor-first (zone before county), newest effective date wins. Rate changes = new card; PATCH only toggles active.
- Enforcement points: provider publish (driver/merchant/professional) and request creation both require `deps.geo.countyActive(profile.county)`; profile PATCH validates county against known Kenya counties via `countyKnown`.
- **Why:** market-scale mandate — Embu is pilot, not scope; wrong-area dispatch and Embu-as-default pricing are launch blockers.

## Ride-hailing core (v1.9)
- routes/rides.js: full realtime module — SSE at /api/rides/stream (header-auth only; token in URL forbidden by launch-readiness test), 1s engine tick (deps.rideEngineTick), sequential dispatch with DB invariants: one pending offer per driver AND per ride (partial unique indexes), one active ride per rider/driver.
- Legal/operational limits live in compliance_settings (audited PATCH /api/owner/compliance/:key), seeded via deps.seedCompliance; NTSA 18% commission cap hard-guarded in the PATCH route. Never hardcode legal limits.
- M-Pesa via lib/mpesa.js (MPESA_MODE mock|sandbox|live). Callbacks are idempotent (ride_payment_events dedupe_key) and amount-validated against the initiated payment; mock mode auto-fires a labelled simulated callback through the same path.
- finalizeRide() is the single closer: ledgers (ON CONFLICT ride_id), receipt (HAPA-… ref), status closed — in one transaction.
- Frontend Rides section: rdState/drvState in index.html; driver location heartbeat 8s; tests drive everything through public APIs (tests/ride-hailing.test.js pattern: makeDriver needs POST /api/me/driver-profile or eligibility fails).
- Gotcha: helpers that respond AND return res (truthy) cause double-send crashes — always `res.status(..).json(..); return null;` in shared transition helpers.
- Rate cards & gates: vehicle categories must go through normCat() (owner-entered "car" ≡ configured "Passenger Car"); effective_from is an Africa/Nairobi calendar date everywhere (storage default, `<= (NOW() AT TIME ZONE 'Africa/Nairobi')::date` comparisons, to_char on output, never `new Date().toLocaleDateString` on a date-only value); active-card duplicates blocked by partial unique index (23505 → 409). Launch gates: production_ready from `required:true` gates only — M-Pesa & phone masking are optional for a cash pilot.

## Fare-card data integrity (2026-07-31)
- Rule: fare inputs must reject blank strings — `Number('')===0` once put a base-0 'car' card live on staging; owners saw only "Base 0" quotes while the math was correct. Explicit 0 remains a legal base fare.
- Rule: `fare_quotes.vehicle_category` must store the canonical requested ride category (e.g. 'Passenger Car'), never the rate card's alias label ('car'): dispatch matches vehicles by that column and alias labels strand rides in "searching".
- **Why:** two staging defects traced to silent input coercion and alias category leakage, both invisible in server math.
- **How to apply:** when adding fare fields or new category aliases, validate blank vs zero explicitly and keep quote/ride category canonical; tests/fare-quote.test.js proves both.

## Customer-facing receipt boundary
Rule: any customer-facing receipt surface (modal, PDF, share text) must exclude commission, driver earnings, internal payment mode, and all internal IDs; owner-only surfaces get the full immutable ride_receipts body. `lib/receipt-pdf.js customerReceiptView()` is the single source of truth for what a rider may see.
**Why:** ride_receipts.body deliberately stores full accounting (commission/net) for owner audit; leaking it to riders exposes driver pay. The JSON /receipt endpoint still returns the full body (an existing test depends on it) — filtering happens at render/PDF level.
**How to apply:** when adding receipt exports (email, print, new formats), build them from customerReceiptView, never from the raw body.

## Driver finance (settlements/tips/statements)
- Money direction rule: cash ride => commission is a `driver_receivables` row ("Driver owes HAPA"), never a payable; M-Pesa ride => net is a `driver_payables` row ("HAPA owes Driver"). All math in integer cents via lib/finance.js (`cents`/`kes`); never trust `money()` float rounding in rides.js for new accounting.
- Boot backfill (`backfillFinance`) must run from server boot() AFTER schema executes — never at route-module require time; it is idempotent via `financial_transactions.idempotency_key` and `... WHERE reference IS NULL` guards.
- Any settlement method that moves money out of a stateful pot (reserve_offset) must have a matching reversal path that puts it back; reversal-only-restores-receivables was a real bug caught by architect review.
- Express route gotcha: register `/api/x/:id.pdf` and `:id.csv` BEFORE `/api/x/:id` or the bare param route captures "uuid.pdf".
- ShellExec self-kill trap extended: any literal substring of the running command (e.g. "PORT=5208") passed to pkill -f kills the session; kill by inspecting /proc/<pid>/environ instead. Background `node server.js &` from one ShellExec dies when the session ends — start server and tests in the SAME command.
- Workspace files can be silently reverted/deleted mid-session (checkpoint restore): after any unexpected "file not found", check `git status` for lost tracked edits AND untracked new files before assuming your edits persist.

## Monthly statement accounting + PDF verification (2026-08-01)
- Accrual rule: statement opening/closing/movement math must date receivables/payables by ride completion time (`COALESCE(ride.completed_at,row.created_at)`), never row created_at — backfilled rows carry deploy-time created_at and silently fall out of the month they belong to (July closing showed 0.00 instead of 103.84 on staging).
- Statement generation must reconcile loudly: opening + period movements must equal closing (integer cents) or generation throws — never issue an unbalanced statement.
- PDF layout verification must be geometric, not string-based: `pdftotext -bbox` word boxes checked per page (splitting pages first — comparing across pages yields false overlaps of repeated headers), plus `pdftoppm` render for eyeball check. Poppler bins live under the replit-runtime-path nix store dir.
- CodeExecution quirk: `requestSecrets` values may arrive empty inside a `"use impure"` function argument; read `process.env.<KEY>` inside the impure body instead.

## Finance hardening (Aug 2026)
- Statement (re)generation is delete+reinsert of items; it is serialized with `pg_advisory_xact_lock` keyed on driver+period inside the route transaction. Any new path that regenerates statements must run inside a transaction so the lock releases.
- Reconciliation failures ROLLBACK the statement txn; alerts are raised via pool-level queries OUTSIDE that txn (they would vanish otherwise). Dedup is a partial unique index on (alert_type,driver,period) WHERE status unresolved; successful regeneration auto-resolves.
- PDFs (statement + receipt) use pdfkit with embedded/subset DejaVu fonts committed in `fonts/` (licence at fonts/DEJAVU-LICENSE.txt). Output streams are COMPRESSED — tests must assert via `pdftotext`/`pdftotext -bbox`, never by grepping raw PDF bytes. Emoji are stripped by `pdfSafe` in lib/receipt-pdf.js (shared); Latin-Extended/Swahili/curly quotes render natively.
- `FINANCE_FAULT_INJECT_DRIVER` (test-only, ignored when NODE_ENV=production) forces a reconciliation failure; supports `domain:<email-domain>` so tests can create the faulty user after server start.
- Test fixtures: vehicle registration numbers are UNIQUE across the whole DB — randomize per run or reruns fail with silent "no offer" (vehicle create 409 → driver never truly online). M-Pesa test rides need POST /api/rides/:id/pay-mpesa (mock) after complete, or the ride stays payment_pending and blocks the rider's next ride.
- Cross-month accrual in tests: backdate `ride_requests.completed_at` via psql on the run's own synthetic rides; boundary is Africa/Nairobi (use UTC-crossing timestamps like 23:00Z = 02:00 EAT next day to prove it).

## Maps/GPS stage (Aug 2026)
- All Google calls go through `lib/maps.js` only (mock|google, auto by GOOGLE_MAPS_SERVER_KEY). Mock label is the exact string "Development route estimate — Google Maps not configured" — tests assert it verbatim.
- Quotes bind immutable `route_snapshots` rows with an HMAC (SESSION_SECRET-keyed) integrity hash; ride create re-verifies hash + 150 m coordinate tolerance → 409 on tamper.
- Test recipe additions: server env needs `MAPS_ALLOW_CLIENT_DISTANCE=true LOC_MIN_INTERVAL_MS=0` for fixture suites. Beware falsy-zero env parsing: `Number(env)||default` swallows `0` overrides.
- Location ingest gates: accuracy ≤ LOC_MAX_ACCURACY_M(250), speed ≤ 70 m/s, heading 0–360, recorded_at ≤ 120 s old, per-driver pace LOC_MIN_INTERVAL_MS(350 ms), monotonic seq.
- Frontend must never fabricate coordinates: no fallback Embu coords on geolocation failure (driver skips tick), rider quote/request blocked until pickup+dest resolved via autocomplete/GPS/reverse-geocode.
- launch-readiness greps AndroidManifest for the literal string ACCESS_BACKGROUND_LOCATION — keep it out even of comments.
- Web key env renamed to GOOGLE_MAPS_WEB_KEY (BROWSER_KEY still a fallback); ride-gates test asserts the new gate name. Key matrix + ops in docs/maps-gps-setup.md.
