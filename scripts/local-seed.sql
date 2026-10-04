-- DEVELOPMENT ONLY, run as the migration owner after migrations.
-- Known local password; production roles/secrets must be provisioned separately.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='matrimony_app') THEN
   CREATE ROLE matrimony_app LOGIN PASSWORD 'local_app_password' NOSUPERUSER NOBYPASSRLS;
 END IF;
END $$;
GRANT matrimony_runtime TO matrimony_app;
BEGIN;
SELECT set_config('app.agency_id','11111111-1111-4111-8111-111111111111',true);
INSERT INTO matrimony.agencies(id,slug,hostname,name,public_config)
 VALUES ('11111111-1111-4111-8111-111111111111','msbd','localhost','Marriage Solution BD',
 '{"name":"Marriage Solution BD","branches":[],"successStories":[]}') ON CONFLICT(id) DO NOTHING;
COMMIT;
-- After creating a real identity at your provider, run a parameterized/operator
-- insert into accounts using its exact issuer/subject, verified phone/email,
-- tenant UUID and intended role. Never auto-promote from OAuth metadata.
