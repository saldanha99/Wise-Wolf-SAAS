
-- Fix: Allow student_id to be NULL in class_logs for experimental classes (trials)
-- Also ensure appointment_id and other necessary columns exist

DO $$ 
BEGIN
    -- 1. Make student_id nullable
    ALTER TABLE public.class_logs ALTER COLUMN student_id DROP NOT NULL;

    -- 2. Ensure appointment_id exists (for experimental classes)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'class_logs' AND column_name = 'appointment_id') THEN
        ALTER TABLE public.class_logs ADD COLUMN appointment_id TEXT;
    END IF;

    -- 3. Ensure class_type exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'class_logs' AND column_name = 'class_type') THEN
        ALTER TABLE public.class_logs ADD COLUMN class_type TEXT DEFAULT 'REGULAR';
    END IF;

    -- 4. Ensure assessment fields exist (re-applying from other scripts just in case)
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

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
