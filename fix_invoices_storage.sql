-- FIX INVOICES STORAGE BUCKET
-- Run this in Supabase SQL Editor

-- 1. Create Bucket if it doesn't exist
-- Using NULL for allowed_mime_types to avoid array syntax issues and allow all types (controlled by app logic)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('invoices', 'invoices', true, 5242880, null) -- 5MB Limit
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = 5242880,
    allowed_mime_types = null;

-- 2. Drop existing policies to avoid conflicts
DROP POLICY IF EXISTS "Public Access to Materials" ON storage.objects;
DROP POLICY IF EXISTS "Give public access to invoices" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated uploads to invoices" ON storage.objects;
DROP POLICY IF EXISTS "Teacher Upload Invoice" ON storage.objects;
DROP POLICY IF EXISTS "Teacher Read Invoice" ON storage.objects;
DROP POLICY IF EXISTS "Public Read Invoices" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Upload Invoices" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Update Invoices" ON storage.objects;
DROP POLICY IF EXISTS "Owner Delete Invoices" ON storage.objects;


-- 3. Create Permissive Policies

-- ALLOW Public Read (So admin can download via link)
CREATE POLICY "Public Read Invoices" ON storage.objects
FOR SELECT
USING ( bucket_id = 'invoices' );

-- ALLOW Authenticated Uploads
-- We remove the folder name check here to avoid the UUID casting error in the policy definition.
CREATE POLICY "Authenticated Upload Invoices" ON storage.objects
FOR INSERT
WITH CHECK (
  bucket_id = 'invoices' 
  AND auth.role() = 'authenticated'
);

-- ALLOW Authenticated Update (Overwrite)
CREATE POLICY "Authenticated Update Invoices" ON storage.objects
FOR UPDATE
USING ( bucket_id = 'invoices' AND auth.role() = 'authenticated' );

-- ALLOW Owner Delete
CREATE POLICY "Owner Delete Invoices" ON storage.objects
FOR DELETE
USING ( bucket_id = 'invoices' AND auth.uid() = owner );
