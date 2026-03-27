ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS rg TEXT,
ADD COLUMN IF NOT EXISTS cpf TEXT,
ADD COLUMN IF NOT EXISTS address TEXT,
ADD COLUMN IF NOT EXISTS birth_date DATE;

-- Ensure contract columns exist (might be already there from student)
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS contract_accepted BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
