-- 1. Add Contract Columns to Profiles Table
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS contract_accepted BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS class_frequency TEXT,
ADD COLUMN IF NOT EXISTS signature_ip TEXT;

-- 2. Update existing records (Sync)
-- Assumes default frequency of '2x' for active students who haven't signed yet.
UPDATE profiles 
SET class_frequency = '2x' 
WHERE class_frequency IS NULL AND status_financial = 'ACTIVE';

-- 3. Verify
SELECT id, full_name, contract_accepted, class_frequency FROM profiles LIMIT 10;
