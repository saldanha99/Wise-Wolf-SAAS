-- DEBUG & FIX Script for Pedagogical Materials
-- run this in Supabase SQL Editor

-- 1. Ensure TRIGGER exists (Crucial for 'uploaded_by')
CREATE OR REPLACE FUNCTION set_uploaded_by()
RETURNS TRIGGER AS $$
BEGIN
    NEW.uploaded_by := auth.uid();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_set_uploaded_by ON pedagogical_materials;
CREATE TRIGGER trigger_set_uploaded_by
    BEFORE INSERT ON pedagogical_materials
    FOR EACH ROW EXECUTE FUNCTION set_uploaded_by();

-- 2. RESET RLS POLICIES (With robust Casting)
ALTER TABLE pedagogical_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read materials: Visibility Rules" ON pedagogical_materials;
DROP POLICY IF EXISTS "Insert materials: Authenticated" ON pedagogical_materials;
DROP POLICY IF EXISTS "Delete materials: Owner or Admin" ON pedagogical_materials;

-- SELECT POLICY (Fixing potential UUID vs Text issues)
CREATE POLICY "Read materials: Visibility Rules" ON pedagogical_materials
    FOR SELECT USING (
        -- 1. Global
        scope = 'GLOBAL'
        
        -- 2. Tenant Materials (Manager Uploads)
        -- We cast both sides to text to be safe
        OR (scope = 'TENANT' AND tenant_id::text = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()))
        
        -- 3. Owner (Teacher Private)
        OR (uploaded_by = auth.uid())
        
        -- 4. Admins see everything in their tenant
        OR (
             tenant_id::text = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()) 
             AND auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
        )

        -- 5. Student Assignments
        OR (
            EXISTS (
                SELECT 1 FROM student_assignments sa 
                WHERE sa.material_id = pedagogical_materials.id 
                AND sa.student_id = auth.uid()
            )
        )
    );

-- INSERT POLICY
CREATE POLICY "Insert materials: Authenticated" ON pedagogical_materials
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- DELETE POLICY
CREATE POLICY "Delete materials: Owner or Admin" ON pedagogical_materials
    FOR DELETE USING (
        uploaded_by = auth.uid()
        OR 
        (
            tenant_id::text = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()) 
            AND auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
        )
    );

-- 3. FIX Existing Data (Optional safety net)
-- Set uploaded_by to owner of tenant if null (just to clean up bad rows if any)
-- UPDATE pedagogical_materials SET scope = 'TENANT' WHERE scope IS NULL;
