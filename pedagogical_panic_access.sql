-- EMERGENCY DEBUG: DISABLE RLS (NUCLEAR OPTION)
-- This removes ALL database permissions checks for the pedagogical_materials table.
-- Use this ONLY to verify if the issue is permission-related.

-- 1. Disable RLS on the TABLE (Database side)
ALTER TABLE pedagogical_materials DISABLE ROW LEVEL SECURITY;

-- 2. Grant explicit permissions to everyone (just in case)
GRANT ALL ON pedagogical_materials TO authenticated;
GRANT ALL ON pedagogical_materials TO anon;
GRANT ALL ON pedagogical_materials TO service_role;

-- 3. Drop the trigger if it's causing issues (we are setting uploaded_by in frontend now)
DROP TRIGGER IF EXISTS trigger_set_uploaded_by ON pedagogical_materials;
DROP FUNCTION IF EXISTS set_uploaded_by();

-- 4. Ensure tenant_id is text (compatibility fix)
ALTER TABLE pedagogical_materials ALTER COLUMN tenant_id TYPE TEXT;
