-- PostgreSQL 15+ reference DDL, not an application migration.
-- Apply only to an empty development database after reviewing core-entities.md.
-- Business authorization, OTP, checkout and approval transactions are contracts
-- documented alongside this schema; tenant RLS alone does not implement them.
BEGIN;
CREATE SCHEMA matrimony;
CREATE EXTENSION IF NOT EXISTS btree_gist;
SET LOCAL search_path = matrimony, public;

CREATE TABLE agencies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    hostname text NOT NULL UNIQUE CHECK (hostname = lower(hostname)),
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    default_locale text NOT NULL DEFAULT 'bn' CHECK (default_locale IN ('bn', 'en')),
    timezone text NOT NULL DEFAULT 'Asia/Dhaka',
    public_config jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(public_config) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    role text NOT NULL CHECK (role IN ('admin', 'agent', 'member')),
    display_name text NOT NULL,
    phone_e164 text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    email text CHECK (email = lower(btrim(email)) AND email <> ''),
    phone_verified_at timestamptz,
    auth_issuer text,
    auth_subject text,
    status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
    locale text NOT NULL DEFAULT 'bn' CHECK (locale IN ('bn', 'en')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, phone_e164),
    UNIQUE (agency_id, email),
    UNIQUE (agency_id, auth_issuer, auth_subject),
    CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL),
    CHECK ((auth_issuer IS NULL) = (auth_subject IS NULL)),
    CHECK (phone_verified_at IS NULL OR phone_e164 IS NOT NULL),
    CHECK (status <> 'active' OR auth_subject IS NOT NULL)
);

CREATE TABLE member_profiles (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    member_code text NOT NULL,
    owner_account_id uuid,
    created_by_account_id uuid NOT NULL,
    assigned_agent_id uuid,
    service_mode text NOT NULL DEFAULT 'self_service' CHECK (service_mode IN ('self_service', 'assisted')),
    managed_for text NOT NULL DEFAULT 'self' CHECK (managed_for IN ('self', 'child', 'sibling', 'relative', 'other')),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_review', 'rejected', 'active', 'paused', 'matched', 'closed')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    full_name text NOT NULL,
    date_of_birth date,
    gender text CHECK (gender IN ('male', 'female')),
    marital_status text CHECK (marital_status IN ('never_married', 'divorced', 'widowed')),
    height_cm smallint CHECK (height_cm BETWEEN 50 AND 300),
    weight_kg smallint CHECK (weight_kg BETWEEN 20 AND 500),
    complexion_code text,
    blood_group text,
    nationality_code text NOT NULL DEFAULT 'BD',
    religion_code text,
    sect_code text,
    current_city text,
    current_district_code text,
    current_division_code text,
    origin_district_code text,
    highest_degree_code text,
    institution_name text,
    field_of_study text,
    graduation_year smallint,
    occupation_code text,
    job_title text,
    employer_name text,
    monthly_income_band_code text,
    father_name text,
    father_occupation text,
    mother_name text,
    mother_occupation text,
    sibling_count smallint CHECK (sibling_count >= 0),
    family_status_code text,
    religious_practice_code text,
    dietary_preference_code text,
    hobbies text,
    about_me text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, member_code),
    UNIQUE (agency_id, owner_account_id),
    FOREIGN KEY (agency_id, owner_account_id) REFERENCES accounts(agency_id, id),
    FOREIGN KEY (agency_id, created_by_account_id) REFERENCES accounts(agency_id, id),
    FOREIGN KEY (agency_id, assigned_agent_id) REFERENCES accounts(agency_id, id)
);

-- Separate storage makes accidental contact exposure through search less likely.
CREATE TABLE profile_contacts (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    profile_id uuid NOT NULL,
    contact_name text,
    contact_relationship text,
    phone_e164 text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    email text,
    permanent_address text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, profile_id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES member_profiles(agency_id, id)
);

CREATE TABLE partner_preferences (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    profile_id uuid NOT NULL,
    age_min smallint CHECK (age_min >= 18),
    age_max smallint CHECK (age_max >= 18),
    height_min_cm smallint CHECK (height_min_cm BETWEEN 50 AND 300),
    height_max_cm smallint CHECK (height_max_cm BETWEEN 50 AND 300),
    religion_codes text[] NOT NULL DEFAULT '{}',
    sect_codes text[] NOT NULL DEFAULT '{}',
    marital_status_codes text[] NOT NULL DEFAULT '{}',
    education_min_code text,
    occupation_codes text[] NOT NULL DEFAULT '{}',
    district_codes text[] NOT NULL DEFAULT '{}',
    income_min_band_code text,
    income_max_band_code text,
    family_status_min_code text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, profile_id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES member_profiles(agency_id, id),
    CHECK (age_min IS NULL OR age_max IS NULL OR age_min <= age_max),
    CHECK (height_min_cm IS NULL OR height_max_cm IS NULL OR height_min_cm <= height_max_cm)
);

