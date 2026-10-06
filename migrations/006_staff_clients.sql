-- Client management by staff, introduced with feature 4.3.
--
-- Handing a profile to another agent changes who looks after it, not what it says. The version is
-- what a waiting review is judged against ("the profile is exactly as it was when the request was
-- made"), so changing only the assigned agent must not raise it and make every waiting request look
-- out of date. Every other update still raises it, exactly as before (including an update that
-- writes the same values, which the application uses to signal a change to the contact details or
-- the partner preferences, stored in other tables).
CREATE OR REPLACE FUNCTION matrimony.bump_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
       AND (to_jsonb(NEW) - ARRAY['version', 'updated_at', 'assigned_agent_id'])
         = (to_jsonb(OLD) - ARRAY['version', 'updated_at', 'assigned_agent_id']) THEN
        NEW.version := OLD.version;
    ELSE
        NEW.version := OLD.version + 1;
    END IF;
    RETURN NEW;
END;
$$;
