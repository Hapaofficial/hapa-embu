# HAPA Embu v1.5 — Production Core

This upgrade moves HAPA from JSON persistence to Render PostgreSQL and keeps the current owner/business interface.

## Included

- PostgreSQL persistence
- automatic schema creation
- one-time import from legacy `data/db.json` when the database is empty
- secure bcrypt passwords
- JWT sessions stored in HttpOnly cookies
- auth rate limiting and security headers
- owner account seeding from Render variables
- customer registration
- driver / merchant / partner applications with owner approval
- owner user management
- profile editing, email/password changes, login history
- persistent HAPA Wallet and transaction history
- persistent rides and orders
- owner business settings
- PWA support
- payment provider readiness status

## Render environment variables

Required:
- `DATABASE_URL` — Render Internal Database URL
- `OWNER_EMAIL`
- `OWNER_PASSWORD` — 12+ characters with uppercase, lowercase and number
- `OWNER_NAME`
- `JWT_SECRET` — at least 32 random characters
- `PAYMENT_MODE=demo`

Optional M-Pesa:
- `MPESA_CONSUMER_KEY`
- `MPESA_CONSUMER_SECRET`
- `MPESA_SHORTCODE`
- `MPESA_PASSKEY`
- `MPESA_CALLBACK_URL`

Optional cards:
- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`

## Render settings
- Root Directory: empty
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/health`

## Payment note
HAPA Wallet demo mode is operational for testing. Real M-Pesa/card charging is intentionally not faked: live provider callbacks/webhooks still need official credentials and provider-side verification before real money can be processed.

## HAPA v1.5 account access & recovery

New in v1.5:
- Login with email **or** phone number.
- Registration can use email, phone, or both.
- Password recovery with a 6-digit one-time code.
- Recovery by email or phone.
- Reset codes expire after 10 minutes and are limited to 5 attempts.
- Resetting a password invalidates existing sessions.

### Recovery environment variables

`RECOVERY_MODE=demo` keeps recovery in test mode and returns the reset code in the UI. Use this only for testing.

For real email recovery, set:
- `RECOVERY_MODE=live`
- `RESEND_API_KEY`
- `RESET_EMAIL_FROM` (a verified sender address)

For real SMS recovery, set:
- `RECOVERY_MODE=live`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

Do not launch publicly with `RECOVERY_MODE=demo`, because demo mode exposes the reset code to the requester.
