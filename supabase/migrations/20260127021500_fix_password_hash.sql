-- FIX PASSWORD HASH: Use Pre-calculated Node.js Hash
-- Hash generated via bcryptjs: $2a$10$w... (actually $2b$10$YFPMxNJ43epuV1veC9hYIeNiLklf1ALfOZvnAP6qpvx/Hpk0fi7TW)
-- We insert the string directly to ensure 100% compatibility with Supabase auth which expects this format.

BEGIN;

-- Update Director Password
UPDATE auth.users 
SET encrypted_password = '$2b$10$YFPMxNJ43epuV1veC9hYIeNiLklf1ALfOZvnAP6qpvx/Hpk0fi7TW',
    updated_at = now()
WHERE email = 'wisewolflanguague@gmail.com';

-- Update Super Admin Password
UPDATE auth.users 
SET encrypted_password = '$2b$10$YFPMxNJ43epuV1veC9hYIeNiLklf1ALfOZvnAP6qpvx/Hpk0fi7TW',
    updated_at = now()
WHERE email = 'saldanha372@gmail.com';

COMMIT;
