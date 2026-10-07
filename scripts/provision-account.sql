-- Creates an account by hand (the first administrator, or a staff member), without a password.
-- Run with psql -v agency_id=... -v account_id=... -v email=... -v display_name=...
-- -v role=admin -f scripts/provision-account.sql
-- Then give the account a password: npm run auth:set-password -- --agency <uuid> --email <email>
-- Use a trusted operator/migration connection. psql quoted variables escape values.
BEGIN;
SELECT set_config('app.agency_id', :'agency_id', true);
INSERT INTO matrimony.accounts(agency_id,id,role,display_name,email,auth_issuer,auth_subject,status)
VALUES (:'agency_id',:'account_id',:'role',:'display_name',lower(btrim(:'email')),'local',:'account_id','active');
COMMIT;
