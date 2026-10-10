-- Candidate lists for the discovery loop (slice 3.B, docs/features/candidate-generation.md).
--
-- Staff press "Find candidates" for a client (or an approval triggers it) and the system saves the
-- best-fitting published profiles as proposals for that client. Staff review them later (slice 3.C);
-- the client never sees a row of this table. There is one row per client and candidate:
--   proposed  the system suggests it and staff have not decided
--   lapsed    it was proposed once but no longer ranks among the best (it can come back)
--   released  staff released it to the client (slice 3.C)
--   removed   staff removed it; it never comes back
-- The runtime role may add rows and change the columns that move one along. It may not delete a
-- row, so what staff decided stays on record.
CREATE TABLE matrimony.client_candidates (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    client_profile_id uuid NOT NULL,
    candidate_profile_id uuid NOT NULL,
    state text NOT NULL DEFAULT 'proposed'
        CHECK (state IN ('proposed', 'lapsed', 'released', 'removed')),
    -- How well the two profiles fit each other's preferences, summed over both directions.
    met_count smallint NOT NULL CHECK (met_count >= 0),
    unmet_count smallint NOT NULL CHECK (unmet_count >= 0),
    unknown_count smallint NOT NULL CHECK (unknown_count >= 0),
    -- {"forward": [{"key": "age", "outcome": "met"}, ...], "reverse": [...]}
    criteria jsonb NOT NULL,
    proposed_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    decided_by uuid,
    decided_at timestamptz,
    PRIMARY KEY (agency_id, client_profile_id, candidate_profile_id),
    FOREIGN KEY (agency_id, client_profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, candidate_profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, decided_by) REFERENCES matrimony.accounts(agency_id, id),
    CHECK (client_profile_id <> candidate_profile_id),
    CHECK ((decided_by IS NULL) = (decided_at IS NULL))
);

CREATE INDEX client_candidates_by_client
    ON matrimony.client_candidates (agency_id, client_profile_id, state);

ALTER TABLE matrimony.client_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.client_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.client_candidates
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.client_candidates TO matrimony_runtime;
GRANT UPDATE (state, met_count, unmet_count, unknown_count, criteria, proposed_at, updated_at,
              decided_by, decided_at)
    ON matrimony.client_candidates TO matrimony_runtime;
