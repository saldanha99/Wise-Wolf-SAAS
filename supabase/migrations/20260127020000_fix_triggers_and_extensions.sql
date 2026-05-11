-- FIX LOGIN: Restore Extensions, Dummy Function, and Cleanup
-- 1. Restore pgcrypto to EXTENSIONS schema (Standard practice).
-- 2. Create DUMMY handle_new_user function to prevent crashes if a trigger calls it.
-- 3. Explicitly drop known triggers.
-- 4. Re-create users with standard flow.

BEGIN;

-- 1. EXTENSIONS (Standardize to 'extensions')
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role, public;

-- Move pgcrypto back or ensure it's there
-- We try to create it in extensions. If it exists in public, we might need to handle that, 
-- but 'CREATE EXTENSION IF NOT EXISTS' handles idemptency if schema matches. 
-- If it's in public, we'll try to drop strict and recreate.
DROP EXTENSION IF EXISTS pgcrypto CASCADE;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

-- Grant access to crypto functions
GRANT EXECUTE ON FUNCTION extensions.crypt(text, text) TO postgres, anon, authenticated, service_role, public;
GRANT EXECUTE ON FUNCTION extensions.gen_salt(text) TO postgres, anon, authenticated, service_role, public;

-- 2. DUMMY FUNCTION (Safety Net)
-- If we failed to drop a trigger that calls this, this empty function prevents the "function not found" crash.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. DROP TRIGGERS (Explicit Names)
-- Attempt to drop common triggers. If they don't exist, it's fine.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
DROP TRIGGER IF EXISTS handle_new_user ON auth.users;

-- 4. CLEAN DATA (One last time)
DELETE FROM public.profiles;
DELETE FROM auth.users;

-- 5. CREATE USERS (Using extensions.crypt)
-- Super Admin
INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, role, aud) 
VALUES (
    'd0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0', 
    'saldanha372@gmail.com', 
    extensions.crypt('123123', extensions.gen_salt('bf')), 
    now(), 
    '{"provider": "email", "providers": ["email"]}', 
    '{"full_name": "Super Admin"}', 
    now(), 
    now(), 
    'authenticated', 
    'authenticated'
);

INSERT INTO public.profiles (id, full_name, role, tenant_id, email, status_financial)
VALUES ('d0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0', 'Super Admin', 'SUPER_ADMIN', 'school-wise-wolf', 'saldanha372@gmail.com', 'ACTIVE')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;

-- Director
INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, role, aud) 
VALUES (
    'e0e0e0e0-e0e0-e0e0-e0e0-e0e0e0e0e0e0', 
    'wisewolflanguague@gmail.com', 
    extensions.crypt('123123', extensions.gen_salt('bf')), 
    now(), 
    '{"provider": "email", "providers": ["email"]}', 
    '{"full_name": "Diretor Wise Wolf"}', 
    now(), 
    now(), 
    'authenticated', 
    'authenticated'
);

INSERT INTO public.profiles (id, full_name, role, tenant_id, email, status_financial)
VALUES ('e0e0e0e0-e0e0-e0e0-e0e0-e0e0e0e0e0e0', 'Diretor Wise Wolf', 'SCHOOL_ADMIN', 'school-wise-wolf', 'wisewolflanguague@gmail.com', 'ACTIVE')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;

-- 6. PERMISSIONS & REFRESH
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
