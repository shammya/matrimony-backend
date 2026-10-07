-- Sign-in with a phone number and a one-time code, introduced with phone sign-in.
--
-- The phone number already lives on the account (migration 001: phone_e164, phone_verified_at, one
-- account per number per agency). A member who registers with a phone has no email, and a member
-- who registered another way can add or change their number after proving it with a code. That is
-- the only change an account row ever receives from the runtime role, and only to these two
-- columns: roles, status and everything else stay unchangeable from the application.
GRANT UPDATE (phone_e164, phone_verified_at) ON matrimony.accounts TO matrimony_runtime;
