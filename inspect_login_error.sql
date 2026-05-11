-- Check if the expected profiles exist
SELECT id, email, role, tenant_id FROM public.profiles;

-- Check triggers on auth.users
SELECT 
    event_object_schema as table_schema,
    event_object_table as table_name,
    trigger_schema,
    trigger_name,
    string_agg(event_manipulation, ',') as event,
    action_timing as activation,
    action_condition as condition,
    action_statement as definition
FROM information_schema.triggers
WHERE event_object_table = 'users'
AND event_object_schema = 'auth'
GROUP BY 1,2,3,4,6,7,8;
