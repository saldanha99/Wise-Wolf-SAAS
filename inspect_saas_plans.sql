-- INSPECT SAAS PLANS TABLE
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'saas_plans';
