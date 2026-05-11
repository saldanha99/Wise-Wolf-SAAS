-- Add Payment Details columns to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS agency TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pix_key TEXT; -- Ensure it exists

-- Create Storage Bucket for Avatars
-- Using NULL for allowed_mime_types to avoid array syntax error
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 5242880, null) -- 5MB
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = 5242880,
    allowed_mime_types = null;

-- Policies for Avatars
DROP POLICY IF EXISTS "Public Access to Avatars" ON storage.objects;
CREATE POLICY "Public Access to Avatars" ON storage.objects
FOR SELECT
USING ( bucket_id = 'avatars' );

DROP POLICY IF EXISTS "Authenticated Upload Avatars" ON storage.objects;
CREATE POLICY "Authenticated Upload Avatars" ON storage.objects
FOR INSERT
WITH CHECK (
  bucket_id = 'avatars' 
  AND auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "Owner Update Avatars" ON storage.objects;
CREATE POLICY "Owner Update Avatars" ON storage.objects
FOR UPDATE
USING ( bucket_id = 'avatars' AND auth.uid() = owner );

DROP POLICY IF EXISTS "Owner Delete Avatars" ON storage.objects;
CREATE POLICY "Owner Delete Avatars" ON storage.objects
FOR DELETE
USING ( bucket_id = 'avatars' AND auth.uid() = owner );
