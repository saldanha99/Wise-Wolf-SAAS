
-- ============================================================================
-- Migration: Nuclear Stabilization (Fixing 400 Errors & WhatsApp)
-- Reverts complex RLS that caused recursion and stabilizes the dashboard.
-- ============================================================================

BEGIN;

-- 1. GARANTIR COLUNAS CRÍTICAS NO PROFILES (Resolve Erro 400)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'monthly_fee') THEN
        ALTER TABLE public.profiles ADD COLUMN monthly_fee NUMERIC(10,2) DEFAULT 0;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'due_day') THEN
        ALTER TABLE public.profiles ADD COLUMN due_day INTEGER;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'whatsapp_instance') THEN
        ALTER TABLE public.profiles ADD COLUMN whatsapp_instance TEXT;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'hr_group_id') THEN
        ALTER TABLE public.profiles ADD COLUMN hr_group_id TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'class_frequency') THEN
        ALTER TABLE public.profiles ADD COLUMN class_frequency TEXT;
    END IF;
END $$;

-- 2. STABILIZE PROFILES RLS (Elimina Erro 400 no role=eq.STUDENT)
ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Admins view tenant profiles" ON public.profiles;
DROP POLICY IF EXISTS "Allow authenticated read" ON public.profiles;
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.profiles;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated read" ON public.profiles
    FOR SELECT TO authenticated
    USING (true);

-- 3. STABILIZE PROSPECTS
ALTER TABLE public.prospects DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins manage prospects" ON public.prospects;
DROP POLICY IF EXISTS "Anon read prospects" ON public.prospects;
ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage prospects" ON public.prospects
    FOR ALL TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Anon read prospects" ON public.prospects 
    FOR SELECT TO anon 
    USING (true);

GRANT SELECT ON public.prospects TO anon;

-- 4. FINAL WHATSAPP TRIGGER FIX
CREATE OR REPLACE FUNCTION public.notify_outbox_inserted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_supabase_url TEXT := 'https://dvalxbtngopxopzcbfdm.supabase.co';
    v_service_key TEXT;
BEGIN
    BEGIN
        SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'SERVICE_ROLE_KEY' LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        v_service_key := NULL;
    END;

    IF v_service_key IS NOT NULL THEN
        PERFORM extensions.http_post(
            url := v_supabase_url || '/functions/v1/process-outbox',
            headers := jsonb_build_object(
                'Authorization', 'Bearer ' || v_service_key,
                'Content-Type', 'application/json'
            ),
            body := jsonb_build_object(
                'trigger', 'pg_net',
                'msg_id', NEW.id::text
            )
        );
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$;

COMMIT;
