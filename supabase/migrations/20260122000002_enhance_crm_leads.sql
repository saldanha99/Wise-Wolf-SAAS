-- Enhancement for CRM Leads (Rich UI Support)
-- Adds columns for value, tags, and tracking time in stage.

DO $$
BEGIN
    -- 1. Deal Value (Numeric for calculations)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'crm_leads' AND column_name = 'value') THEN
        ALTER TABLE public.crm_leads ADD COLUMN value NUMERIC DEFAULT 0;
    END IF;

    -- 2. Tags (Array of strings for badges)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'crm_leads' AND column_name = 'tags') THEN
        ALTER TABLE public.crm_leads ADD COLUMN tags TEXT[] DEFAULT '{}';
    END IF;

    -- 3. Last Status Change (To track "stagnant" leads)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'crm_leads' AND column_name = 'last_status_change') THEN
        ALTER TABLE public.crm_leads ADD COLUMN last_status_change TIMESTAMPTZ DEFAULT NOW();
    END IF;

END $$;

-- Update existing leads to have a default value if null
UPDATE public.crm_leads SET value = 297 WHERE value IS NULL;
