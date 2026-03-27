-- Ensure module column exists
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS module TEXT;

-- Policy to allow teachers to update students' modules in their tenant
-- A teacher can update a profile if the target profile is a STUDENT and belongs to the same tenant.
DROP POLICY IF EXISTS "Teachers can update student modules" ON public.profiles;
CREATE POLICY "Teachers can update student modules" 
    ON public.profiles FOR UPDATE
    USING (
        (SELECT role FROM profiles WHERE id = auth.uid()) = 'TEACHER' 
        AND role = 'STUDENT'
        AND tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid())
    )
    WITH CHECK (
        (SELECT role FROM profiles WHERE id = auth.uid()) = 'TEACHER' 
        AND role = 'STUDENT'
        AND tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid())
    );

-- Also ensure School Admins can update modules
DROP POLICY IF EXISTS "Admins can update all profiles in tenant" ON public.profiles;
CREATE POLICY "Admins can update all profiles in tenant"
    ON public.profiles FOR UPDATE
    USING (
        (SELECT role FROM profiles WHERE id = auth.uid()) = 'SCHOOL_ADMIN'
        AND tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid())
    )
    WITH CHECK (
        (SELECT role FROM profiles WHERE id = auth.uid()) = 'SCHOOL_ADMIN'
        AND tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid())
    );
