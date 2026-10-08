-- Adding an email to an account that has none (a member who registered with a phone number).
--
-- The address is proven by a link sent to it, after the owner proved who they are with a code sent
-- to their own phone. The runtime role may then write these two columns of the account, and only
-- these two (with the phone columns from migration 009): roles, status and the rest of the row stay
-- unchangeable from the application. The statement that writes them only applies to an account that
-- has no email yet, so an existing address is never replaced here.
GRANT UPDATE (email, email_verified_at) ON matrimony.accounts TO matrimony_runtime;
