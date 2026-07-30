# Release & Rollback Runbook

## Website / backend (Render)

**Release**: merge the approved branch → Render auto-deploys → verify
`/api/health`, run schema (applied automatically at boot; additive/idempotent)
→ smoke-test login, marketplace, one request flow.

**Rollback**: Render dashboard → service → Deploys → "Rollback" to the previous
deploy. The schema is additive-only, so older code runs safely against a newer
schema. Never roll back the database.

## Android

**Release**: bump `versionCode`/`versionName` → `./gradlew bundleRelease` →
Play Console → Internal testing → promote to closed/production with **staged
rollout** (start 10–20%).

**Rollback**: Play has no true rollback — halt the staged rollout, then upload
a new higher-versionCode build from the last good tag. Keep git tags per
release (`android-v1.7.0`).

**Emergency lever**: because the apps load the website remotely, most fixes
ship by fixing the website and rolling *it* back/forward — no store release
needed. This is the primary incident response path.

## iOS

**Release**: bump version/build → Archive → TestFlight → phased release on the
App Store.

**Rollback**: halt phased release; submit an expedited-review fix build.
Same emergency lever as Android: fix the website.

## Checklist before any store release

- [ ] All local test suites pass
- [ ] Staging E2E pass
- [ ] Production website deployed and healthy (apps depend on it)
- [ ] Release notes drafted; git tag created
- [ ] Previous AAB/IPA archived alongside its tag
