-- DEFINITIVE FIX FOR PEDAGOGICAL ACCESS
-- This script ensures students can see their assigned materials and teachers can manage them.
-- Run this in the Supabase SQL Editor.

-- 1. Ensure RLS is enabled
ALTER TABLE pedagogical_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_assignments ENABLE ROW LEVEL SECURITY;

-- 2. Fix pedagogical_materials SELECT Policy
DROP POLICY IF EXISTS "Read materials: Visibility Rules" ON pedagogical_materials;
DROP POLICY IF EXISTS "Read materials: Scoped Access" ON pedagogical_materials;

CREATE POLICY "Read materials: Visibility Rules" ON pedagogical_materials
    FOR SELECT USING (
        -- Global system materials
        scope = 'GLOBAL'
        
        -- Tenant-wide materials
        OR (scope = 'TENANT' AND tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()))
        
        -- Private materials owned by the user (Teacher/Admin)
        OR (uploaded_by = auth.uid())
        
        -- Admins see everything in their tenant
        OR (
             tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()) 
             AND auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
        )
        
        -- NEW/FIXED: Students see materials assigned to them via student_assignments
        OR (
            EXISTS (
                SELECT 1 FROM student_assignments sa 
                WHERE sa.material_id = pedagogical_materials.id 
                AND sa.student_id = auth.uid()
            )
        )
    );

-- 3. Ensure student_assignments policies are correct
DROP POLICY IF EXISTS "Students can view their own assignments" ON student_assignments;
CREATE POLICY "Students can view their own assignments" ON student_assignments
    FOR SELECT USING (student_id = auth.uid());

DROP POLICY IF EXISTS "Teachers can view assignments they made" ON student_assignments;
CREATE POLICY "Teachers can view assignments they made" ON student_assignments
    FOR SELECT USING (assigned_by = auth.uid());

DROP POLICY IF EXISTS "Admins can view all assignments in tenant" ON student_assignments;
CREATE POLICY "Admins can view all assignments in tenant" ON student_assignments
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE profiles.id = auth.uid() 
            AND profiles.role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
            AND profiles.tenant_id = (SELECT tenant_id FROM profiles p2 WHERE p2.id = student_assignments.student_id)
        )
    );

-- 4. Ensure storage bucket is public and large enough
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('materials', 'materials', true, 3221225472)
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = 3221225472;

-- 5. Storage Policies for 'materials' bucket
DROP POLICY IF EXISTS "Public Access to Materials" ON storage.objects;
CREATE POLICY "Public Access to Materials" ON storage.objects
  FOR SELECT USING ( bucket_id = 'materials' );

DROP POLICY IF EXISTS "Authenticated Upload to Materials" ON storage.objects;
CREATE POLICY "Authenticated Upload to Materials" ON storage.objects
  FOR INSERT WITH CHECK ( bucket_id = 'materials' AND auth.role() = 'authenticated' );
