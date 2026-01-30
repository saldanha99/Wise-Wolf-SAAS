-- Create trial_bookings table for the Smart Finder module
CREATE TABLE IF NOT EXISTS public.trial_bookings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    lead_name TEXT NOT NULL,
    lead_phone TEXT,
    teacher_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    start_time TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'SCHEDULED', -- 'SCHEDULED', 'DONE', 'NO_SHOW', 'CANCELLED'
    sales_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.trial_bookings ENABLE ROW LEVEL SECURITY;

-- Policies (Adjust based on roles, assuming authenticated staff can read/write)
DROP POLICY IF EXISTS "Trial bookings are viewable by authenticated users" ON public.trial_bookings;
CREATE POLICY "Trial bookings are viewable by authenticated users" 
ON public.trial_bookings FOR SELECT 
TO authenticated 
USING (true);

DROP POLICY IF EXISTS "Trial bookings are insertable by authenticated users" ON public.trial_bookings;
CREATE POLICY "Trial bookings are insertable by authenticated users" 
ON public.trial_bookings FOR INSERT 
TO authenticated 
WITH CHECK (true);

DROP POLICY IF EXISTS "Trial bookings are updateable by authenticated users" ON public.trial_bookings;
CREATE POLICY "Trial bookings are updateable by authenticated users" 
ON public.trial_bookings FOR UPDATE
TO authenticated 
USING (true);

-- Add index for faster searching by time range and teacher
CREATE INDEX IF NOT EXISTS idx_trial_bookings_teacher_time ON public.trial_bookings(teacher_id, start_time);
