CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, email TEXT, phone TEXT,
 role TEXT NOT NULL DEFAULT 'customer', status TEXT NOT NULL DEFAULT 'pending',
 password_hash TEXT NOT NULL, wallet_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
 profile_photo_url TEXT DEFAULT '', email_verified BOOLEAN NOT NULL DEFAULT FALSE,
 phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
 capabilities JSONB NOT NULL DEFAULT '{"driver":false,"merchant":false,"professional":false}'::jsonb,
 token_version INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{"driver":false,"merchant":false,"professional":false}'::jsonb;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users
SET role='customer',
    status='pending'
WHERE role='partner';

-- Owner/customer assignment is enforced transactionally in server.js at startup.
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN('owner','customer'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK(status IN('active','pending','rejected','blocked'));
UPDATE users SET capabilities=jsonb_set(capabilities,'{driver}','true',true),role='customer' WHERE role='driver';
UPDATE users SET capabilities=jsonb_set(capabilities,'{merchant}','true',true),role='customer' WHERE role='merchant';
UPDATE users SET role='customer',status=CASE WHEN status='blocked' THEN 'rejected' ELSE status END WHERE role='partner';
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uq ON users(phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS access_requests(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS upgrade_applications(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 type TEXT NOT NULL CHECK(type IN('driver','merchant','professional')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
 details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS verification_codes(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 channel TEXT NOT NULL, purpose TEXT NOT NULL, code TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS marketplace_listings(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), seller_id UUID REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL, price NUMERIC(14,2) NOT NULL, category TEXT NOT NULL DEFAULT 'Other',
 condition TEXT NOT NULL DEFAULT 'Used', description TEXT DEFAULT '', location TEXT DEFAULT 'Embu',
 images JSONB NOT NULL DEFAULT '[]'::jsonb, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT NOW()
);
