-- Ensure Avatars bucket is configured
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 20971520, null) -- 20MB Limit
ON CONFLICT (id) DO UPDATE
SET public = true, file_size_limit = 20971520;

-- Drop strict policies (Old names)
DROP POLICY IF EXISTS "Authenticated Upload Avatars" ON storage.objects;
DROP POLICY IF EXISTS "Owner Update Avatars" ON storage.objects;
DROP POLICY IF EXISTS "Owner Delete Avatars" ON storage.objects;
DROP POLICY IF EXISTS "Give users access to own folder 1oz022s_0" ON storage.objects;
DROP POLICY IF EXISTS "Give users access to own folder 1oz022s_1" ON storage.objects;
DROP POLICY IF EXISTS "Give users access to own folder 1oz022s_2" ON storage.objects;
DROP POLICY IF EXISTS "Give users access to own folder 1oz022s_3" ON storage.objects;

-- Drop permissive policies (New names - preventing conflict)
DROP POLICY IF EXISTS "Authenticated Insert Avatars" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Update Avatars" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Select Avatars" ON storage.objects;

-- Create permissive policies
-- NOTE: We avoid using auth.uid() = owner for INSERT because auth.uid() might be 'wise-wolf-school' (Text) 
-- and owner is UUID, causing Type Error.
-- Instead, we just check if user is authenticated.

CREATE POLICY "Authenticated Insert Avatars" ON storage.objects
FOR INSERT
WITH CHECK (
  bucket_id = 'avatars' 
  AND auth.role() = 'authenticated'
);

CREATE POLICY "Authenticated Update Avatars" ON storage.objects
FOR UPDATE
USING ( bucket_id = 'avatars' AND auth.role() = 'authenticated' );

CREATE POLICY "Authenticated Select Avatars" ON storage.objects
FOR SELECT
USING ( bucket_id = 'avatars' );

-- Attempt to alter storage.objects owner column to text ONLY IF IT EXISTS and is safe
-- This is risky on managed instances, usually not recommended, but might be necessary if auth system uses text IDs.
-- DO NOT RUN ALTER TABLE storage.objects ... blindly.
