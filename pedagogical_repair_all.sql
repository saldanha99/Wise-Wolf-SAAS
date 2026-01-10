-- COMPREHENSIVE REPAIR SCRIPT (Pedagogical System)
-- Run this to fix 'Unexpected token' errors caused by missing schema or permissions.

-- 1. Profiles Table (Granular Unlocks)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS unlocked_tests TEXT[] DEFAULT '{}';

-- 2. Student Assignments Table (Fix table and RLS)
CREATE TABLE IF NOT EXISTS student_assignments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    material_id UUID REFERENCES pedagogical_materials(id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES auth.users(id),
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VIEWED', 'COMPLETED')),
    notes TEXT
);

-- Enable RLS
ALTER TABLE student_assignments ENABLE ROW LEVEL SECURITY;

-- Reset Assignments Policies (Permissive for Debug)
DROP POLICY IF EXISTS "Debug: Allow All Assignments" ON student_assignments;
CREATE POLICY "Debug: Allow All Assignments" ON student_assignments
    FOR ALL
    USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

-- 3. Pedagogical Materials (Fix RLS)
ALTER TABLE pedagogical_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Debug: Allow All Materials" ON pedagogical_materials;
CREATE POLICY "Debug: Allow All Materials" ON pedagogical_materials
    FOR ALL
    USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

-- 4. Grant Permissions (Fix "Permission Denied")
GRANT ALL ON profiles TO authenticated;
GRANT ALL ON profiles TO service_role;
GRANT ALL ON student_assignments TO authenticated;
GRANT ALL ON student_assignments TO service_role;
GRANT ALL ON pedagogical_materials TO authenticated;
GRANT ALL ON pedagogical_materials TO service_role;

-- 5. Fix Tenant ID Type (Common cause of errors)
DO $$ 
BEGIN
    ALTER TABLE pedagogical_materials ALTER COLUMN tenant_id TYPE TEXT;
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;
