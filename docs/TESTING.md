# HAPA Testing — Canonical Commands

One runner drives everything: `scripts/test/run.js`. It is dependency-free
(uses the existing `pg` module) and fails closed on any safety violation.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Everything: syntax + static + full integration run |
| `npm run test:syntax` | `node --check` over all runtime JS (server, lib, routes, scripts, tests, sw) |
| `npm run test:static` | Static/frontend suites — no PostgreSQL needed |
| `npm run test:integration` | All server suites against a disposable test database |

Filter to specific suites while developing:

```bash
node scripts/test/run.js integration --only=maps-gps,ride-hailing
```

## What the integration runner does

1. **Guards the database target.** It reads `DATABASE_URL` only to reach a
   PostgreSQL *host*, and only accepts clearly local hosts
   (`localhost`, `127.0.0.1`, `::1`, `helium`). Staging/production/remote
   URLs (onrender, neon.tech, RDS, …) are rejected and the run aborts.
2. **Creates a disposable database** named `hapa_test_<stamp>` — suites never
   touch the normal development database, so no leftover users, rides,
   driver sessions, fare cards or finance records can contaminate anything.
3. **Boots two test servers** on dynamically allocated free ports: the main
   server and a `MAPS_FAULT_INJECT=route:timeout` companion (exposed to
   suites as `FAULT_B`) for provider-failure tests.
4. **Runs every suite from the manifest** with per-suite session cleanup in
   between. The manifest in `scripts/test/run.js` must classify every
   `tests/*.test.js` (static / integration / self-managed); an unlisted file
   fails the run, so a new suite can never be silently skipped.
5. **Cleans up**: kills all child processes (also on failure/CTRL-C),
   terminates connections and drops the test database. Failed cleanup makes
   the run fail.
6. **Prints one summary**: per-suite pass/fail with timing and counts,
   elapsed time, first failing suite with its rerun command, cleanup result.
   Exit code is non-zero on any failed suite, boot failure, incomplete
   cleanup or manifest violation.

All credentials involved are synthetic (`CiTestOwner2026!` etc.); the fixed
owner identity `trader2027@protonmail.com` is enforced by `server.js` itself
and is seeded fresh in the disposable database. No secret values are printed.

## Environment the runner sets for suites

Test-only flags the suites rely on (never set in production):
`MAPS_ALLOW_CLIENT_DISTANCE=true`, `LOC_MIN_INTERVAL_MS=0`,
`COMMISSION_RESERVE_ENABLED/LEGAL_APPROVED=true`,
`FINANCE_FAULT_INJECT_DRIVER=domain:fault-inject.test`, local storage modes.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to
`feature/professional-public-profile`, on pull requests, and manually. It
uses Node.js 22 with an isolated `postgres:16` service container, installs
dependencies with the same command Render uses (`npm install`), then runs
`npm run test:syntax` and `npm test`. It contains no real credentials and
never deploys.
