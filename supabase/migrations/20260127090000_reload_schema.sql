-- RELOAD SCHEMA CACHE
-- PostgREST API is failing with "Could not find column ... in schema cache".
-- This forces a reload.

NOTIFY pgrst, 'reload schema';
