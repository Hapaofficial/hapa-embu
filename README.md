# HAPA v1.6

Implemented:
- Partner removed.
- Every new account starts as Customer.
- Customer signs up with phone OR email + password + selfie.
- Owner Accept / Reject flow for Customer access.
- Reject does not block/delete the account.
- Rejected Customer can send request again.
- Same account can later add Driver, Merchant and Professional permissions.
- Driver application: licence, licence photo, vehicle registration, insurance, expiry, vehicle photo.
- Merchant application: business name/category, KRA/registration details, address/location, store photo.
- Professional application: profession, skills, experience, location, photo.
- Professional categories prepared (construction, auto, tech, beauty, agriculture, business and more).
- Marketplace available to every active Customer.
- Marketplace categories include electronics, vehicles, home, tools, farm, property and more.
- Existing old Partner users are migrated to normal Customer accounts.

Render:
- Keep DATABASE_URL, OWNER_EMAIL, OWNER_PASSWORD, OWNER_NAME, JWT_SECRET, PAYMENT_MODE.
- Add AUTH_MODE=demo for testing verification/reset codes.
- Build: npm install
- Start: npm start

Important:
- v1.6 stores small test images in PostgreSQL as data URLs (max 2 MB each). Before large public launch, move image/document storage to S3/Cloudinary or equivalent.
- Real SMS/email OTP delivery still needs a provider. AUTH_MODE=demo shows the code on screen for testing.
