-- Migration: Prepare for Production (Zero Data & Create Admins)
-- 1. Cleans ALL data (Zeroes the system).
-- 2. Creates the requested Super Admin and Director accounts with password '123123'.

BEGIN;

-- 1. CLEAN EVERYTHING (Zero Data)
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

-- Safely clean pedagogical materials
DELETE FROM public.pedagogical_materials 
WHERE uploaded_by NOT IN (SELECT id FROM auth.users WHERE email IN ('saldanha372@gmail.com', 'wisewolflanguague@gmail.com'));

DELETE FROM public.profiles; 

-- Delete ALL users (Starting Fresh)
DELETE FROM auth.users;

-- Delete all Tenants
DELETE FROM public.tenants; 

-- 2. RE-CREATE MAIN TENANT
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

-- 3. NUCLEAR TRIGGER CLEANUP & USER CREATION
-- Ensure pgcrypto is available
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Drop ALL triggers on auth.users to prevent login crashes
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

-- Drop function if exists
DROP FUNCTION IF EXISTS public.handle_new_user();

-- 3.1 SUPER ADMIN
DO $$
DECLARE
    new_user_id UUID := gen_random_uuid();
    v_user_exists UUID;
BEGIN
    SELECT id INTO v_user_exists FROM auth.users WHERE email = 'saldanha372@gmail.com';
    
    IF v_user_exists IS NULL THEN
        INSERT INTO auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, role, aud) 
        VALUES (
            new_user_id, 
            '00000000-0000-0000-0000-000000000000', 
            'saldanha372@gmail.com', 
            extensions.crypt('123123', extensions.gen_salt('bf'::text)), 
            now(), 
            '{"provider": "email", "providers": ["email"]}', 
            '{"full_name": "Super Admin"}', 
            now(), 
            now(), 
            'authenticated', 
            'authenticated'
        );
    ELSE
        new_user_id := v_user_exists;
        UPDATE auth.users SET encrypted_password = extensions.crypt('123123', extensions.gen_salt('bf'::text)), updated_at = now() WHERE id = new_user_id;
    END IF;

    -- Upsert Profile
    INSERT INTO public.profiles (id, full_name, role, tenant_id, email, status_financial)
    VALUES (new_user_id, 'Super Admin', 'SUPER_ADMIN', 'school-wise-wolf', 'saldanha372@gmail.com', 'ACTIVE')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, tenant_id = EXCLUDED.tenant_id, email = EXCLUDED.email;
END $$;

-- 3.2 DIRECTOR
DO $$
DECLARE
    new_user_id UUID := gen_random_uuid();
    v_user_exists UUID;
BEGIN
    SELECT id INTO v_user_exists FROM auth.users WHERE email = 'wisewolflanguague@gmail.com';
    
    IF v_user_exists IS NULL THEN
        INSERT INTO auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, role, aud) 
        VALUES (
            new_user_id, 
            '00000000-0000-0000-0000-000000000000', 
            'wisewolflanguague@gmail.com', 
            extensions.crypt('123123', extensions.gen_salt('bf'::text)), 
            now(), 
            '{"provider": "email", "providers": ["email"]}', 
            '{"full_name": "Diretor Wise Wolf"}', 
            now(), 
            now(), 
            'authenticated', 
            'authenticated'
        );
    ELSE
         new_user_id := v_user_exists;
         UPDATE auth.users SET encrypted_password = extensions.crypt('123123', extensions.gen_salt('bf'::text)), updated_at = now() WHERE id = new_user_id;
    END IF;

    -- Upsert Profile
    INSERT INTO public.profiles (id, full_name, role, tenant_id, email, status_financial)
    VALUES (new_user_id, 'Diretor Wise Wolf', 'SCHOOL_ADMIN', 'school-wise-wolf', 'wisewolflanguague@gmail.com', 'ACTIVE')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, tenant_id = EXCLUDED.tenant_id, email = EXCLUDED.email;
END $$;

-- Permissions Fix
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;

COMMIT;
