-- Registration of new members, introduced with feature 1.2.
-- The runtime role may create an account and record consent. It may not change or delete an
-- account here: roles are never set by registration (the application only ever creates a member),
-- and consent is an append-only record, so a withdrawal is a new row, never an edit.
GRANT INSERT ON matrimony.accounts TO matrimony_runtime;
GRANT SELECT, INSERT ON matrimony.consent_events TO matrimony_runtime;
