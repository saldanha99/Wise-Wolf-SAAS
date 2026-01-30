-- Add 'interests' column to opportunities if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'opportunities' AND column_name = 'interests') THEN
        ALTER TABLE opportunities ADD COLUMN interests TEXT;
    END IF;
END $$;

-- Inspect whatsapp_instances to check connectivity
SELECT * FROM whatsapp_instances ORDER BY updated_at DESC LIMIT 5;
