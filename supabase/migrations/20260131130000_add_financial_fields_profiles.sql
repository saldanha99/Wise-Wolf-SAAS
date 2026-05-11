-- Add financial fields to profiles table for internal control
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS monthly_tuition NUMERIC(10,2),
ADD COLUMN IF NOT EXISTS fidelity_plan TEXT; -- e.g. '6 Meses', '12 Meses'
