-- INSPECT AUTH USERS
-- Raises notices with details of all users in auth.users
-- This allows us to debug instance_id, aud, and role values.

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN 
        SELECT id, email, instance_id, aud, role, encrypted_password, created_at 
        FROM auth.users
    LOOP
        RAISE NOTICE 'User: %, ID: %, Instance: %, Aud: %, Role: %', 
            r.email, r.id, r.instance_id, r.aud, r.role;
    END LOOP;
END $$;
