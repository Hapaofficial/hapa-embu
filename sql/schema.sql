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
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK(status IN('active','pending','rejected','blocked','deactivated','deleted'));
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
 condition TEXT NOT NULL DEFAULT 'Used', description TEXT DEFAULT '', location TEXT DEFAULT '',
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

-- ═══════════════════════════════════════════════════════════════════════════
-- MVP completion sprint (all idempotent, additive only)
-- ═══════════════════════════════════════════════════════════════════════════

-- Account settings / deactivation
ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- Merchant public business profile (mirrors professional_profiles; separate
-- from the verified application and private documents)
CREATE TABLE IF NOT EXISTS merchant_profiles(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 application_id UUID REFERENCES upgrade_applications(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','active','paused','owner_hidden')),
 verified_category TEXT NOT NULL DEFAULT '',
 business_name TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL DEFAULT '',
 county TEXT NOT NULL DEFAULT '',
 town TEXT NOT NULL DEFAULT '',
 service_area TEXT NOT NULL DEFAULT '',
 opening_hours TEXT NOT NULL DEFAULT '',
 phone_visible BOOLEAN NOT NULL DEFAULT false,
 whatsapp_visible BOOLEAN NOT NULL DEFAULT false,
 logo_image_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 published_at TIMESTAMPTZ, paused_at TIMESTAMPTZ, hidden_at TIMESTAMPTZ,
 hidden_by UUID REFERENCES users(id) ON DELETE SET NULL,
 moderation_note TEXT, status_before_hidden TEXT
);
CREATE INDEX IF NOT EXISTS idx_merchprofile_status ON merchant_profiles(status);

-- Driver public profile
CREATE TABLE IF NOT EXISTS driver_profiles(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 application_id UUID REFERENCES upgrade_applications(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','active','paused','owner_hidden')),
 vehicle_type TEXT NOT NULL DEFAULT '',
 display_name TEXT NOT NULL DEFAULT '',
 vehicle_description TEXT NOT NULL DEFAULT '',
 county TEXT NOT NULL DEFAULT '',
 town TEXT NOT NULL DEFAULT '',
 service_area TEXT NOT NULL DEFAULT '',
 availability TEXT NOT NULL DEFAULT '',
 pricing_info TEXT NOT NULL DEFAULT '',
 phone_visible BOOLEAN NOT NULL DEFAULT false,
 whatsapp_visible BOOLEAN NOT NULL DEFAULT false,
 profile_photo_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 published_at TIMESTAMPTZ, paused_at TIMESTAMPTZ, hidden_at TIMESTAMPTZ,
 hidden_by UUID REFERENCES users(id) ON DELETE SET NULL,
 moderation_note TEXT, status_before_hidden TEXT
);
CREATE INDEX IF NOT EXISTS idx_driverprofile_status ON driver_profiles(status);

-- Merchant items (products/services offered by a merchant business)
CREATE TABLE IF NOT EXISTS merchant_items(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 merchant_profile_id UUID NOT NULL REFERENCES merchant_profiles(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 category TEXT NOT NULL DEFAULT '',
 price NUMERIC(14,2),
 price_unit TEXT NOT NULL DEFAULT '',
 in_stock BOOLEAN NOT NULL DEFAULT true,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','paused','archived','owner_hidden')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_merchitem_profile ON merchant_items(merchant_profile_id,status);

-- Shared public media for merchant/driver modules (PII-free keys, soft delete).
CREATE TABLE IF NOT EXISTS provider_media(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_kind TEXT NOT NULL CHECK(owner_kind IN('merchant_profile','merchant_item','driver_profile')),
 owner_id UUID NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('logo','gallery','item','profile_photo')),
 storage_provider TEXT NOT NULL,
 storage_key TEXT NOT NULL UNIQUE,
 mime_type TEXT NOT NULL,
 size_bytes BIGINT NOT NULL,
 width INTEGER, height INTEGER,
 sha256 TEXT NOT NULL,
 sort_order INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','removed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 removed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_providermedia_owner ON provider_media(owner_kind,owner_id,status);

-- Unified request/enquiry/booking system
CREATE TABLE IF NOT EXISTS service_requests(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider_type TEXT NOT NULL CHECK(provider_type IN('professional','merchant','driver')),
 profile_id UUID NOT NULL,
 item_id UUID REFERENCES merchant_items(id) ON DELETE SET NULL,
 request_type TEXT NOT NULL CHECK(request_type IN('service','enquiry','order','reservation','ride','delivery','transport')),
 pickup_text TEXT NOT NULL DEFAULT '',
 destination_text TEXT NOT NULL DEFAULT '',
 requested_for TEXT NOT NULL DEFAULT '',
 note TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted','declined','cancelled','completed')),
 cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 accepted_at TIMESTAMPTZ, declined_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_svcreq_customer ON service_requests(customer_id,status);
CREATE INDEX IF NOT EXISTS idx_svcreq_provider ON service_requests(provider_user_id,status);

-- Status history + in-request messages
CREATE TABLE IF NOT EXISTS request_events(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
 actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
 event_type TEXT NOT NULL CHECK(event_type IN('created','status','message')),
 status TEXT, message TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reqevents_request ON request_events(request_id,created_at);

-- Reviews: one per completed request
CREATE TABLE IF NOT EXISTS reviews(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id UUID NOT NULL UNIQUE REFERENCES service_requests(id) ON DELETE CASCADE,
 reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider_type TEXT NOT NULL CHECK(provider_type IN('professional','merchant','driver')),
 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','owner_hidden')),
 moderation_note TEXT,
 hidden_at TIMESTAMPTZ,
 hidden_by UUID REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reviews_provider ON reviews(provider_user_id,provider_type,status);

-- Generic reports (users, profiles, items, reviews, requests, general problems)
CREATE TABLE IF NOT EXISTS reports(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
 target_type TEXT NOT NULL CHECK(target_type IN('user','professional_profile','merchant_profile','driver_profile','merchant_item','review','request','problem')),
 target_id UUID,
 reason TEXT NOT NULL,
 details TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','reviewed','dismissed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reviewed_at TIMESTAMPTZ,
 reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_generic_status ON reports(status,target_type);

-- Owner action audit trail
CREATE TABLE IF NOT EXISTS owner_audit_log(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL,
 target_type TEXT NOT NULL DEFAULT '',
 target_id TEXT NOT NULL DEFAULT '',
 note TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_owneraudit_created ON owner_audit_log(created_at DESC);

-- ── v1.7 launch candidate: precise trip locations, account deletion, push tokens ──

-- Precise GPS pickup/destination for driver requests (visible only to the
-- customer, the addressed provider, and the Owner — never in public APIs).
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS destination_lat DOUBLE PRECISION;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS destination_lng DOUBLE PRECISION;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS pickup_address TEXT;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS destination_address TEXT;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS pickup_note TEXT;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS landmark TEXT;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS route_distance_m INTEGER;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS route_duration_s INTEGER;

-- Account deletion (anonymized tombstone; audit records retained)
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Push notification device tokens (native apps / web push)
CREATE TABLE IF NOT EXISTS device_tokens(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 platform TEXT NOT NULL CHECK(platform IN('android','ios','web')),
 token TEXT NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

-- Notification preferences (privacy-safe defaults)
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_prefs JSONB NOT NULL DEFAULT '{}';

-- ── Geographic hierarchy (Kenya-wide from day one; Embu is the first ACTIVE market, not the only supported one).
-- Levels: country > county > sub_county > town > zone. Stable IDs; names stay readable.
CREATE TABLE IF NOT EXISTS geo_areas(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 slug TEXT UNIQUE NOT NULL,
 name TEXT NOT NULL,
 level TEXT NOT NULL CHECK(level IN('country','county','sub_county','town','zone')),
 parent_id UUID REFERENCES geo_areas(id) ON DELETE CASCADE,
 active BOOLEAN NOT NULL DEFAULT FALSE,
 -- zone-level config: search radius, expansion rules, cross-county flags, geofence, etc.
 config JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS geo_areas_parent_idx ON geo_areas(parent_id);
CREATE INDEX IF NOT EXISTS geo_areas_level_active_idx ON geo_areas(level,active);

-- ── Fare rate cards: per area (county/town/zone) + vehicle category + effective date.
-- Embu pricing never becomes the nationwide default; new markets get their own cards via config.
CREATE TABLE IF NOT EXISTS fare_rate_cards(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 area_id UUID NOT NULL REFERENCES geo_areas(id) ON DELETE CASCADE,
 vehicle_category TEXT NOT NULL,
 currency TEXT NOT NULL DEFAULT 'KES',
 base_fare NUMERIC(10,2) NOT NULL CHECK(base_fare>=0),
 per_km NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK(per_km>=0),
 per_min NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK(per_min>=0),
 minimum_fare NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK(minimum_fare>=0),
 effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS fare_cards_area_idx ON fare_rate_cards(area_id,vehicle_category,effective_from DESC);
