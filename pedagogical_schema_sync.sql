-- DATA SCHEMA REPAIR SCRIPT (CORRECTED)
-- Re-run this to fix the "cannot alter type" error

-- 1. DROP POLICIES FIRST (To allow type changes)
DROP POLICY IF EXISTS "Read materials: Visibility Rules" ON pedagogical_materials;
DROP POLICY IF EXISTS "Insert materials: Authenticated" ON pedagogical_materials;
DROP POLICY IF EXISTS "Delete materials: Owner or Admin" ON pedagogical_materials;
DROP POLICY IF EXISTS "Universal Read" ON pedagogical_materials;
DROP POLICY IF EXISTS "Universal Save" ON pedagogical_materials;
DROP POLICY IF EXISTS "Universal Delete" ON pedagogical_materials;
DROP POLICY IF EXISTS "Read materials: Own Tenant or Global" ON pedagogical_materials;
DROP POLICY IF EXISTS "Read materials: Scoped Access" ON pedagogical_materials;
DROP POLICY IF EXISTS "Insert materials: Managers and Teachers" ON pedagogical_materials;


-- 2. ALTER COLUMNS (Now safe)
-- Ensure tenant_id is TEXT (Cast if necessary)
ALTER TABLE pedagogical_materials ALTER COLUMN tenant_id TYPE TEXT;

-- 3. ENSURE COLUMNS EXIST
ALTER TABLE pedagogical_materials ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'TENANT';
ALTER TABLE pedagogical_materials ADD COLUMN IF NOT EXISTS uploaded_by UUID DEFAULT auth.uid();
ALTER TABLE pedagogical_materials ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE pedagogical_materials ADD COLUMN IF NOT EXISTS file_url TEXT;
ALTER TABLE pedagogical_materials ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE pedagogical_materials ADD COLUMN IF NOT EXISTS level_tag TEXT DEFAULT 'General';
ALTER TABLE pedagogical_materials ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General';

-- 4. RE-ESTABLISH POLICIES (Universal/Permissive for Debugging)
ALTER TABLE pedagogical_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Universal Read" ON pedagogical_materials
    FOR SELECT USING (true); -- Temporarily open for debugging

CREATE POLICY "Universal Save" ON pedagogical_materials
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Universal Delete" ON pedagogical_materials
    FOR DELETE USING (auth.uid() = uploaded_by OR scope = 'TENANT');
