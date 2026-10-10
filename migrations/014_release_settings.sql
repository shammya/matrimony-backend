-- What a client may see, set by staff (slice 3.C, docs/features/discovery-loop.md).
--
-- One row per client: how many released profiles the client's window holds (the cap) and which
-- fields of those profiles are shown to them. A client with no row has the defaults written in
-- src/bo/release.ts. The runtime role may add a row and change its values, never delete it.
CREATE TABLE matrimony.client_release_settings (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    client_profile_id uuid NOT NULL,
    cap smallint NOT NULL CHECK (cap BETWEEN 1 AND 200),
    visible_fields text[] NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, client_profile_id),
    FOREIGN KEY (agency_id, client_profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, updated_by) REFERENCES matrimony.accounts(agency_id, id)
);

ALTER TABLE matrimony.client_release_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.client_release_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.client_release_settings
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.client_release_settings TO matrimony_runtime;
GRANT UPDATE (cap, visible_fields, updated_by, updated_at)
    ON matrimony.client_release_settings TO matrimony_runtime;
