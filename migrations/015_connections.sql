-- Connection requests and the inbox (slice 3.F, docs/features/discovery-loop.md).
--
-- The design already exists in 001_domain.sql and is used as it is:
--   interests      one row per pair of profiles (the unique index one_interest_pair), whichever of the
--                  two asked first, with pending / accepted / declined / withdrawn, who answered, and
--                  a contact-consent timestamp for each side.
--   notifications  one inbox line per recipient and event, with a template key and a payload.
-- A client asks someone in their window. Two people asking each other end as one accepted pair. A
-- declined pair stays declined. A withdrawn request can be asked again, which reuses the row.
--
-- 001 deliberately granted the runtime role nothing. This gives it what the feature needs and no more:
-- it may add rows and change the columns that move an interest along, it may add and read
-- notifications, and it may delete nothing, so what happened between two people stays on record.

-- Contact details are only ever shared inside an accepted connection.
ALTER TABLE matrimony.interests
    ADD CONSTRAINT interests_contact_only_when_accepted
    CHECK (status = 'accepted'
           OR (sender_contact_consent_at IS NULL AND recipient_contact_consent_at IS NULL));

GRANT SELECT, INSERT ON matrimony.interests TO matrimony_runtime;
GRANT UPDATE (sender_profile_id, recipient_profile_id, initiated_by_account_id, status,
              sender_contact_consent_at, recipient_contact_consent_at, responded_by_account_id,
              responded_at, created_at, updated_at)
    ON matrimony.interests TO matrimony_runtime;

-- A notification is only ever added and read: there is no read or unread state in the first release.
GRANT SELECT, INSERT ON matrimony.notifications TO matrimony_runtime;
