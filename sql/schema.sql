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
-- No two identical ACTIVE cards for the same area/category/effective date (historical/deactivated cards are kept).
-- Pre-existing exact duplicates are deactivated (newest kept) so the index can build.
WITH dup AS(SELECT id,ROW_NUMBER() OVER(PARTITION BY area_id,LOWER(vehicle_category),effective_from ORDER BY created_at DESC,id DESC) rn FROM fare_rate_cards WHERE active)
UPDATE fare_rate_cards SET active=false WHERE id IN(SELECT id FROM dup WHERE rn>1);
CREATE UNIQUE INDEX IF NOT EXISTS fare_cards_no_dup_active ON fare_rate_cards(area_id,LOWER(vehicle_category),effective_from) WHERE active;

-- ════════════════════════════════════════════════════════════════════════════
-- REAL-TIME RIDE-HAILING (Embu pilot; Kenya-wide via geo_areas). All additive.
-- ════════════════════════════════════════════════════════════════════════════

-- Extended fare components (additive to existing fare_rate_cards)
ALTER TABLE fare_rate_cards ADD COLUMN IF NOT EXISTS booking_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE fare_rate_cards ADD COLUMN IF NOT EXISTS waiting_per_min NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE fare_rate_cards ADD COLUMN IF NOT EXISTS cancellation_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE fare_rate_cards ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2) NOT NULL DEFAULT 15;

