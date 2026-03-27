-- FIX STORAGE PERMISSIONS
-- Run this in Supabase SQL Editor

-- 1. Create Bucket (if not exists) and set Public
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('materials', 'materials', true, 3221225472, null) -- 3GB Limit
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = 3221225472;

-- 2. ENABLE RLS on Objects (Good practice, usually enabled by default)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 3. DROP Existing Policies to avoid conflicts
DROP POLICY IF EXISTS "Public Access to Materials" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Upload to Materials" ON storage.objects;
DROP POLICY IF EXISTS "Owner Delete from Materials" ON storage.objects;
-- (Drop generic ones if they exist and are blocking)
DROP POLICY IF EXISTS "Give me access" ON storage.objects; 

-- 4. CREATE PERMISSIVE POLICIES for 'materials' bucket

-- Allow Public READ (Download/View)
CREATE POLICY "Public Access to Materials" ON storage.objects
  FOR SELECT
  USING ( bucket_id = 'materials' );

-- Allow Authenticated INSERT (Upload)
CREATE POLICY "Authenticated Upload to Materials" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'materials' 
    AND auth.role() = 'authenticated'
  );

-- Allow Owner DELETE
CREATE POLICY "Owner Delete from Materials" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'materials'
    AND auth.uid() = owner
  );

-- Allow Update (Overwrite) - Optional
CREATE POLICY "Authenticated Update to Materials" ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'materials' AND auth.uid() = owner);
