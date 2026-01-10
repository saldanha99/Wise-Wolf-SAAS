-- EMERGENCY DEBUG: DISABLE RLS on Materials Table
-- Run this to confirm if the issue is related to Permissions/RLS

-- 1. Disable RLS completely (Everyone can see/edit everything temporarily)
ALTER TABLE pedagogical_materials DISABLE ROW LEVEL SECURITY;

-- 2. Grant permissions just in case
GRANT ALL ON pedagogical_materials TO authenticated;
GRANT ALL ON pedagogical_materials TO service_role;

-- 3. Check for NULL tenant_ids (Data Fix)
UPDATE pedagogical_materials
SET tenant_id = (SELECT tenant_id FROM profiles WHERE id = uploaded_by LIMIT 1)
WHERE tenant_id IS NULL AND uploaded_by IS NOT NULL;