CREATE TABLE profile_photos (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    storage_key text NOT NULL,
    mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
    uploaded_by_account_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'published', 'removed')),
    sort_order smallint NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, id, profile_id),
    UNIQUE (agency_id, storage_key),
    FOREIGN KEY (agency_id, profile_id) REFERENCES member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, uploaded_by_account_id) REFERENCES accounts(agency_id, id),
    CHECK (storage_key LIKE agency_id::text || '/' || profile_id::text || '/%'),
    CHECK (NOT is_primary OR status = 'published')
);
CREATE UNIQUE INDEX one_primary_photo ON profile_photos(agency_id, profile_id)
    WHERE is_primary AND status = 'published';

CREATE TABLE profile_reviews (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    submitted_by_account_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('initial_submission', 'field_update', 'photo_add', 'photo_remove')),
    base_profile_version integer,
    proposed_changes jsonb,
    photo_id uuid,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    reviewer_account_id uuid,
    reviewer_notes text,
    reviewed_at timestamptz,
    cancelled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, photo_id, profile_id) REFERENCES profile_photos(agency_id, id, profile_id),
    FOREIGN KEY (agency_id, submitted_by_account_id) REFERENCES accounts(agency_id, id),
    FOREIGN KEY (agency_id, reviewer_account_id) REFERENCES accounts(agency_id, id),
    CHECK ((kind IN ('initial_submission', 'field_update') AND photo_id IS NULL
            AND base_profile_version IS NOT NULL AND base_profile_version > 0
            AND proposed_changes IS NOT NULL AND jsonb_typeof(proposed_changes) = 'object')
        OR (kind IN ('photo_add', 'photo_remove') AND photo_id IS NOT NULL
            AND base_profile_version IS NULL AND proposed_changes IS NULL)),
    CHECK ((status IN ('approved', 'rejected') AND reviewer_account_id IS NOT NULL AND reviewed_at IS NOT NULL)
        OR (status IN ('pending', 'cancelled') AND reviewer_account_id IS NULL AND reviewed_at IS NULL)),
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_profile_review ON profile_reviews(agency_id, profile_id)
    WHERE status = 'pending' AND kind IN ('initial_submission', 'field_update');
CREATE UNIQUE INDEX one_pending_photo_review ON profile_reviews(agency_id, photo_id)
    WHERE status = 'pending' AND photo_id IS NOT NULL;

CREATE TABLE recommendations (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    source_profile_id uuid NOT NULL,
    candidate_profile_id uuid NOT NULL,
    recommended_by_account_id uuid NOT NULL,
    compatibility_score smallint CHECK (compatibility_score BETWEEN 0 AND 100),
    scoring_version text NOT NULL,
    score_explanation jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(score_explanation) = 'object'),
    source_profile_version integer NOT NULL CHECK (source_profile_version > 0),
    candidate_profile_version integer NOT NULL CHECK (candidate_profile_version > 0),
    member_visible_note text,
    internal_note text,
    published_at timestamptz,
    withdrawn_at timestamptz,
    member_response text NOT NULL DEFAULT 'pending' CHECK (member_response IN ('pending', 'interested', 'declined')),
    member_feedback text,
    responded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, source_profile_id, candidate_profile_id),
    FOREIGN KEY (agency_id, source_profile_id) REFERENCES member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, candidate_profile_id) REFERENCES member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, recommended_by_account_id) REFERENCES accounts(agency_id, id),
    CHECK (source_profile_id <> candidate_profile_id),
    CHECK ((member_response = 'pending') = (responded_at IS NULL)),
    CHECK (member_response = 'pending' OR published_at IS NOT NULL)
);

-- One relationship per unordered pair. Accepted means mutual interest, not marriage.
CREATE TABLE interests (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    sender_profile_id uuid NOT NULL,
    recipient_profile_id uuid NOT NULL,
    initiated_by_account_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
    sender_contact_consent_at timestamptz,
    recipient_contact_consent_at timestamptz,
    responded_by_account_id uuid,
    responded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, sender_profile_id) REFERENCES member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, recipient_profile_id) REFERENCES member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, initiated_by_account_id) REFERENCES accounts(agency_id, id),
    FOREIGN KEY (agency_id, responded_by_account_id) REFERENCES accounts(agency_id, id),
    CHECK (sender_profile_id <> recipient_profile_id),
    CHECK ((status IN ('accepted', 'declined') AND responded_at IS NOT NULL AND responded_by_account_id IS NOT NULL)
        OR (status IN ('pending', 'withdrawn')))
);
CREATE UNIQUE INDEX one_interest_pair ON interests(
    agency_id, least(sender_profile_id, recipient_profile_id), greatest(sender_profile_id, recipient_profile_id)
);

