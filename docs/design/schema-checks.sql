-- Run after launch-core-schema.sql in an ISOLATED PostgreSQL test database.
-- Requires a test administrator capable of creating a temporary role.
-- All fixtures and the test role are rolled back. Never target production.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = matrimony, public;

CREATE FUNCTION pg_temp.expect_failure(statement text, expected_state text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = expected_state THEN
            RAISE NOTICE 'PASS expected SQLSTATE %', expected_state;
            RETURN;
        END IF;
        RAISE;
    END;
    RAISE EXCEPTION 'Expected SQLSTATE %, but statement succeeded: %', expected_state, statement;
END;
$$;

INSERT INTO agencies(id, slug, hostname, name) VALUES
('10000000-0000-0000-0000-000000000001', 'agency-a', 'a.example.test', 'Agency A'),
('10000000-0000-0000-0000-000000000002', 'agency-b', 'b.example.test', 'Agency B');

INSERT INTO accounts(agency_id, id, role, display_name, email) VALUES
('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'member', 'A', 'same@example.test'),
('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000102', 'member', 'B', 'same@example.test');
SELECT pg_temp.expect_failure($q$
INSERT INTO accounts(agency_id, role, display_name, email)
VALUES ('10000000-0000-0000-0000-000000000001', 'member', 'Duplicate', 'same@example.test')
$q$, '23505');

INSERT INTO member_profiles(agency_id, id, member_code, created_by_account_id, full_name) VALUES
('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201', 'A1', '00000000-0000-0000-0000-000000000101', 'A1'),
('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000202', 'A2', '00000000-0000-0000-0000-000000000101', 'A2'),
('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000203', 'B1', '00000000-0000-0000-0000-000000000102', 'B1');

SELECT pg_temp.expect_failure($q$
UPDATE member_profiles SET assigned_agent_id = '00000000-0000-0000-0000-000000000102'
WHERE agency_id = '10000000-0000-0000-0000-000000000001' AND member_code = 'A1'
$q$, '23503');
SELECT pg_temp.expect_failure($q$
INSERT INTO recommendations(agency_id, source_profile_id, candidate_profile_id, recommended_by_account_id,
scoring_version, source_profile_version, candidate_profile_version) VALUES
('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201',
'00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000101', 'v1', 1, 1)
$q$, '23503');
SELECT pg_temp.expect_failure($q$
INSERT INTO partner_preferences(agency_id, profile_id, age_min, age_max) VALUES
('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201', 40, 25)
$q$, '23514');

INSERT INTO profile_reviews(agency_id, profile_id, submitted_by_account_id, kind, base_profile_version, proposed_changes)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201',
'00000000-0000-0000-0000-000000000101', 'initial_submission', 1, '{}');
SELECT pg_temp.expect_failure($q$
INSERT INTO profile_reviews(agency_id, profile_id, submitted_by_account_id, kind, base_profile_version, proposed_changes)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201',
'00000000-0000-0000-0000-000000000101', 'field_update', 1, '{}')
$q$, '23505');

INSERT INTO interests(agency_id, sender_profile_id, recipient_profile_id, initiated_by_account_id)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201',
'00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000101');
SELECT pg_temp.expect_failure($q$
INSERT INTO interests(agency_id, sender_profile_id, recipient_profile_id, initiated_by_account_id)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000202',
'00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101')
$q$, '23505');
SELECT pg_temp.expect_failure($q$
INSERT INTO interests(agency_id, sender_profile_id, recipient_profile_id, initiated_by_account_id)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201',
'00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101')
$q$, '23514');

INSERT INTO plans(agency_id, id, code, name_bn, price_minor, duration_days)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000301', 'test', 'পরীক্ষা', 10000, 30);
INSERT INTO orders(agency_id, id, profile_id, created_by_account_id, kind, environment, plan_id,
description, amount_due_minor, duration_days, advanced_search_enabled, idempotency_key)
SELECT '10000000-0000-0000-0000-000000000001', id::uuid, '00000000-0000-0000-0000-000000000201',
'00000000-0000-0000-0000-000000000101', 'subscription', 'sandbox', '00000000-0000-0000-0000-000000000301',
'Test order', 10000, 30, true, gen_random_uuid()
FROM (VALUES ('00000000-0000-0000-0000-000000000401'), ('00000000-0000-0000-0000-000000000402')) v(id);

