-- FIX LOGIN: Copy Valid Hash from Test User
-- We created a test user 'temp_admin_%' via the API with password '123123'.
-- We now copy its valid encrypted_password to our Admin users.
-- This bypasses any hashing algorithm mismatches.

UPDATE auth.users
SET encrypted_password = (
    SELECT encrypted_password 
    FROM auth.users 
    WHERE email LIKE 'temp_admin_%@test.com' 
    ORDER BY created_at DESC 
    LIMIT 1
),
updated_at = now()
WHERE email IN ('saldanha372@gmail.com', 'wisewolflanguague@gmail.com');