CREATE TABLE plans (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    code text NOT NULL,
    name_bn text NOT NULL,
    name_en text,
    description_bn text,
    description_en text,
    price_minor bigint NOT NULL CHECK (price_minor >= 0),
    currency text NOT NULL DEFAULT 'BDT' CHECK (currency = 'BDT'),
    duration_days integer NOT NULL CHECK (duration_days > 0),
    profile_view_limit integer CHECK (profile_view_limit >= 0),
    contact_view_limit integer CHECK (contact_view_limit >= 0),
    advanced_search_enabled boolean NOT NULL DEFAULT false,
    is_default boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, code),
    CHECK (NOT is_default OR (price_minor = 0 AND is_active))
);
CREATE UNIQUE INDEX one_default_plan ON plans(agency_id) WHERE is_default;

CREATE TABLE agency_payment_accounts (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    provider text NOT NULL DEFAULT 'bkash' CHECK (provider = 'bkash'),
    environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
    merchant_reference text NOT NULL,
    credentials_secret_ref text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, id, environment),
    UNIQUE (agency_id, provider, environment, merchant_reference)
);
CREATE UNIQUE INDEX one_active_merchant ON agency_payment_accounts(agency_id, provider, environment)
    WHERE is_active;

CREATE TABLE orders (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    created_by_account_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('subscription', 'assisted_service')),
    environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
    plan_id uuid,
    description text NOT NULL,
    amount_due_minor bigint NOT NULL CHECK (amount_due_minor > 0),
    upfront_due_minor bigint CHECK (upfront_due_minor >= 0 AND upfront_due_minor <= amount_due_minor),
    currency text NOT NULL DEFAULT 'BDT' CHECK (currency = 'BDT'),
    duration_days integer,
    profile_view_limit integer CHECK (profile_view_limit >= 0),
    contact_view_limit integer CHECK (contact_view_limit >= 0),
    advanced_search_enabled boolean,
    idempotency_key uuid NOT NULL,
    cancelled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, id, environment),
    UNIQUE (agency_id, id, profile_id, environment),
    UNIQUE (agency_id, environment, idempotency_key),
    FOREIGN KEY (agency_id, profile_id) REFERENCES member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, created_by_account_id) REFERENCES accounts(agency_id, id),
    FOREIGN KEY (agency_id, plan_id) REFERENCES plans(agency_id, id),
    CHECK ((kind = 'subscription' AND plan_id IS NOT NULL AND duration_days IS NOT NULL AND duration_days > 0
                AND advanced_search_enabled IS NOT NULL AND upfront_due_minor IS NULL)
        OR (kind = 'assisted_service' AND plan_id IS NULL AND duration_days IS NULL
                AND profile_view_limit IS NULL AND contact_view_limit IS NULL AND advanced_search_enabled IS NULL))
);

-- Successful rows are receipts; unsuccessful rows preserve checkout attempts.
CREATE TABLE payment_attempts (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL,
    environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
    method text NOT NULL CHECK (method IN ('bkash', 'cash', 'bank_transfer')),
    payment_account_id uuid,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    currency text NOT NULL DEFAULT 'BDT' CHECK (currency = 'BDT'),
    status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'pending', 'unknown', 'succeeded', 'failed', 'cancelled')),
    provider_payment_id text,
    provider_transaction_id text,
    external_reference text,
    idempotency_key uuid NOT NULL,
    recorded_by_account_id uuid,
    confirmed_at timestamptz,
    failure_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, environment, idempotency_key),
    UNIQUE (agency_id, payment_account_id, provider_payment_id),
    UNIQUE (agency_id, payment_account_id, provider_transaction_id),
    FOREIGN KEY (agency_id, order_id, environment) REFERENCES orders(agency_id, id, environment),
    FOREIGN KEY (agency_id, payment_account_id, environment) REFERENCES agency_payment_accounts(agency_id, id, environment),
    FOREIGN KEY (agency_id, recorded_by_account_id) REFERENCES accounts(agency_id, id),
    CHECK ((method = 'bkash' AND payment_account_id IS NOT NULL)
        OR (method IN ('cash', 'bank_transfer') AND payment_account_id IS NULL
            AND recorded_by_account_id IS NOT NULL AND provider_payment_id IS NULL AND provider_transaction_id IS NULL)),
    CHECK (status <> 'succeeded' OR confirmed_at IS NOT NULL),
    CHECK (status <> 'succeeded' OR method <> 'bkash'
        OR (provider_payment_id IS NOT NULL AND provider_transaction_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_unresolved_checkout ON payment_attempts(agency_id, order_id)
    WHERE method = 'bkash' AND status IN ('created', 'pending', 'unknown');

CREATE TABLE subscriptions (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    order_id uuid NOT NULL,
    environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, order_id),
    UNIQUE (agency_id, id, profile_id, environment),
    FOREIGN KEY (agency_id, profile_id) REFERENCES member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, order_id, profile_id, environment) REFERENCES orders(agency_id, id, profile_id, environment),
    CHECK (ends_at > starts_at),
    EXCLUDE USING gist (
        agency_id WITH =, profile_id WITH =, environment WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (revoked_at IS NULL)
);

CREATE TABLE feature_usage (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    target_profile_id uuid NOT NULL,
    subscription_id uuid,
    environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
    feature text NOT NULL CHECK (feature IN ('profile_view', 'contact_view')),
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE NULLS NOT DISTINCT (agency_id, profile_id, environment, subscription_id, period_start, feature, target_profile_id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, target_profile_id) REFERENCES member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, subscription_id, profile_id, environment) REFERENCES subscriptions(agency_id, id, profile_id, environment),
    CHECK (profile_id <> target_profile_id),
    CHECK (period_end > period_start)
);