-- Audited operational/legal configuration (no hardcoded legal limits in code)
CREATE TABLE IF NOT EXISTS compliance_settings(
 key TEXT PRIMARY KEY, value JSONB NOT NULL,
 note TEXT NOT NULL DEFAULT '', updated_by UUID REFERENCES users(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS user_agreement_acceptances(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 agreement TEXT NOT NULL, version TEXT NOT NULL,
 accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,agreement,version)
);

-- Driver fleet & eligibility
CREATE TABLE IF NOT EXISTS driver_vehicles(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 category TEXT NOT NULL, make TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
 colour TEXT NOT NULL DEFAULT '', registration_number TEXT NOT NULL,
 year INTEGER, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','retired')),
 moderation_note TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS driver_vehicles_reg_uniq ON driver_vehicles(LOWER(registration_number)) WHERE status IN('pending','approved');
CREATE TABLE IF NOT EXISTS driver_document_status(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 doc_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','expired')),
 reference TEXT NOT NULL DEFAULT '', expires_on DATE,
 reviewed_by UUID REFERENCES users(id), reviewed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ,
 UNIQUE(driver_user_id,doc_type)
);
CREATE TABLE IF NOT EXISTS driver_operating_zones(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 zone_id UUID NOT NULL REFERENCES geo_areas(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN('approved','revoked')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(driver_user_id,zone_id)
);
CREATE TABLE IF NOT EXISTS driver_availability_sessions(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 zone_id UUID NOT NULL REFERENCES geo_areas(id),
 vehicle_id UUID NOT NULL REFERENCES driver_vehicles(id),
 status TEXT NOT NULL DEFAULT 'online' CHECK(status IN('online','paused','ended')),
 started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ended_at TIMESTAMPTZ,
 online_seconds INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_driver ON driver_availability_sessions(driver_user_id) WHERE status IN('online','paused');
CREATE TABLE IF NOT EXISTS driver_presence(
 driver_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 session_id UUID REFERENCES driver_availability_sessions(id) ON DELETE SET NULL,
 lat DOUBLE PRECISION, lng DOUBLE PRECISION, accuracy_m REAL, heading REAL, speed_mps REAL,
 seq BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quotes & rides
CREATE TABLE IF NOT EXISTS fare_quotes(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 rider_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 zone_id UUID NOT NULL REFERENCES geo_areas(id),
 rate_card_id UUID NOT NULL REFERENCES fare_rate_cards(id),
 vehicle_category TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'KES',
 distance_m INTEGER NOT NULL, duration_s INTEGER NOT NULL,
 components JSONB NOT NULL, total NUMERIC(10,2) NOT NULL,
 demand_pricing BOOLEAN NOT NULL DEFAULT FALSE, route_source TEXT NOT NULL DEFAULT 'manual',
 expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ride_requests(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 rider_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 quote_id UUID NOT NULL REFERENCES fare_quotes(id),
 zone_id UUID NOT NULL REFERENCES geo_areas(id),
 vehicle_category TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'searching' CHECK(status IN('draft','quoted','searching','offered','driver_assigned','driver_en_route','driver_arrived','pin_verified','in_progress','completed','rider_cancelled','driver_cancelled','declined','no_driver_available','payment_pending','payment_failed','closed')),
 driver_user_id UUID REFERENCES users(id), vehicle_id UUID REFERENCES driver_vehicles(id),
 pickup_lat DOUBLE PRECISION NOT NULL, pickup_lng DOUBLE PRECISION NOT NULL,
 dest_lat DOUBLE PRECISION NOT NULL, dest_lng DOUBLE PRECISION NOT NULL,
 pickup_address TEXT NOT NULL DEFAULT '', dest_address TEXT NOT NULL DEFAULT '',
 pickup_note TEXT NOT NULL DEFAULT '', landmark TEXT NOT NULL DEFAULT '',
 payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN('cash','mpesa')),
 pin_hash TEXT NOT NULL DEFAULT '', pin_attempts INTEGER NOT NULL DEFAULT 0,
 idempotency_key TEXT NOT NULL,
 search_started_at TIMESTAMPTZ, assigned_at TIMESTAMPTZ, arrived_at TIMESTAMPTZ,
 started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, closed_at TIMESTAMPTZ,
 cancel_reason TEXT NOT NULL DEFAULT '', cancelled_by UUID REFERENCES users(id),
 final_fare NUMERIC(10,2), final_components JSONB, fare_difference_note TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ride_idem_uniq ON ride_requests(rider_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_ride_per_rider ON ride_requests(rider_id) WHERE status IN('searching','offered','driver_assigned','driver_en_route','driver_arrived','pin_verified','in_progress','payment_pending');
CREATE UNIQUE INDEX IF NOT EXISTS one_active_ride_per_driver ON ride_requests(driver_user_id) WHERE status IN('driver_assigned','driver_en_route','driver_arrived','pin_verified','in_progress');
CREATE TABLE IF NOT EXISTS ride_offers(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 ride_id UUID NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 round INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted','declined','expired','withdrawn')),
 pickup_distance_m INTEGER, expires_at TIMESTAMPTZ NOT NULL,
 responded_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(ride_id,driver_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_offer_per_driver ON ride_offers(driver_user_id) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_offer_per_ride ON ride_offers(ride_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS ride_events(
 id BIGSERIAL PRIMARY KEY,
 ride_id UUID NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 actor_id UUID REFERENCES users(id), event_type TEXT NOT NULL,
 payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ride_events_ride_idx ON ride_events(ride_id,id);
CREATE TABLE IF NOT EXISTS ride_location_samples(
 id BIGSERIAL PRIMARY KEY,
 ride_id UUID REFERENCES ride_requests(id) ON DELETE CASCADE,
 session_id UUID REFERENCES driver_availability_sessions(id) ON DELETE CASCADE,
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
 accuracy_m REAL, heading REAL, speed_mps REAL, seq BIGINT NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ride_loc_ride_idx ON ride_location_samples(ride_id,id);
CREATE TABLE IF NOT EXISTS ride_messages(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 ride_id UUID NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 body TEXT NOT NULL, flagged BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payments, receipts, ledgers
CREATE TABLE IF NOT EXISTS ride_payments(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 ride_id UUID NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 method TEXT NOT NULL CHECK(method IN('cash','mpesa')),
 mode TEXT NOT NULL DEFAULT 'mock' CHECK(mode IN('mock','sandbox','live','cash')),
 amount NUMERIC(10,2) NOT NULL, currency TEXT NOT NULL DEFAULT 'KES',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','initiated','confirmed','failed','cancelled','refund_pending','refunded')),
 provider_ref TEXT, provider_request_id TEXT, phone_masked TEXT NOT NULL DEFAULT '',
 idempotency_key TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ride_payment_provider_ref_uniq ON ride_payments(provider_ref) WHERE provider_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_payment_per_ride ON ride_payments(ride_id) WHERE status IN('pending','initiated');
CREATE TABLE IF NOT EXISTS ride_payment_events(
 id BIGSERIAL PRIMARY KEY,
 payment_id UUID NOT NULL REFERENCES ride_payments(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL, dedupe_key TEXT,
 payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_event_dedupe ON ride_payment_events(payment_id,dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS ride_receipts(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 ride_id UUID NOT NULL UNIQUE REFERENCES ride_requests(id) ON DELETE CASCADE,
 reference TEXT NOT NULL UNIQUE, body JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS driver_earnings_ledger(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 ride_id UUID UNIQUE REFERENCES ride_requests(id) ON DELETE SET NULL,
 gross NUMERIC(10,2) NOT NULL, commission NUMERIC(10,2) NOT NULL, net NUMERIC(10,2) NOT NULL,
 payout_status TEXT NOT NULL DEFAULT 'unsettled' CHECK(payout_status IN('unsettled','processing','paid')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS platform_commission_ledger(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 ride_id UUID UNIQUE REFERENCES ride_requests(id) ON DELETE SET NULL,
 amount NUMERIC(10,2) NOT NULL, pct NUMERIC(5,2) NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safety
CREATE TABLE IF NOT EXISTS trusted_contacts(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, phone TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS trip_share_tokens(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 ride_id UUID NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 token TEXT NOT NULL UNIQUE, revoked BOOLEAN NOT NULL DEFAULT FALSE,
 expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS safety_incidents(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 ride_id UUID REFERENCES ride_requests(id) ON DELETE SET NULL,
 reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN('safety','lost_item','payment','other')),
 description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','reviewing','resolved')),
 resolution_note TEXT NOT NULL DEFAULT '', resolved_by UUID REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ride_ratings(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 ride_id UUID NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 rater_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 ratee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN('rider','driver')),
 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','owner_hidden')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(ride_id,rater_id)
);

-- ════════════════════════════════════════════════════════════════════════════
-- DRIVER FINANCE: commission reserve, receivables/payables, tips, settlements,
-- monthly statements, references, availability hygiene. All additive/idempotent.
-- ════════════════════════════════════════════════════════════════════════════

-- Server-generated unique human-readable references (safe under concurrency)
CREATE TABLE IF NOT EXISTS transaction_reference_sequences(
 kind TEXT PRIMARY KEY,
 next_val BIGINT NOT NULL DEFAULT 1
);

-- Double-entry style operational ledger (source of truth for money movements)
CREATE TABLE IF NOT EXISTS financial_transactions(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 reference TEXT NOT NULL UNIQUE,
 txn_type TEXT NOT NULL,
 ride_id UUID REFERENCES ride_requests(id) ON DELETE SET NULL,
 driver_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
 zone_id UUID REFERENCES geo_areas(id),
 currency TEXT NOT NULL DEFAULT 'KES',
 debit_account TEXT NOT NULL,
 credit_account TEXT NOT NULL,
 amount NUMERIC(12,2) NOT NULL CHECK(amount>=0),
 status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN('posted','pending','reversed')),
 effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 settlement_id UUID,
 provider_ref TEXT,
 idempotency_key TEXT UNIQUE,
 actor_user_id UUID REFERENCES users(id),
 adjustment_of UUID REFERENCES financial_transactions(id),
 meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS fin_txn_driver_idx ON financial_transactions(driver_user_id,created_at);
CREATE INDEX IF NOT EXISTS fin_txn_ride_idx ON financial_transactions(ride_id);

-- Commission Reserve (NOT a consumer wallet; commission cover only)
CREATE TABLE IF NOT EXISTS driver_commission_reserves(
 driver_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(balance>=0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS driver_commission_reserve_entries(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 entry_type TEXT NOT NULL CHECK(entry_type IN('topup','commission_debit','refund','adjustment')),
 status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN('pending','completed','failed','reversed')),
 amount NUMERIC(12,2) NOT NULL CHECK(amount>=0),
 balance_after NUMERIC(12,2),
 reference TEXT NOT NULL UNIQUE,
 ride_id UUID REFERENCES ride_requests(id) ON DELETE SET NULL,
 provider_ref TEXT,
 idempotency_key TEXT UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS reserve_entries_driver_idx ON driver_commission_reserve_entries(driver_user_id,created_at);

-- Driver owes HAPA (cash-ride commission not covered by the reserve)
CREATE TABLE IF NOT EXISTS driver_receivables(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 ride_id UUID REFERENCES ride_requests(id) ON DELETE SET NULL,
 reference TEXT NOT NULL UNIQUE,
 amount NUMERIC(12,2) NOT NULL CHECK(amount>0),
 outstanding NUMERIC(12,2) NOT NULL CHECK(outstanding>=0),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','partially_settled','settled','written_off')),
 source TEXT NOT NULL DEFAULT 'cash_commission',
 idempotency_key TEXT UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS receivables_driver_idx ON driver_receivables(driver_user_id,status);

-- HAPA owes Driver (M-Pesa fare earnings and M-Pesa tips held by HAPA)
CREATE TABLE IF NOT EXISTS driver_payables(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 ride_id UUID REFERENCES ride_requests(id) ON DELETE SET NULL,
 reference TEXT NOT NULL UNIQUE,
 amount NUMERIC(12,2) NOT NULL CHECK(amount>0),
 outstanding NUMERIC(12,2) NOT NULL CHECK(outstanding>=0),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','partially_settled','settled')),
 source TEXT NOT NULL DEFAULT 'mpesa_fare' CHECK(source IN('mpesa_fare','mpesa_tip','adjustment')),
 idempotency_key TEXT UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS payables_driver_idx ON driver_payables(driver_user_id,status);

-- Settlements (bidirectional, immutable when completed; corrections = adjustments)
CREATE TABLE IF NOT EXISTS driver_settlements(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 reference TEXT NOT NULL UNIQUE,
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 direction TEXT NOT NULL CHECK(direction IN('driver_to_hapa','hapa_to_driver')),
 amount NUMERIC(12,2) NOT NULL CHECK(amount>0),
 method TEXT NOT NULL CHECK(method IN('mpesa','bank_transfer','cash_office','reserve_offset','manual_external')),
 external_ref TEXT,
 status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN('pending','completed','disputed','reversed')),
 period TEXT,
 notes TEXT NOT NULL DEFAULT '',
 actor_user_id UUID REFERENCES users(id),
 initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 completed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 idempotency_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS settlements_driver_idx ON driver_settlements(driver_user_id,created_at);
CREATE TABLE IF NOT EXISTS driver_settlement_items(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 settlement_id UUID NOT NULL REFERENCES driver_settlements(id) ON DELETE CASCADE,
 item_type TEXT NOT NULL CHECK(item_type IN('receivable','payable')),
 item_id UUID NOT NULL,
 amount NUMERIC(12,2) NOT NULL CHECK(amount>0),
 UNIQUE(settlement_id,item_type,item_id)
);

-- Payout boundary (real provider integration comes later; no fake success)
CREATE TABLE IF NOT EXISTS driver_payouts(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 reference TEXT NOT NULL UNIQUE,
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 settlement_id UUID REFERENCES driver_settlements(id),
 amount NUMERIC(12,2) NOT NULL CHECK(amount>0),
 method TEXT NOT NULL CHECK(method IN('mpesa_b2c','bank_transfer','manual_external')),
 provider_ref TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','completed','failed','reversed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 completed_at TIMESTAMPTZ
);

-- Tips (separate from fare; 100% driver by default; never in HAPA commission)
CREATE TABLE IF NOT EXISTS ride_tips(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 ride_id UUID NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 rider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 amount NUMERIC(12,2) NOT NULL CHECK(amount>0),
 method TEXT NOT NULL CHECK(method IN('cash','mpesa')),
 status TEXT NOT NULL CHECK(status IN('declared','pending','confirmed','failed')),
 verified_by_hapa BOOLEAN NOT NULL DEFAULT FALSE,
 reference TEXT NOT NULL UNIQUE,
 provider_ref TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS one_tip_per_ride ON ride_tips(ride_id) WHERE status IN('declared','pending','confirmed');

-- Monthly driver statements (Africa/Nairobi months; immutable once finalized)
CREATE TABLE IF NOT EXISTS driver_monthly_statements(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 reference TEXT NOT NULL UNIQUE,
 driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 period_year INTEGER NOT NULL,
 period_month INTEGER NOT NULL CHECK(period_month BETWEEN 1 AND 12),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','ready_for_review','partially_settled','settled','disputed','finalized')),
 opening JSONB NOT NULL DEFAULT '{}'::jsonb,
 closing JSONB NOT NULL DEFAULT '{}'::jsonb,
 summary JSONB NOT NULL DEFAULT '{}'::jsonb,
 issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 finalized_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ,
 UNIQUE(driver_user_id,period_year,period_month)
);
ALTER TABLE driver_monthly_statements ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS driver_monthly_statement_items(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 statement_id UUID NOT NULL REFERENCES driver_monthly_statements(id) ON DELETE CASCADE,
 item_type TEXT NOT NULL CHECK(item_type IN('ride','reserve_entry','settlement','tip','adjustment')),
 ref_id UUID NOT NULL,
 reference TEXT,
 data JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(statement_id,item_type,ref_id)
);

-- Credit/debit notes and adjustments (corrections never edit finalized data)
CREATE TABLE IF NOT EXISTS accounting_adjustments(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 reference TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN('credit_note','debit_note','adjustment')),
 driver_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
 statement_id UUID REFERENCES driver_monthly_statements(id) ON DELETE SET NULL,
 related_reference TEXT,
 amount NUMERIC(12,2) NOT NULL CHECK(amount>=0),
 reason TEXT NOT NULL,
 actor_user_id UUID REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Human-readable references on existing records (backfilled idempotently at boot)
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS ride_reference TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ride_reference_uniq ON ride_requests(ride_reference) WHERE ride_reference IS NOT NULL;
ALTER TABLE fare_quotes ADD COLUMN IF NOT EXISTS reference TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS quote_reference_uniq ON fare_quotes(reference) WHERE reference IS NOT NULL;
ALTER TABLE ride_payments ADD COLUMN IF NOT EXISTS reference TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payment_reference_uniq ON ride_payments(reference) WHERE reference IS NOT NULL;
ALTER TABLE ride_payments ADD COLUMN IF NOT EXISTS cash_confirmation_reference TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS cash_conf_reference_uniq ON ride_payments(cash_confirmation_reference) WHERE cash_confirmation_reference IS NOT NULL;

-- eTIMS boundary (optional fields only; never fabricated)
ALTER TABLE ride_receipts ADD COLUMN IF NOT EXISTS tax_document_status TEXT NOT NULL DEFAULT 'not_a_tax_invoice';
ALTER TABLE ride_receipts ADD COLUMN IF NOT EXISTS etims_invoice_reference TEXT;
ALTER TABLE ride_receipts ADD COLUMN IF NOT EXISTS etims_credit_note_reference TEXT;
ALTER TABLE ride_receipts ADD COLUMN IF NOT EXISTS etims_debit_note_reference TEXT;

-- Availability session hygiene (stale detection, explicit end reasons, pauses)
ALTER TABLE driver_availability_sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE driver_availability_sessions ADD COLUMN IF NOT EXISTS end_reason TEXT;
ALTER TABLE driver_availability_sessions ADD COLUMN IF NOT EXISTS auto_closed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE driver_availability_sessions ADD COLUMN IF NOT EXISTS stale_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE driver_availability_sessions ADD COLUMN IF NOT EXISTS paused_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE driver_availability_sessions ADD COLUMN IF NOT EXISTS last_paused_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS driver_session_events(
 id BIGSERIAL PRIMARY KEY,
 session_id UUID NOT NULL REFERENCES driver_availability_sessions(id) ON DELETE CASCADE,
 event TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS session_events_idx ON driver_session_events(session_id,id);
