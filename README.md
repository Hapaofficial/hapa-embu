# HAPA Embu v1.2 — Professional Settings & Payment Foundation

This package adds:

- secure registration and login for customers, drivers, merchants and partners
- owner dashboard and account approvals
- owner profile, email change, password change and logout-all-devices
- profile address, language and notification preferences
- business profile settings
- support contact settings
- currency, timezone, commission and service pricing settings
- payment method controls
- HAPA Wallet and transaction history
- M-Pesa and card provider configuration detection
- PWA installation support

## Render settings

- Root Directory: empty
- Build Command: `npm install`
- Start Command: `npm start`

## Required environment variables

- `OWNER_EMAIL` — initial owner email
- `OWNER_PASSWORD` — initial owner password (12+ characters, uppercase, lowercase and a number)
- `OWNER_NAME` — owner display name
- `JWT_SECRET` — long random secret, 32+ characters
- `PAYMENT_MODE` — use `demo` until real payment callbacks are connected

## Optional M-Pesa variables

- `MPESA_CONSUMER_KEY`
- `MPESA_CONSUMER_SECRET`
- `MPESA_SHORTCODE`
- `MPESA_PASSKEY`
- `MPESA_CALLBACK_URL`

## Optional card variables

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`

## Important payment status

The app contains a complete test-payment flow and professional provider settings. It does **not** charge real M-Pesa or cards until official provider credentials, callback URLs and webhook verification are connected. In demo mode, no real money is charged.

After upload, deploy with **Clear build cache & deploy**.