CREATE TABLE notifications (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    recipient_account_id uuid NOT NULL,
    event_key text NOT NULL,
    template_key text NOT NULL,
    template_version integer NOT NULL DEFAULT 1 CHECK (template_version > 0),
    payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, recipient_account_id, event_key),
    FOREIGN KEY (agency_id, recipient_account_id) REFERENCES accounts(agency_id, id)
);

CREATE TABLE consent_events (
    agency_id uuid NOT NULL REFERENCES agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL,
    profile_id uuid,
    purpose text NOT NULL CHECK (purpose IN ('terms', 'privacy', 'profile_representation')),
    document_version text NOT NULL,
    action text NOT NULL CHECK (action IN ('accepted', 'withdrawn')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, account_id) REFERENCES accounts(agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES member_profiles(agency_id, id)
);

CREATE INDEX profiles_discovery ON member_profiles(agency_id, gender, date_of_birth)
    WHERE status = 'active';
CREATE INDEX profiles_location ON member_profiles(agency_id, current_district_code) WHERE status = 'active';
CREATE INDEX profiles_agent ON member_profiles(agency_id, assigned_agent_id, status);
CREATE INDEX reviews_queue ON profile_reviews(agency_id, status, created_at);
CREATE INDEX photos_profile ON profile_photos(agency_id, profile_id, status, sort_order);
CREATE INDEX recommendations_candidate ON recommendations(agency_id, candidate_profile_id);
CREATE INDEX interests_received ON interests(agency_id, recipient_profile_id, status);
CREATE INDEX interests_sent ON interests(agency_id, sender_profile_id, status);
CREATE INDEX orders_profile ON orders(agency_id, profile_id, created_at);
CREATE INDEX payments_order ON payment_attempts(agency_id, order_id, status);
CREATE INDEX notifications_inbox ON notifications(agency_id, recipient_account_id, created_at DESC);

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
CREATE FUNCTION bump_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.version := OLD.version + 1;
    RETURN NEW;
END;
$$;
CREATE TRIGGER profile_version BEFORE UPDATE ON member_profiles
    FOR EACH ROW EXECUTE FUNCTION bump_profile_version();

-- Tenant context is set by a trusted backend within EACH database transaction.
-- Do not expose this role to browsers; custom settings are not authentication.
CREATE FUNCTION current_agency_id() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.agency_id', true), '')::uuid
$$;
ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agencies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agencies
    USING (id = matrimony.current_agency_id()) WITH CHECK (id = matrimony.current_agency_id());

DO $$
DECLARE relation_name text;
BEGIN
    FOR relation_name IN SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'matrimony' AND table_type = 'BASE TABLE' AND table_name <> 'agencies'
    LOOP
        EXECUTE format('ALTER TABLE matrimony.%I ENABLE ROW LEVEL SECURITY', relation_name);
        EXECUTE format('ALTER TABLE matrimony.%I FORCE ROW LEVEL SECURITY', relation_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON matrimony.%I USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id())', relation_name);
    END LOOP;
    FOR relation_name IN SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'matrimony' AND column_name = 'updated_at'
    LOOP
        EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON matrimony.%I FOR EACH ROW EXECUTE FUNCTION matrimony.touch_updated_at()', relation_name);
    END LOOP;
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA matrimony FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA matrimony FROM PUBLIC;
-- Deliberately no runtime GRANTs: grant the chosen backend role least privilege
-- when implementing role/ownership rules and controlled payment/approval writes.
COMMIT;
