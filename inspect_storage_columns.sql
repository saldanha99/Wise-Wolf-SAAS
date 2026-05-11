-- INSPECT STORAGE COLUMNS
SELECT 
    column_name, 
    data_type, 
    udt_name
FROM 
    information_schema.columns
WHERE 
    table_schema = 'storage' 
    AND table_name = 'objects';
