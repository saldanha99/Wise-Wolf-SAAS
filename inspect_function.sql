-- INSPECT FUNCTION enforce_storage_limit
SELECT pg_get_functiondef(oid)
FROM pg_proc
WHERE proname = 'enforce_storage_limit';
