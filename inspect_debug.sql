-- List all triggers on auth.users
SELECT 
    trigger_name,
    event_manipulation,
    action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'auth'
AND event_object_table = 'users';

-- Check if our users exist
SELECT id, email, last_sign_in_at FROM auth.users WHERE email IN ('saldanha372@gmail.com', 'wisewolflanguague@gmail.com');

-- Check if profiles exist
SELECT id, email, role FROM public.profiles WHERE email IN ('saldanha372@gmail.com', 'wisewolflanguague@gmail.com');