INSERT INTO agency_payment_accounts(agency_id, id, environment, merchant_reference, credentials_secret_ref)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000601', 'sandbox', 'merchant-test', 'secret-ref-test');
INSERT INTO payment_attempts(agency_id, order_id, environment, method, payment_account_id,
amount_minor, status, provider_payment_id, provider_transaction_id, idempotency_key, confirmed_at)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000401', 'sandbox', 'bkash',
'00000000-0000-0000-0000-000000000601', 10000, 'succeeded', 'provider-payment', 'provider-transaction', gen_random_uuid(), now());
SELECT pg_temp.expect_failure($q$
INSERT INTO payment_attempts(agency_id, order_id, environment, method, payment_account_id,
amount_minor, status, provider_payment_id, provider_transaction_id, idempotency_key, confirmed_at)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000402', 'sandbox', 'bkash',
'00000000-0000-0000-0000-000000000601', 10000, 'succeeded', 'different-payment', 'provider-transaction', gen_random_uuid(), now())
$q$, '23505');
SELECT pg_temp.expect_failure($q$
INSERT INTO payment_attempts(agency_id, order_id, environment, method, amount_minor, recorded_by_account_id, idempotency_key)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000401', 'sandbox', 'cash', -1,
'00000000-0000-0000-0000-000000000101', gen_random_uuid())
$q$, '23514');
SELECT pg_temp.expect_failure($q$
INSERT INTO payment_attempts(agency_id, order_id, environment, method, amount_minor, recorded_by_account_id, idempotency_key)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000401', 'live', 'cash', 10000,
'00000000-0000-0000-0000-000000000101', gen_random_uuid())
$q$, '23503');

INSERT INTO subscriptions(agency_id, id, profile_id, order_id, environment, starts_at, ends_at)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000501',
'00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000401', 'sandbox', '2026-10-01Z', '2026-11-01Z');
SELECT pg_temp.expect_failure($q$
INSERT INTO subscriptions(agency_id, profile_id, order_id, environment, starts_at, ends_at)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201',
'00000000-0000-0000-0000-000000000402', 'sandbox', '2026-10-15Z', '2026-11-15Z')
$q$, '23P01');
-- Adjacent renewal is allowed, proving half-open interval behavior.
INSERT INTO subscriptions(agency_id, profile_id, order_id, environment, starts_at, ends_at)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201',
'00000000-0000-0000-0000-000000000402', 'sandbox', '2026-11-01Z', '2026-12-01Z');

INSERT INTO feature_usage(agency_id, profile_id, target_profile_id, environment, feature, period_start, period_end)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201',
'00000000-0000-0000-0000-000000000202', 'sandbox', 'profile_view', '2026-09-01Z', '2026-10-01Z');
SELECT pg_temp.expect_failure($q$
INSERT INTO feature_usage(agency_id, profile_id, target_profile_id, environment, feature, period_start, period_end)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201',
'00000000-0000-0000-0000-000000000202', 'sandbox', 'profile_view', '2026-09-01Z', '2026-10-01Z')
$q$, '23505');

-- Validate FORCE RLS with a non-owner, non-bypass runtime role.
CREATE ROLE matrimony_schema_test_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA matrimony TO matrimony_schema_test_runtime;
GRANT EXECUTE ON FUNCTION matrimony.current_agency_id() TO matrimony_schema_test_runtime;
GRANT SELECT, INSERT ON matrimony.member_profiles TO matrimony_schema_test_runtime;
SET LOCAL ROLE matrimony_schema_test_runtime;
SET LOCAL app.agency_id = '';
DO $$ BEGIN
    IF (SELECT count(*) FROM matrimony.member_profiles) <> 0 THEN RAISE EXCEPTION 'Unset tenant leaked rows'; END IF;
    RAISE NOTICE 'PASS unset tenant sees no rows';
END $$;
SET LOCAL app.agency_id = '10000000-0000-0000-0000-000000000001';
DO $$ BEGIN
    IF (SELECT count(*) FROM matrimony.member_profiles) <> 2 THEN RAISE EXCEPTION 'Tenant A isolation failed'; END IF;
    RAISE NOTICE 'PASS tenant A sees exactly its two profiles';
END $$;
DO $$ BEGIN
    BEGIN
        INSERT INTO matrimony.member_profiles(agency_id, member_code, created_by_account_id, full_name)
        VALUES ('10000000-0000-0000-0000-000000000002', 'forbidden', '00000000-0000-0000-0000-000000000102', 'Forbidden');
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'PASS cross-tenant insert denied by RLS'; RETURN;
    END;
    RAISE EXCEPTION 'RLS allowed cross-tenant insert';
END $$;
RESET ROLE;
DO $$ BEGIN
    IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'matrimony' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity) <> 17
    THEN RAISE EXCEPTION 'Not all 17 tables have forced RLS'; END IF;
    RAISE NOTICE 'PASS all 17 tables have forced RLS';
END $$;
ROLLBACK;
\echo 'Schema checks completed; fixtures and test role rolled back.'
