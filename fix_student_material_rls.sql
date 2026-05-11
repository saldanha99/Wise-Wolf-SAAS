-- Fix Student Material Visibility
-- Students should be able to READ materials that have been specifically assigned to them,
-- even if the material's scope is PRIVATE or belongs to another teacher.

DROP POLICY IF EXISTS "Read materials: Visibility Rules" ON pedagogical_materials;

CREATE POLICY "Read materials: Visibility Rules" ON pedagogical_materials
    FOR SELECT USING (
        -- 1. Global (System) Materials
        scope = 'GLOBAL'
        
        -- 2. Tenant Materials (Uploaded by Admin/Manager) - Visible to Everyone in Tenant
        OR (scope = 'TENANT' AND tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()))
        
        -- 3. Private Materials (Uploaded by Teacher) - Visible ONLY to the owner
        OR (uploaded_by = auth.uid())
        
        -- 4. Admins can see EVERYTHING in their tenant
        OR (
             tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()) 
             AND auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
        )
        
        -- 5. NEW: Materials assigned to the student via student_assignments
        OR (
            id IN (
                SELECT material_id 
                FROM student_assignments 
                WHERE student_id = auth.uid()
            )
        )
    );

-- Also ensure student_assignments has proper read policy (re-affirming from pedagogical_assign_fix.sql)
DROP POLICY IF EXISTS "Student read assignments" ON student_assignments;
CREATE POLICY "Student read assignments" ON student_assignments
    FOR SELECT
    USING (student_id = auth.uid());
