-- Force Create/Update 'materials' bucket with 1GB limit
-- Run this in the Supabase SQL Editor

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('materials', 'materials', true, 1073741824, null) -- 1GB Limit
ON CONFLICT (id) DO UPDATE
SET file_size_limit = 1073741824, -- Update existing limit
    allowed_mime_types = null,     -- Allow all types
    public = true;                 -- Ensure it's public

-- Verify the result (Output should show 1073741824)
SELECT id, file_size_limit FROM storage.buckets WHERE id = 'materials';
