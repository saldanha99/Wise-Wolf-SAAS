-- Migration: Fix Auth Permissions and Re-create Admins
-- 1. Grants explicit permissions on extensions schema
-- 2. Cleans data again to ensure fresh state
-- 3. Creates users with explicit search_path and permissions validation

BEGIN;

-- 1. PERMISSIONS FIX (Crucial for pgcrypto visibility)
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role, public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 2. CLEANUP
DELETE FROM public.bookings;
DELETE FROM public.reschedules;
DELETE FROM public.class_logs;
DELETE FROM public.financial_transactions;
DELETE FROM public.teacher_closings;
DELETE FROM public.crm_leads;
DELETE FROM public.appointments;
DELETE FROM public.opportunities;
DELETE FROM public.trial_bookings;
DELETE FROM public.ai_messages;
DELETE FROM public.student_insights;
DELETE FROM public.teacher_availability;
DELETE FROM public.whatsapp_instances;
DELETE FROM public.whatsapp_logs;
DELETE FROM public.whatsapp_templates;
DELETE FROM public.student_assignments;
DELETE FROM public.student_quiz_attempts;

DELETE FROM public.pedagogical_materials 
WHERE uploaded_by NOT IN (SELECT id FROM auth.users WHERE email IN ('saldanha372@gmail.com', 'wisewolflanguague@gmail.com'));

DELETE FROM public.profiles; 
DELETE FROM auth.users;
DELETE FROM public.tenants; 

-- 3. RE-CREATE TENANT
INSERT INTO public.tenants (id, name, domain, branding, student_limit, teacher_limit, whatsapp_enabled)
VALUES (
    'school-wise-wolf', 
    'Wise Wolf Languages', 
    'wisewolf', 
    '{"primaryColor": "#002366", "secondaryColor": "#D32F2F", "logoUrl":"", "faviconUrl":""}', 
    9999, 
    9999, 
    true
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 4. CLEAN TRIGGERS (Just in case)
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN 
        SELECT trigger_name 
        FROM information_schema.triggers 
        WHERE event_object_schema = 'auth' 
        AND event_object_table = 'users'
    LOOP
        EXECUTE 'DROP TRIGGER IF EXISTS ' || t || ' ON auth.users CASCADE';
    END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.handle_new_user();

-- 5. CREATE USERS
-- 5.1 SUPER ADMIN
DO $$
DECLARE
    new_user_id UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, role, aud, is_super_admin) 
    VALUES (
        new_user_id, 
        '00000000-0000-0000-0000-000000000000', 
        'saldanha372@gmail.com', 
        extensions.crypt('123123', extensions.gen_salt('bf')), 
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
    VALUES (new_user_id, 'Super Admin', 'SUPER_ADMIN', 'school-wise-wolf', 'saldanha372@gmail.com', 'ACTIVE');
END $$;

-- 5.2 DIRECTOR
DO $$
DECLARE
    new_user_id UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, role, aud, is_super_admin) 
    VALUES (
        new_user_id, 
        '00000000-0000-0000-0000-000000000000', 
        'wisewolflanguague@gmail.com', 
        extensions.crypt('123123', extensions.gen_salt('bf')), 
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
    VALUES (new_user_id, 'Diretor Wise Wolf', 'SCHOOL_ADMIN', 'school-wise-wolf', 'wisewolflanguague@gmail.com', 'ACTIVE');
END $$;

-- 6. GRANT PUBLIC PERMISSIONS
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;

COMMIT;
