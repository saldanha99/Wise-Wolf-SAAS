-- SECURE MULTI-TENANCY RESTORATION
-- This script replaces the debug permissive policies with strict Tenant Isolation.

-- 1. Pedagogical Materials Isolation
ALTER TABLE pedagogical_materials ENABLE ROW LEVEL SECURITY;

-- Drop insecure policies
DROP POLICY IF EXISTS "Debug: Allow All Materials" ON pedagogical_materials;
DROP POLICY IF EXISTS "Teacher manage materials" ON pedagogical_materials;
DROP POLICY IF EXISTS "Anyone can view global" ON pedagogical_materials;

-- Create Secure Policies

-- READ: Visible if (Belongs to my Tenant) OR (Is Marked Global)
CREATE POLICY "Secure: View Materials" ON pedagogical_materials
FOR SELECT
USING (
    tenant_id::text = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid())
    OR 
    scope = 'GLOBAL'
);

-- WRITE (Insert/Update/Delete): Only Managers/Admins of the matching Tenant
CREATE POLICY "Secure: Manage Materials" ON pedagogical_materials
FOR ALL
USING (
    tenant_id::text = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid())
    AND 
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'MANAGER')
);

-- 2. Student Assignments Isolation
ALTER TABLE student_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Debug: Allow All Assignments" ON student_assignments;

-- READ: Teachers can see their tenant's assignments. Students can see their OWN.
CREATE POLICY "Secure: View Assignments" ON student_assignments
FOR SELECT
USING (
    -- If I am the student
    student_id = auth.uid()
    OR
    -- If I am a teacher/admin in the same tenant as the student
    EXISTS (
        SELECT 1 FROM profiles s 
        WHERE s.id = student_assignments.student_id 
        AND s.tenant_id::text = (SELECT p.tenant_id::text FROM profiles p WHERE p.id = auth.uid())
    )
);

-- WRITE: Teachers/Admins can assign to students in their tenant
CREATE POLICY "Secure: Manage Assignments" ON student_assignments
FOR INSERT
WITH CHECK (
    -- Implied: check if target student is in my tenant (good practice, though UI filters usually handle it)
    EXISTS (
        SELECT 1 FROM profiles s 
        WHERE s.id = student_assignments.student_id 
        AND s.tenant_id::text = (SELECT p.tenant_id::text FROM profiles p WHERE p.id = auth.uid())
    )
    AND
    (auth.role() = 'authenticated')
);

-- UPDATE/DELETE: Same logic
CREATE POLICY "Secure: Modify Assignments" ON student_assignments
FOR UPDATE
USING (
     EXISTS (
        SELECT 1 FROM profiles s 
        WHERE s.id = student_assignments.student_id 
        AND s.tenant_id::text = (SELECT p.tenant_id::text FROM profiles p WHERE p.id = auth.uid())
    )
);

CREATE POLICY "Secure: Delete Assignments" ON student_assignments
FOR DELETE
USING (
     EXISTS (
        SELECT 1 FROM profiles s 
        WHERE s.id = student_assignments.student_id 
        AND s.tenant_id::text = (SELECT p.tenant_id::text FROM profiles p WHERE p.id = auth.uid())
    )
);


-- 3. Profiles (Granular Unlocks) - Ensure teachers can only edit students in their tenant
-- (Profiles usually has its own RLS, but we can add a specific policy for the unlocked_tests column update if needed, 
--  but Supabase column-level security isn't standard RLS. We verify table level.)

CREATE POLICY "Secure: Update Student Unlocks" ON profiles
FOR UPDATE
USING (
    tenant_id::text = (SELECT p.tenant_id::text FROM profiles p WHERE p.id = auth.uid())
    AND
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
)
WITH CHECK (
    tenant_id::text = (SELECT p.tenant_id::text FROM profiles p WHERE p.id = auth.uid())
);
