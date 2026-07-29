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

-- Listing soft-delete/visibility status (idempotent, includes sold)
ALTER TABLE marketplace_listings DROP CONSTRAINT IF EXISTS listings_status_check;
ALTER TABLE marketplace_listings ADD CONSTRAINT listings_status_check CHECK(status IN('active','hidden','removed','sold'));

-- Marketplace PRO: extend marketplace_listings (all idempotent)
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS views_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS contact_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS negotiable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS seller_phone_visible BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_listings_status ON marketplace_listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON marketplace_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_category ON marketplace_listings(category);

-- Listing favorites
CREATE TABLE IF NOT EXISTS listing_favorites(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 listing_id UUID REFERENCES marketplace_listings(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON listing_favorites(user_id);

-- Listing reports
CREATE TABLE IF NOT EXISTS listing_reports(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 listing_id UUID REFERENCES marketplace_listings(id) ON DELETE CASCADE,
 reporter_id UUID REFERENCES users(id) ON DELETE CASCADE,
 reason TEXT NOT NULL CHECK(reason IN('scam','prohibited_item','wrong_category','duplicate','offensive_content','other')),
 details TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','reviewed','dismissed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reviewed_at TIMESTAMPTZ,
 reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_listing ON listing_reports(listing_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON listing_reports(status);

-- Sprint 2: Upgrade System (all idempotent)
ALTER TABLE upgrade_applications DROP CONSTRAINT IF EXISTS upgrade_applications_status_check;
ALTER TABLE upgrade_applications ADD CONSTRAINT upgrade_applications_status_check
 CHECK(status IN('draft','pending','corrections_requested','approved','rejected','suspended'));
ALTER TABLE upgrade_applications ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE upgrade_applications ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE upgrade_applications ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE upgrade_applications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_upgrade_user_type ON upgrade_applications(user_id,type);

-- Sprint 2B: Secure Private Document Storage (all idempotent)
ALTER TABLE upgrade_applications ADD COLUMN IF NOT EXISTS sensitive_details TEXT;
ALTER TABLE upgrade_applications ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
ALTER TABLE upgrade_applications ADD COLUMN IF NOT EXISTS consent_version TEXT;

CREATE TABLE IF NOT EXISTS private_documents(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 upgrade_application_id UUID NOT NULL REFERENCES upgrade_applications(id) ON DELETE CASCADE,
 application_type TEXT NOT NULL CHECK(application_type IN('driver','merchant','professional')),
 document_type TEXT NOT NULL,
 storage_provider TEXT NOT NULL CHECK(storage_provider IN('local','s3')),
 object_key TEXT NOT NULL UNIQUE,
 mime_type TEXT NOT NULL,
 size_bytes BIGINT NOT NULL,
 width INTEGER,
 height INTEGER,
 sha256 TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','replaced','removed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 removed_at TIMESTAMPTZ,
 retention_until TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_privdoc_user ON private_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_privdoc_app ON private_documents(upgrade_application_id);
CREATE INDEX IF NOT EXISTS idx_privdoc_apptype ON private_documents(application_type);
CREATE INDEX IF NOT EXISTS idx_privdoc_doctype ON private_documents(document_type);
CREATE INDEX IF NOT EXISTS idx_privdoc_status ON private_documents(status);

CREATE TABLE IF NOT EXISTS document_access_log(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 document_id UUID NOT NULL REFERENCES private_documents(id) ON DELETE CASCADE,
 actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL CHECK(action IN('upload','view','replace','remove')),
 ip_address TEXT,
 user_agent TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doclog_document ON document_access_log(document_id);

-- Public Professional profiles — Sprint 3A (all idempotent).
-- Completely separate from the verified application (upgrade_applications) and
-- from private_documents. Public marketing data only; no identity data.
CREATE TABLE IF NOT EXISTS professional_profiles(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 application_id UUID REFERENCES upgrade_applications(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','active','paused','owner_hidden')),
 verified_category TEXT NOT NULL DEFAULT '',
 display_name TEXT NOT NULL DEFAULT '',
 headline TEXT NOT NULL DEFAULT '',
 service_description TEXT NOT NULL DEFAULT '',
 skills JSONB NOT NULL DEFAULT '[]',
 county TEXT NOT NULL DEFAULT '',
 town TEXT NOT NULL DEFAULT '',
 service_area TEXT NOT NULL DEFAULT '',
 availability TEXT NOT NULL DEFAULT '',
 starting_price NUMERIC,
 pricing_unit TEXT NOT NULL DEFAULT '',
 phone_visible BOOLEAN NOT NULL DEFAULT false,
 whatsapp_visible BOOLEAN NOT NULL DEFAULT false,
 profile_photo_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 published_at TIMESTAMPTZ,
 paused_at TIMESTAMPTZ,
 hidden_at TIMESTAMPTZ,
 hidden_by UUID REFERENCES users(id) ON DELETE SET NULL,
 moderation_note TEXT,
 status_before_hidden TEXT
);
ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS status_before_hidden TEXT;
CREATE INDEX IF NOT EXISTS idx_proprofile_status ON professional_profiles(status);

-- Public media (profile photo + portfolio). Soft deletion only (status='removed').
CREATE TABLE IF NOT EXISTS professional_portfolio_images(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 professional_profile_id UUID NOT NULL REFERENCES professional_profiles(id) ON DELETE CASCADE,
 kind TEXT NOT NULL DEFAULT 'portfolio' CHECK(kind IN('portfolio','profile_photo')),
 storage_provider TEXT NOT NULL,
 storage_key TEXT NOT NULL UNIQUE,
 mime_type TEXT NOT NULL,
 size_bytes BIGINT NOT NULL,
 width INTEGER,
 height INTEGER,
 sha256 TEXT NOT NULL,
 sort_order INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','removed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 removed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portfolioimg_profile ON professional_portfolio_images(professional_profile_id,status);
