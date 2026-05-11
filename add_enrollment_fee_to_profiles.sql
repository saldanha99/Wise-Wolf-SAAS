-- Add enrollment fee configuration to profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS enrollment_fee DECIMAL(10,2) DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS enrollment_fee_paid BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS enrollment_payment_id TEXT;

-- Update existing students to have no fee paid
UPDATE profiles SET enrollment_fee = 0, enrollment_fee_paid = true WHERE role = 'STUDENT' AND enrollment_fee IS NULL;
