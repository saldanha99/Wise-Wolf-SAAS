-- FINAL FIX: Idempotent script to fix Access and Storage Limit
-- Run this in Supabase SQL Editor

-- 1. FIX POLICIES (Drop first to avoid "already exists" error)
ALTER TABLE pedagogical_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read materials: Visibility Rules" ON pedagogical_materials;
DROP POLICY IF EXISTS "Insert materials: Authenticated" ON pedagogical_materials;
DROP POLICY IF EXISTS "Delete materials: Owner or Admin" ON pedagogical_materials;

-- Re-create Read Policy (Includes Student Access via Assignments)
CREATE POLICY "Read materials: Visibility Rules" ON pedagogical_materials
    FOR SELECT USING (
        -- 1. Global (System) Materials
        scope = 'GLOBAL'
        
        -- 2. Tenant Materials (Uploaded by Admin) - Visible to Everyone in Tenant
        OR (scope = 'TENANT' AND tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()))
        
        -- 3. Owner (Teacher) sees their own
        OR (uploaded_by = auth.uid())
        
        -- 4. Admins see everything in their tenant
        OR (
             tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()) 
             AND auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
        )
        
        -- 5. Students see materials assigned to them
        OR (
            EXISTS (
                SELECT 1 FROM student_assignments sa 
                WHERE sa.material_id = pedagogical_materials.id 
                AND sa.student_id = auth.uid()
            )
        )
    );

-- Re-create Insert Policy
CREATE POLICY "Insert materials: Authenticated" ON pedagogical_materials
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Re-create Delete Policy
CREATE POLICY "Delete materials: Owner or Admin" ON pedagogical_materials
    FOR DELETE USING (
        uploaded_by = auth.uid() -- Owner can always delete
        OR 
        (   -- Admins can delete anything in their tenant
            tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()) 
            AND auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
        )
    );

-- 2. FIX STORAGE LIMIT (Force update to 3GB)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('materials', 'materials', true, 3221225472, null)
ON CONFLICT (id) DO UPDATE
SET file_size_limit = 3221225472,
    public = true;
