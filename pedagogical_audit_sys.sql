-- Pedagogical Audit System Migration

-- 1. Update Pedagogical Materials to use Scope
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pedagogical_materials' AND column_name = 'scope') THEN
        ALTER TABLE pedagogical_materials ADD COLUMN scope TEXT CHECK (scope IN ('GLOBAL', 'TENANT', 'PRIVATE'));
        
        -- Migrate existing data
        UPDATE pedagogical_materials SET scope = 'GLOBAL' WHERE is_global = true;
        UPDATE pedagogical_materials SET scope = 'TENANT' WHERE is_global = false;
        
        -- Optionally drop is_global later, but let's keep it for compatibility for a moment, or rely on scope.
        -- ALTER TABLE pedagogical_materials DROP COLUMN is_global;
    END IF;
END $$;

-- 2. Update Class Logs for Approval Flow
ALTER TABLE class_logs
ADD COLUMN IF NOT EXISTS approval_status TEXT CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')) DEFAULT 'APPROVED',
ADD COLUMN IF NOT EXISTS requires_review BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS review_notes TEXT; -- Notes from manager to teacher

-- 3. RLS Updates for Materials based on Scope
DROP POLICY IF EXISTS "Read materials: Own Tenant or Global" ON pedagogical_materials;

CREATE POLICY "Read materials: Scoped Access" ON pedagogical_materials
    FOR SELECT USING (
        scope = 'GLOBAL' -- All can read global
        OR (scope = 'TENANT' AND tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid())) -- Own tenant
        OR (scope = 'PRIVATE' AND uploaded_by = auth.uid()) -- Own private uploads
    );

-- 4. Audit View for Managers (Function helper if needed, but RLS is enough)
-- Manager can see all class_logs for their tenant.
-- Teacher can see their own.

-- Ensure class_logs RLS is correct (it should already be).
