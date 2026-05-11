-- INSPECT TRIGGERS on storage.objects
SELECT 
    trigger_name,
    event_manipulation,
    action_statement
FROM 
    information_schema.triggers
WHERE 
    event_object_schema = 'storage' 
    AND event_object_table = 'objects';
