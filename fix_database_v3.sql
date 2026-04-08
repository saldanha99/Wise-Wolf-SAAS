
-- FINAL SCHEMA FIX FOR CLASS LOGS AND APPOINTMENTS

-- 1. Hardening class_logs table with missing columns
-- Using DO blocks for idempotency (safe to run multiple times)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'class_logs' AND column_name = 'appointment_id') THEN
        ALTER TABLE public.class_logs ADD COLUMN appointment_id TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'class_logs' AND column_name = 'content_covered') THEN
        ALTER TABLE public.class_logs ADD COLUMN content_covered TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'class_logs' AND column_name = 'assessment_level') THEN
        ALTER TABLE public.class_logs ADD COLUMN assessment_level TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'class_logs' AND column_name = 'psychological_profile') THEN
        ALTER TABLE public.class_logs ADD COLUMN psychological_profile TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'class_logs' AND column_name = 'teacher_verdict') THEN
        ALTER TABLE public.class_logs ADD COLUMN teacher_verdict TEXT;
    END IF;
END $$;

-- 2. Hardening appointments table (Missing tenant_id and RLS)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'appointments' AND column_name = 'tenant_id') THEN
        ALTER TABLE public.appointments ADD COLUMN tenant_id TEXT;
    END IF;
END $$;

-- Enable RLS on appointments
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view appointments in their tenant" ON public.appointments;
CREATE POLICY "Users can view appointments in their tenant" 
    ON public.appointments FOR SELECT 
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Teachers can manage their own appointments" ON public.appointments;
CREATE POLICY "Teachers can manage their own appointments" 
    ON public.appointments FOR ALL 
    USING (teacher_id = auth.uid() OR (SELECT role FROM profiles WHERE id = auth.uid()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'));

-- 3. Refresh PostgREST schema cache (Standard for Supabase when table structure changes)
NOTIFY pgrst, 'reload schema';
