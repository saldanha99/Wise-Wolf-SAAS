-- Pedagogical Visibility Refinement
-- Enforces: Teachers see Own + School; Admins see School + All Teachers

-- 1. Ensure 'scope' and 'uploaded_by' are used correctly
-- (Assuming tables already exist from previous scripts)

ALTER TABLE pedagogical_materials ENABLE ROW LEVEL SECURITY;

-- Drop old policies to avoid conflicts
DROP POLICY IF EXISTS "Read materials: Scoped Access" ON pedagogical_materials;
DROP POLICY IF EXISTS "Insert materials: Managers and Teachers" ON pedagogical_materials;
DROP POLICY IF EXISTS "Delete materials: Owners" ON pedagogical_materials;

-- 2. New SELECT Policy
CREATE POLICY "Read materials: Visibility Rules" ON pedagogical_materials
    FOR SELECT USING (
        -- 1. Global (System) Materials
        scope = 'GLOBAL'
        
        -- 2. Tenant Materials (Uploaded by Admin/Manager) - Visible to Everyone in Tenant
        OR (scope = 'TENANT' AND tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()))
        
        -- 3. Private Materials (Uploaded by Teacher) - Visible ONLY to the owner
        OR (uploaded_by = auth.uid())
        
        -- 4. Admins can see EVERYTHING in their tenant (including private teacher uploads if needed for audit? 
        --    User request: "School Admin adds -> Visible to all". "Teacher adds -> Visible only to self".
        --    Usually Admins want to see what teachers are uploading. Let's add that.)
        OR (
             tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()) 
             AND auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
        )
    );

-- 3. New INSERT Policy
CREATE POLICY "Insert materials: Authenticated" ON pedagogical_materials
    FOR INSERT WITH CHECK (
        auth.role() = 'authenticated'
        -- Ideally we enforce that 'uploaded_by' matches auth.uid() but triggers usually handle this
    );

-- 4. New DELETE Policy (Owner or Admin)
CREATE POLICY "Delete materials: Owner or Admin" ON pedagogical_materials
    FOR DELETE USING (
        uploaded_by = auth.uid() -- Owner can always delete
        OR 
        (   -- Admins can delete anything in their tenant
            tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()) 
            AND auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
        )
    );

-- 5. Helper Trigger to auto-set uploaded_by
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
