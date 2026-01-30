-- Ensure RLS policy permits reading for all authenticated users
-- This is a "fix" migration to be extra sure.

BEGIN;

-- Enable RLS (idempotent)
ALTER TABLE IF EXISTS public.teacher_availability ENABLE ROW LEVEL SECURITY;

-- Drop existing SELECT policy using a safe guard (IF EXISTS)
DROP POLICY IF EXISTS "Availability viewable by authenticated" ON public.teacher_availability;

-- Re-create the policy strictly
CREATE POLICY "Availability viewable by authenticated" 
ON public.teacher_availability FOR SELECT 
TO authenticated 
USING (true);

-- Also ensure service_role has access (implicit, but good to check grants)
GRANT SELECT ON public.teacher_availability TO service_role;
GRANT SELECT ON public.teacher_availability TO authenticated;
GRANT SELECT ON public.teacher_availability TO anon; -- For testing if needed, though 'authenticated' should suffice

COMMIT;
