-- Add granular unlocking support
-- This allows unlocking specific tests (A1, B1, etc.) per student

ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS unlocked_tests TEXT[] DEFAULT '{}';

-- Allow teachers to update this specific column
CREATE POLICY "Teachers update unlocked_tests" ON profiles
    FOR UPDATE
    USING (role = 'STUDENT')
    WITH CHECK (
        auth.uid() IN (SELECT id FROM profiles WHERE role IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN'))
    );
