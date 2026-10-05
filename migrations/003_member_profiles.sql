-- Profile write access, introduced with feature 2.1 (My Profile).
-- The runtime role may read and change profiles, their private contact details, their partner
-- preferences and their review requests. It may not delete any of them: a profile is closed,
-- never erased. Who may change which profile is enforced by the application (an owner reaches
-- only their own), and row-level security keeps every agency to its own rows.
GRANT SELECT, INSERT, UPDATE ON
  matrimony.member_profiles,
  matrimony.profile_contacts,
  matrimony.partner_preferences,
  matrimony.profile_reviews
TO matrimony_runtime;
