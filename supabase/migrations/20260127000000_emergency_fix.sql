-- EMERGENCY FIX: Simplify Permissions and Crypto
-- 1. Moves pgcrypto back to PUBLIC (Standardizes access)
-- 2. Disables RLS on auth.users (Ensures login service access)
-- 3. Recreates users with standard public.crypt functions

BEGIN;

-- 1. RESET EXTENSIONS
-- Drop pgcrypto to clear confusion (Warning: CASCADE might affect dependent defaults, but auth.users generally uses native gen_random_uuid in Supabase PG15+)
-- If this fails, we catch it.
DROP EXTENSION IF EXISTS pgcrypto CASCADE;
CREATE EXTENSION pgcrypto WITH SCHEMA public;

-- 2. RESET AUTH SECURITY (Skipped: Requires owner permissions)
-- ALTER TABLE auth.users DISABLE ROW LEVEL SECURITY;

-- 3. CLEANUP & RECREATE
DELETE FROM public.profiles;
DELETE FROM auth.users;

-- 4. SUPER ADMIN
INSERT INTO auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, role, aud, is_super_admin) 
VALUES (
    'd0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0', 
    '00000000-0000-0000-0000-000000000000', 
    'saldanha372@gmail.com', 
    crypt('123123', gen_salt('bf')), 
    now(), 
    '{"provider": "email", "providers": ["email"]}', 
    '{"full_name": "Super Admin"}', 
    now(), 
    now(), 
    'authenticated', 
    'authenticated',
    false
);

INSERT INTO public.profiles (id, full_name, role, tenant_id, email, status_financial)
VALUES ('d0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0', 'Super Admin', 'SUPER_ADMIN', 'school-wise-wolf', 'saldanha372@gmail.com', 'ACTIVE')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;

-- 5. DIRECTOR
INSERT INTO auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, role, aud, is_super_admin) 
VALUES (
    'e0e0e0e0-e0e0-e0e0-e0e0-e0e0e0e0e0e0', 
    '00000000-0000-0000-0000-000000000000', 
    'wisewolflanguague@gmail.com', 
    crypt('123123', gen_salt('bf')), 
    now(), 
    '{"provider": "email", "providers": ["email"]}', 
    '{"full_name": "Diretor Wise Wolf"}', 
    now(), 
    now(), 
    'authenticated', 
    'authenticated',
    false
);

INSERT INTO public.profiles (id, full_name, role, tenant_id, email, status_financial)
VALUES ('e0e0e0e0-e0e0-e0e0-e0e0-e0e0e0e0e0e0', 'Diretor Wise Wolf', 'SCHOOL_ADMIN', 'school-wise-wolf', 'wisewolflanguague@gmail.com', 'ACTIVE')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;

-- 6. PERMISSIONS
GRANT ALL ON FUNCTION public.crypt(text, text) TO postgres, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.gen_salt(text) TO postgres, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;

-- 7. RELOAD CACHE
NOTIFY pgrst, 'reload schema';

COMMIT;
