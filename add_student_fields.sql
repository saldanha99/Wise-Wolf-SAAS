-- Add new columns to profiles table
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS private_notes TEXT,
ADD COLUMN IF NOT EXISTS fixed_schedule TEXT;

-- Comment on columns
COMMENT ON COLUMN public.profiles.private_notes IS 'Pedagogical notes visible only to teachers/admins';
COMMENT ON COLUMN public.profiles.fixed_schedule IS 'Fixed schedule description (e.g. "Seg/Qua - 14:00")';
