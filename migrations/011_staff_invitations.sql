-- Inviting staff, introduced with feature 4.3 ("authorized staff provisioned").
--
-- An admin invites a person by email as an agent or an admin. The person opens the emailed link,
-- chooses a password and the account is created then, with the role written here. Only a hash of
-- the link's secret is kept, so a copy of this table cannot be used to accept an invitation. An
-- invitation is open until it is accepted or cancelled, and there is at most one open invitation
-- per email address: inviting the same address again replaces it (new link, new expiry).
--
-- The runtime role may add an invitation and change the columns that move one along. It may not
-- delete one, so what was offered and to whom stays on record.
CREATE TABLE matrimony.staff_invitations (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    email text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
    display_name text NOT NULL CHECK (btrim(display_name) <> ''),
    role text NOT NULL CHECK (role IN ('admin', 'agent')),
    locale text NOT NULL CHECK (locale IN ('bn', 'en')),
    invited_by uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    accepted_account_id uuid,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, invited_by) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, accepted_account_id) REFERENCES matrimony.accounts(agency_id, id),
    CHECK (accepted_at IS NULL OR revoked_at IS NULL),
    CHECK ((accepted_at IS NULL) = (accepted_account_id IS NULL))
);

CREATE UNIQUE INDEX staff_invitations_token_hash ON matrimony.staff_invitations (token_hash);
CREATE UNIQUE INDEX staff_invitations_one_open_per_email
    ON matrimony.staff_invitations (agency_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE matrimony.staff_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.staff_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.staff_invitations
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.staff_invitations TO matrimony_runtime;
GRANT UPDATE (display_name, role, locale, invited_by, token_hash, expires_at, created_at,
              accepted_at, accepted_account_id, revoked_at)
    ON matrimony.staff_invitations TO matrimony_runtime;
