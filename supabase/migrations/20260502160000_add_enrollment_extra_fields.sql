-- ============================================================
-- Migration: Add extra fields to enrollment links and intents
-- Matches the new features in TrialsToContracts wizard
-- ============================================================

BEGIN;

-- 1. Update enrollment_intents
ALTER TABLE public.enrollment_intents 
ADD COLUMN IF NOT EXISTS professor_id2 UUID REFERENCES public.profiles(id),
ADD COLUMN IF NOT EXISTS enrollment_fee NUMERIC(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS start_date DATE;

-- 2. Update enrollment_links (legacy support)
ALTER TABLE public.enrollment_links 
ADD COLUMN IF NOT EXISTS professor_id2 UUID REFERENCES public.profiles(id),
ADD COLUMN IF NOT EXISTS enrollment_fee NUMERIC(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS start_date DATE;

-- 3. Update profiles
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS professor_id2 UUID REFERENCES public.profiles(id),
ADD COLUMN IF NOT EXISTS start_date DATE;

COMMIT;
