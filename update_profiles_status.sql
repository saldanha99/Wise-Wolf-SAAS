
-- Add status column to profiles table to allow school admins to manage teacher status
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Ativo';

-- Update existing profiles to have the default 'Ativo' status
UPDATE public.profiles SET status = 'Ativo' WHERE status IS NULL;
