-- Force update storage bucket limit to 1GB
-- Run this in Supabase SQL Editor

UPDATE storage.buckets
SET file_size_limit = 1073741824, -- 1GB in bytes
    allowed_mime_types = null -- Allow all types (or specify if needed)
WHERE id = 'materials';

-- Verify the update
SELECT id, name, file_size_limit FROM storage.buckets WHERE id = 'materials';
