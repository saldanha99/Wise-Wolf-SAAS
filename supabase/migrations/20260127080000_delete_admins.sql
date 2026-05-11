-- DELETE ADMINS
-- The manually inserted users are causing API crashes ("Database error finding users").
-- We delete them explicitly so the API script can recreate them cleanly.

DELETE FROM auth.users 
WHERE email IN ('saldanha372@gmail.com', 'wisewolflanguague@gmail.com');
