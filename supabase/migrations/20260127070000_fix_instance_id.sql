-- FIX INSTANCE_ID
-- The root cause of the "invisible user" issue is that instance_id was inserted as NULL.
-- Supabase Auth filters by '00000000-0000-0000-0000-000000000000' by default.
-- We fix this by setting the correct instance_id.

UPDATE auth.users 
SET instance_id = '00000000-0000-0000-0000-000000000000' 
WHERE instance_id IS NULL;
