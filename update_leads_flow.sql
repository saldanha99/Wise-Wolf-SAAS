-- Enhance crm_leads for better qualification
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS level TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS goal TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS source TEXT; -- Ensure it exists
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

-- Allow class_logs to distinguish trial lessons
ALTER TABLE class_logs ADD COLUMN IF NOT EXISTS class_type TEXT DEFAULT 'REGULAR'; -- REGULAR, TRIAL, REPLACEMENT

-- Policy updates might be needed if columns are sensitive, but standard policies cover the row.
