CREATE TABLE matrimony.event_outbox (
 agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
 id uuid NOT NULL, event jsonb NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz,
 delivered_at timestamptz, last_error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (agency_id,id), UNIQUE(id),
 CHECK (event->>'agencyId' = agency_id::text AND event->>'id' = id::text)
);
CREATE INDEX event_outbox_due ON matrimony.event_outbox(agency_id,next_attempt_at) WHERE delivered_at IS NULL;
ALTER TABLE matrimony.event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.event_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.event_outbox
 USING (agency_id=matrimony.current_agency_id()) WITH CHECK (agency_id=matrimony.current_agency_id());
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='matrimony_runtime') THEN
   CREATE ROLE matrimony_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA matrimony TO matrimony_runtime;
GRANT EXECUTE ON FUNCTION matrimony.current_agency_id() TO matrimony_runtime;
GRANT SELECT ON matrimony.agencies,matrimony.accounts TO matrimony_runtime;
GRANT SELECT,INSERT,UPDATE ON matrimony.event_outbox TO matrimony_runtime;
-- Domain write grants are introduced with their authorized use cases.
