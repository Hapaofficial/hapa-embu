# HAPA — Embu local marketplace (v1.6)

## Overview
Single-file-style Node/Express + PostgreSQL marketplace app for Embu, Kenya. Verified-members-only selling: every account is owner-reviewed, and professional/merchant/driver roles require verified documents. No payment processing — members transact directly.

## Architecture
- `server.js` — Express app: auth (JWT + token_version), users/access/upgrades, listings marketplace, professional public profiles, security headers, rate limits, module registration.
- `routes/merchant.js`, `routes/driver.js` — public business/driver profiles (locked verified category/vehicle type), media, moderation.
- `routes/requests.js` — unified customer↔provider requests (service/enquiry/order/reservation/ride/delivery/transport), messages, status transitions, reviews, generic reports, owner audit log.
- `routes/account.js` — profile edit, password change, deactivation, public site-info.
- `lib/providerMedia.js` — shared provider media storage/serving (owner + public routes).
- `sql/schema.sql` — additive idempotent migrations, run at boot.
- `public/index.html` — entire SPA (vanilla JS, dense compact style); `public/sw.js` PWA service worker (never caches /api).
- Tests: `tests/*.test.js` run against a second local server on port 5100 (see test file headers for env).

## Conventions
- Soft deletes everywhere; moderation uses `status_before_hidden` restore pattern and never touches roles/capabilities/verified applications.
- Error shape `{error:'...'}`; 500 catch pattern; PII-free storage keys; EXIF stripped from uploads.
- `AUTH_MODE=demo` is dev-only (relaxed rate limits, codes in responses) — never in production.
- Git: work happens on `feature/professional-public-profile`; never merge to main; never touch production.

## User preferences
- Autonomous execution preferred; report in the mandated STATUS/STAGING/... format at the end of a sprint.
