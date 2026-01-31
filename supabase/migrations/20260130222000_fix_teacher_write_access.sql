
BEGIN;

-- 1. Policy for INSERT
-- Allows authenticated users to insert availability IF the teacher_id matches their own Auth ID
DROP POLICY IF EXISTS "Teacher can insert own availability" ON public.teacher_availability;

CREATE POLICY "Teacher can insert own availability"
ON public.teacher_availability
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = teacher_id);

-- 2. Policy for DELETE
-- Allows authenticated users to delete availability IF the teacher_id matches their own Auth ID
DROP POLICY IF EXISTS "Teacher can delete own availability" ON public.teacher_availability;

CREATE POLICY "Teacher can delete own availability"
ON public.teacher_availability
FOR DELETE
TO authenticated
USING (auth.uid() = teacher_id);

-- 3. Policy for UPDATE (just in case used in future)
DROP POLICY IF EXISTS "Teacher can update own availability" ON public.teacher_availability;

CREATE POLICY "Teacher can update own availability"
ON public.teacher_availability
FOR UPDATE
TO authenticated
USING (auth.uid() = teacher_id)
WITH CHECK (auth.uid() = teacher_id);

-- Grant privileges to authenticated role just to be safe (RLS filters it, but GRANT works at table level)
GRANT ALL ON public.teacher_availability TO authenticated;
GRANT ALL ON public.teacher_availability TO service_role;

COMMIT;
