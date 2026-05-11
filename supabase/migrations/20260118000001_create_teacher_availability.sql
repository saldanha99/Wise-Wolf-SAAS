-- Create teacher_availability table to fix missing relation
CREATE TABLE IF NOT EXISTS public.teacher_availability (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    teacher_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sunday, 6=Saturday
    start_time TIME NOT NULL,
    end_time TIME,
    tenant_id TEXT REFERENCES public.tenants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.teacher_availability ENABLE ROW LEVEL SECURITY;

-- Policy: Allow read access to authenticated users
DROP POLICY IF EXISTS "Availability viewable by authenticated" ON public.teacher_availability;
CREATE POLICY "Availability viewable by authenticated" 
ON public.teacher_availability FOR SELECT 
TO authenticated 
USING (true);

-- Policy: Allow insert/update by authenticated (or teachers only, simplified for now)
DROP POLICY IF EXISTS "Availability editable by authenticated" ON public.teacher_availability;
CREATE POLICY "Availability editable by authenticated" 
ON public.teacher_availability FOR ALL 
TO authenticated 
USING (true)
WITH CHECK (true);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_teacher_avail_day_time ON public.teacher_availability(day_of_week, start_time);

-- Note: User needs to populate this table since the frontend currently writes to 'availabilities'
