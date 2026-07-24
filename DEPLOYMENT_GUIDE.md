# Deploy HAPA v1.5 on Render

1. Upload the **contents** of this folder to the root of the `hapa-embu` GitHub repository.
2. Keep Render Root Directory empty.
3. Confirm Environment contains `DATABASE_URL`, `JWT_SECRET`, `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME`, `PAYMENT_MODE`.
4. Use **Manual Deploy → Clear build cache & deploy** once after replacing the old v1.2 package.
5. Check `/api/health`; it should report `version: 1.4.0` and `database: postgres`.
6. Log in with the owner email/password.

## v1.5 password recovery

For testing on Render add:

`RECOVERY_MODE=demo`

After the flow is verified, switch to `RECOVERY_MODE=live` and configure either Resend (email) and/or Twilio (SMS) using the environment variables documented in README.md.
