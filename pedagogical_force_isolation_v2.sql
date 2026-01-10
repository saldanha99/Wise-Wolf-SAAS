-- AGGRESSIVE ISOLATION ENFORCEMENT
-- 1. Updates all existing materials to be TENANT scoped (unless explicitly Global)
-- 2. Ensures RLS is strictly enabled.
-- 3. Drops any permissive policies.

-- PART 1: Data Cleansing (Fix the leak source)
-- Update any material that looks like a "General" book but isn't marked Global to be Tenant private.
-- (Safe default: If in doubt, make it private to the tenant who uploaded it)
UPDATE pedagogical_materials
SET scope = 'TENANT'
WHERE scope IS NULL OR scope = '';

-- PART 2: Strict RLS (The Wall)
ALTER TABLE pedagogical_materials ENABLE ROW LEVEL SECURITY;

-- Drop ALL policy variations to be sure
DROP POLICY IF EXISTS "Debug: Allow All Materials" ON pedagogical_materials;
DROP POLICY IF EXISTS "Secure: View Materials" ON pedagogical_materials;
DROP POLICY IF EXISTS "Enable read access for all users" ON pedagogical_materials;
DROP POLICY IF EXISTS "Teacher manage materials" ON pedagogical_materials;

-- Create the ONE TRUE VIEW POLICY
CREATE POLICY "Strict: Tenant Isolation" ON pedagogical_materials
FOR SELECT
USING (
    -- Material Tenant matches User Tenant
    (tenant_id::text = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()))
    OR 
    -- User is Super Admin (sees all)
    ((SELECT role FROM profiles WHERE id = auth.uid()) = 'SUPER_ADMIN')
    OR
    -- Material is explicitly Global
    (scope = 'GLOBAL')
);

-- WRITE Policy
DROP POLICY IF EXISTS "Strict: Tenant Write" ON pedagogical_materials;
CREATE POLICY "Strict: Tenant Write" ON pedagogical_materials
FOR ALL
USING (
    tenant_id::text = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid())
);

-- PART 3: Verify Student Assignments Isolation
ALTER TABLE student_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Debug: Allow All Assignments" ON student_assignments;

CREATE POLICY "Strict: View Assignments" ON student_assignments
FOR ALL
USING (
    -- Students see own
    student_id = auth.uid()
    OR
    -- Teachers see only their tenant's students
    EXISTS (
        SELECT 1 FROM profiles s 
        WHERE s.id = student_assignments.student_id 
        AND s.tenant_id::text = (SELECT p.tenant_id::text FROM profiles p WHERE p.id = auth.uid())
    )
);
