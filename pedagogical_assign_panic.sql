-- EMERGENCY DEBUG: DISABLE RLS FOR ASSIGNMENTS
-- This removes ALL database permissions checks for the student_assignments table.

-- 1. Disable RLS on the TABLE
ALTER TABLE student_assignments DISABLE ROW LEVEL SECURITY;

-- 2. Grant explicit permissions to simple roles
GRANT ALL ON student_assignments TO authenticated;
GRANT ALL ON student_assignments TO anon;
GRANT ALL ON student_assignments TO service_role;

-- 3. Ensure the table exists with correct types (just in case)
CREATE TABLE IF NOT EXISTS student_assignments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    material_id UUID REFERENCES pedagogical_materials(id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES auth.users(id),
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    status TEXT DEFAULT 'PENDING',
    notes TEXT
);

-- 4. Bypass possible FK issues with trigger (unlikely but safe)
-- (No triggers usually on this table, so we leave it clean)
