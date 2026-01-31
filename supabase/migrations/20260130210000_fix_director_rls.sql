-- RLS Access Fix for Directors
-- Handles both 'SCHOOL_ADMIN' (from types.ts) and 'DIRECTOR' (legacy/requested) just in case.

BEGIN;

-- 1. Enable RLS (Safety Check)
ALTER TABLE IF EXISTS public.teacher_availability ENABLE ROW LEVEL SECURITY;

-- 2. Drop potential conflicting policies
DROP POLICY IF EXISTS "Availability viewable by authenticated" ON public.teacher_availability;
DROP POLICY IF EXISTS "Staff can view all schedules" ON public.teacher_availability;

-- 3. Create the specific policy requested by the user, but adapted for the valid roles
CREATE POLICY "Staff can view all schedules"
ON public.teacher_availability
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'DIRECTOR', 'COORDINATOR')
  )
);

-- 4. Also keep a policy for Teachers to view their OWN data (often needed)
CREATE POLICY "Teachers can view own availability"
ON public.teacher_availability
FOR SELECT
USING (
  teacher_id = auth.uid()
);

-- 5. Grant permissions
GRANT SELECT ON public.teacher_availability TO authenticated;
GRANT SELECT ON public.teacher_availability TO service_role;

COMMIT;
