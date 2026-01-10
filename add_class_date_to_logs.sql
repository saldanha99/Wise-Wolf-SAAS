-- Add class_date column to class_logs
ALTER TABLE class_logs ADD COLUMN IF NOT EXISTS class_date DATE;

-- Backfill existing logs with the date part of created_at
UPDATE class_logs 
SET class_date = created_at::DATE 
WHERE class_date IS NULL;

-- Make it not null after backfill
ALTER TABLE class_logs ALTER COLUMN class_date SET NOT NULL;

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_class_logs_class_date ON class_logs(class_date);
