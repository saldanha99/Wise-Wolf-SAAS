
-- Add monthly_fee to student profiles
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS monthly_fee DECIMAL(10,2) DEFAULT 0;

-- Optional: Seed some values for existing students if needed
-- UPDATE public.profiles SET monthly_fee = 349.90 WHERE role = 'STUDENT' AND monthly_fee = 0;
