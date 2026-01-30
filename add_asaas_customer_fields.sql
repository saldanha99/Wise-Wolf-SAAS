-- Add Asaas customer fields to profiles table
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS asaas_customer_id TEXT UNIQUE,
ADD COLUMN IF NOT EXISTS cpf TEXT,
ADD COLUMN IF NOT EXISTS address TEXT,
ADD COLUMN IF NOT EXISTS address_number TEXT,
ADD COLUMN IF NOT EXISTS postal_code TEXT;

-- Create an index for faster lookups by asaas_customer_id
CREATE INDEX IF NOT EXISTS idx_profiles_asaas_customer_id ON public.profiles(asaas_customer_id);

-- Create an index for cpf to help with duplicate checks locally if needed
CREATE INDEX IF NOT EXISTS idx_profiles_cpf ON public.profiles(cpf);
