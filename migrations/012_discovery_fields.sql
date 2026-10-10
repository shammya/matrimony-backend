-- More detailed biodata and partner preferences, introduced with the discovery loop (slice 3.A,
-- docs/features/discovery-loop.md). A client is matched on these fields, and an agent reviews
-- the candidates, so a profession such as "doctor" must be a coded value; the existing
-- occupation field is only a type (salaried, business ...).
--
-- Additive and backward compatible: every new column is nullable (profile) or an empty list
-- (preferences), so existing rows stay valid. The values are permanent codes defined in
-- src/bo/dictionaries.ts and are validated by the application, like the existing code columns.
-- The table grants of migration 003 already cover new columns.
ALTER TABLE matrimony.member_profiles
    ADD COLUMN profession_code text,
    ADD COLUMN smoking_code text,
    ADD COLUMN children_code text,
    ADD COLUMN relocation_code text;

ALTER TABLE matrimony.partner_preferences
    ADD COLUMN profession_codes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN complexion_codes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN religious_practice_codes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN dietary_preference_codes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN smoking_codes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN children_codes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN relocation_codes text[] NOT NULL DEFAULT '{}';
