-- Migration: Add COMMERCIAL role to profiles and update policies
-- 1. Update the CHECK constraint on profiles role
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('STUDENT', 'TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL'));

-- 2. Update policies that use role checks
-- Update student_insights policy
DROP POLICY IF EXISTS "Admins e Professores veem todos insights" ON public.student_insights;
DROP POLICY IF EXISTS "Admins, Professores e Comercial veem todos insights" ON public.student_insights;

CREATE POLICY "Admins, Professores e Comercial veem todos insights"
ON public.student_insights FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'TEACHER', 'COMMERCIAL')
    )
);

-- 3. Ensure profiles are viewable by Commercial role (if not already public)
-- The "Public Read" policy already allows this, but let's be explicit if we want to restrict it later.
-- For now, "Public Read" is USING (true) so it's fine.

-- 4. Grant access to other relevant tables for Commercial role
-- CRM Leads, Opportunities, Trials usually have their own RLS.
-- Let's check if they need updates.
