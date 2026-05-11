-- Add Digital Signature Metadata to Profiles
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS user_ip TEXT,
ADD COLUMN IF NOT EXISTS contract_accepted BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;

-- Refresh schema cache
NOTIFY pgrst, 'reload schema';
