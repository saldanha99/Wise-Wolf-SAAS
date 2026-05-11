-- ============================================================================
-- Migration: Create Contracts Storage Bucket
-- ============================================================================

BEGIN;

-- 1. Create Bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'contracts',
    'contracts',
    false, -- Private bucket
    5242880, -- 5MB limit
    '{application/pdf}'
) ON CONFLICT (id) DO UPDATE SET
    public = false,
    allowed_mime_types = '{application/pdf}';

-- 2. Storage Policies for Contracts
-- Admins can view contracts
CREATE POLICY "Admins read contracts" ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'contracts' AND
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
        )
    );

-- Service role has full access
CREATE POLICY "Service role full access contracts" ON storage.objects
    FOR ALL TO service_role
    USING (bucket_id = 'contracts')
    WITH CHECK (bucket_id = 'contracts');

COMMIT;
