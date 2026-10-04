-- DEVELOPMENT ONLY, run as the migration owner after migrations.
-- The public_config below is SAMPLE content (see PublicConfig in docs/api/openapi.yaml).
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
 '{"name":"Marriage Solution BD","branding":{"primaryColor":"#0f766e"},"contact":{"phone":"+880 1XXX-XXXXXX","email":"info@example.com"},"about":{"bn":"(নমুনা) এটি ডেভেলপমেন্টের জন্য একটি নমুনা পরিচিতি। আসল তথ্য এজেন্সি থেকে আসবে।","en":"(Sample) Placeholder text for development. The real content comes from the agency."},"branches":[{"name":{"bn":"নমুনা শাখা 1","en":"Sample branch 1"},"address":{"bn":"নমুনা ঠিকানা, ঢাকা","en":"Sample address, Dhaka"},"phone":"+880 1XXX-XXXXXX","mapUrl":"https://maps.example.com/?q=sample-branch-1"},{"name":{"bn":"নমুনা শাখা 2","en":"Sample branch 2"},"address":{"bn":"নমুনা ঠিকানা, ঢাকা","en":"Sample address, Dhaka"},"phone":"+880 1XXX-XXXXXX","mapUrl":"https://maps.example.com/?q=sample-branch-2"},{"name":{"bn":"নমুনা শাখা 3","en":"Sample branch 3"},"address":{"bn":"নমুনা ঠিকানা, ঢাকা","en":"Sample address, Dhaka"},"phone":"+880 1XXX-XXXXXX","mapUrl":"https://maps.example.com/?q=sample-branch-3"}],"successStories":[{"names":{"bn":"নমুনা দম্পতি 1","en":"Sample couple 1"},"story":{"bn":"নমুনা সাফল্যের গল্প।","en":"A sample success story."},"year":2025},{"names":{"bn":"নমুনা দম্পতি 2","en":"Sample couple 2"},"story":{"bn":"নমুনা সাফল্যের গল্প।","en":"A sample success story."},"year":2025},{"names":{"bn":"নমুনা দম্পতি 3","en":"Sample couple 3"},"story":{"bn":"নমুনা সাফল্যের গল্প।","en":"A sample success story."},"year":2025},{"names":{"bn":"নমুনা দম্পতি 4","en":"Sample couple 4"},"story":{"bn":"নমুনা সাফল্যের গল্প।","en":"A sample success story."},"year":2025},{"names":{"bn":"নমুনা দম্পতি 5","en":"Sample couple 5"},"story":{"bn":"নমুনা সাফল্যের গল্প।","en":"A sample success story."},"year":2025},{"names":{"bn":"নমুনা দম্পতি 6","en":"Sample couple 6"},"story":{"bn":"নমুনা সাফল্যের গল্প।","en":"A sample success story."},"year":2025}]}') ON CONFLICT(id) DO NOTHING;
COMMIT;
-- After creating a real identity at your provider, run a parameterized/operator
-- insert into accounts using its exact issuer/subject, verified phone/email,
-- tenant UUID and intended role. Never auto-promote from OAuth metadata.
