-- FORCE FIX: Drop and Recreate to guarantee clean state
DROP TABLE IF EXISTS public.teacher_availability CASCADE;

CREATE TABLE public.teacher_availability (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    teacher_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sunday, 6=Saturday
    start_time TIME NOT NULL,
    end_time TIME,
    -- CORRECTED: tenant_id as TEXT to match your table
    tenant_id TEXT REFERENCES public.tenants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Re-enable RLS
ALTER TABLE public.teacher_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Availability viewable by authenticated" 
ON public.teacher_availability FOR SELECT 
TO authenticated 
USING (true);

CREATE POLICY "Availability editable by authenticated" 
ON public.teacher_availability FOR ALL 
TO authenticated 
USING (true)
WITH CHECK (true);

CREATE INDEX idx_teacher_avail_day_time ON public.teacher_availability(day_of_week, start_time);

-- IMPORTANT: Check if we have any teachers to insert dummy data
-- Only runs if a 'TEACHER' exists in profiles.
DO $$
DECLARE
    t_id UUID;
    ten_id TEXT;
BEGIN
    SELECT id, tenant_id INTO t_id, ten_id FROM public.profiles WHERE role = 'TEACHER' LIMIT 1;
    
    IF t_id IS NOT NULL THEN
        INSERT INTO public.teacher_availability (teacher_id, tenant_id, day_of_week, start_time)
        VALUES (t_id, ten_id, 1, '19:00'); -- Monday 19:00
        INSERT INTO public.teacher_availability (teacher_id, tenant_id, day_of_week, start_time)
        VALUES (t_id, ten_id, 3, '20:00'); -- Wednesday 20:00
    END IF;
END $$;
