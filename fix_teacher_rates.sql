-- 1. Standardize teacher hourly rates to R$ 8.00
-- This target teachers who were caught in the 16.00 or legacy 7.50 rates.

UPDATE public.profiles 
SET hourly_rate = 8.00 
WHERE role = 'TEACHER' 
AND (hourly_rate = 16.00 OR hourly_rate = 7.50 OR hourly_rate IS NULL OR hourly_rate = 0);

-- 2. Recalculate PENDING teacher closings for the current period (April 2026)
-- We only update PENDING ones to avoid touching already PAID/APPROVED financial records unless manually requested.

UPDATE public.teacher_closings
SET 
  total_amount = total_lessons * 8.00,
  updated_at = NOW()
WHERE status = 'PENDENTE'
AND month_year = '2026-04'
AND (total_amount / NULLIF(total_lessons, 0)) != 8.00;

-- Verification Query (Run this manually in Supabase SQL Editor to confirm)
-- SELECT full_name, email, hourly_rate FROM public.profiles WHERE role = 'TEACHER';
-- SELECT month_year, total_lessons, total_amount, (total_amount / total_lessons) as effective_rate FROM public.teacher_closings WHERE status = 'PENDENTE';
