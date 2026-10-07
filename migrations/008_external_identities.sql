-- Sign-in with Google (and later other providers), introduced with the Google login.
--
-- An account may be reachable by a Google identity as well as, or instead of, a password. The
-- identity is the provider's stable subject (never the email, which can change), and it belongs
-- to one account per agency. The runtime role may add one and read them; it may not change or
-- delete one here.
CREATE TABLE matrimony.account_identities (
    agency_id uuid NOT NULL,
    account_id uuid NOT NULL,
    provider text NOT NULL CHECK (provider IN ('google')),
    provider_subject text NOT NULL CHECK (provider_subject <> ''),
    -- The address the provider vouched for when the identity was linked, kept for audit.
    email text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, provider, provider_subject),
    UNIQUE (agency_id, account_id, provider),
    FOREIGN KEY (agency_id, account_id) REFERENCES matrimony.accounts(agency_id, id)
);

ALTER TABLE matrimony.account_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.account_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.account_identities
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.account_identities TO matrimony_runtime;
