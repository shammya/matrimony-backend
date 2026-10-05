-- Photo write access, introduced with the photos part of feature 2.1.
-- The runtime role may read and change photo rows. It may not delete them: a removed photo is
-- marked removed and its files are deleted from storage. Row-level security keeps every agency
-- to its own photos, and the application lets a member reach only their own.
GRANT SELECT, INSERT, UPDATE ON matrimony.profile_photos TO matrimony_runtime;
