-- FIX 1: Allow Students to see materials assigned to them
-- (Even if the material is PRIVATE to the teacher)

DROP POLICY IF EXISTS "Read materials: Visibility Rules" ON pedagogical_materials;

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
        
        -- 5. [NEW] Students see materials assigned to them
        OR (
            EXISTS (
                SELECT 1 FROM student_assignments sa 
                WHERE sa.material_id = pedagogical_materials.id 
                AND sa.student_id = auth.uid()
            )
        )
    );

-- FIX 2: Force Storage Limit (Again, simpler query)
-- Set to 3GB just to be safe
UPDATE storage.buckets
SET file_size_limit = 3221225472, -- 3GB
    public = true
WHERE id = 'materials';
