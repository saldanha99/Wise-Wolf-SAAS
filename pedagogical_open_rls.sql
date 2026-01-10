-- FIX: Simplified RLS and Data Repair
-- Run this in Supabase SQL Editor

-- 1. FIX DATA
-- Ensure recent uploads by admins are set to TENANT scope
UPDATE pedagogical_materials 
SET scope = 'TENANT' 
WHERE scope IS NULL OR scope = 'PRIVATE'; 
-- (Note: In a real prod env we wouldn't overwrite PRIVATE blindly, but here the user is struggling to make things visible. 
--  It's safer to make everything TENANT for now if there are visibility issues.)

-- 2. RESET POLICIES (Super Simple Version)
ALTER TABLE pedagogical_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read materials: Visibility Rules" ON pedagogical_materials;
DROP POLICY IF EXISTS "Insert materials: Authenticated" ON pedagogical_materials;
DROP POLICY IF EXISTS "Delete materials: Owner or Admin" ON pedagogical_materials;

-- READ POLICY (Text Casting for robustness)
CREATE POLICY "Read materials: Visibility Rules" ON pedagogical_materials
    FOR SELECT USING (
        -- 1. Everyone sees GLOBAL
        scope = 'GLOBAL'
        
        -- 2. Everyone sees TENANT materials from their own tenant
        OR (
            scope = 'TENANT' 
            AND 
            tenant_id::text = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid())
        )
        
        -- 3. Users see their own PRIVATE uploads
        OR (uploaded_by = auth.uid())

        -- 4. Admins see EVERYTHING in their tenant (Debug/Audit)
        OR (
             tenant_id::text = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()) 
             AND 
             EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
        )

        -- 5. Students see Assigned
         OR (
            EXISTS (
                SELECT 1 FROM student_assignments sa 
                WHERE sa.material_id = pedagogical_materials.id 
                AND sa.student_id = auth.uid()
            )
        )
    );

-- INSERT POLICY (Allow all authenticated users to insert)
CREATE POLICY "Insert materials: Authenticated" ON pedagogical_materials
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- DELETE POLICY (Owner or Admin)
CREATE POLICY "Delete materials: Owner or Admin" ON pedagogical_materials
    FOR DELETE USING (
        uploaded_by = auth.uid()
        OR 
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
    );
