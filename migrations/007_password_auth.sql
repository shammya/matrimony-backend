-- Email and password sign-in, introduced with the application's own authentication
-- (docs/design/authentication.md).
--
-- An account is created only after its email address has been proven, so it is stored with the
-- time of that proof. The password lives in its own table, away from the account row that many
-- queries read, and only as an Argon2id hash. The runtime role may create and change a
-- credential; it may not delete one.
ALTER TABLE matrimony.accounts ADD COLUMN email_verified_at timestamptz;
ALTER TABLE matrimony.accounts ADD CONSTRAINT accounts_email_verified_needs_email
    CHECK (email_verified_at IS NULL OR email IS NOT NULL);

CREATE TABLE matrimony.account_credentials (
    agency_id uuid NOT NULL,
    account_id uuid NOT NULL,
    -- Written as [$] because a bare dollar sign followed by a word could open a quoted string.
    password_hash text NOT NULL CHECK (password_hash ~ '^[$]argon2id[$]v=19[$]'),
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, account_id),
    FOREIGN KEY (agency_id, account_id) REFERENCES matrimony.accounts(agency_id, id)
);

ALTER TABLE matrimony.account_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.account_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.account_credentials
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON matrimony.account_credentials
    FOR EACH ROW EXECUTE FUNCTION matrimony.touch_updated_at();

GRANT SELECT, INSERT, UPDATE ON matrimony.account_credentials TO matrimony_runtime;
