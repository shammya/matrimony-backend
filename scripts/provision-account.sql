-- Run with psql -v agency_id=... -v account_id=... -v issuer=... -v subject=...
-- -v email=... -v display_name=... -v role=member -f scripts/provision-account.sql
-- Use a trusted operator/migration connection. psql quoted variables escape values.
BEGIN;
SELECT set_config('app.agency_id', :'agency_id', true);
INSERT INTO matrimony.accounts(agency_id,id,role,display_name,email,auth_issuer,auth_subject,status)
VALUES (:'agency_id',:'account_id',:'role',:'display_name',lower(btrim(:'email')),:'issuer',:'subject','active');
COMMIT;
