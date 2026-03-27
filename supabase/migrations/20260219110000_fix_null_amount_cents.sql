-- Fix NULL amount_cents in financial_transactions
-- This repairs manually created transactions that were missing this field.

UPDATE public.financial_transactions
SET 
    amount_cents = (amount * 100)::INTEGER,
    category = 'student_tuition', -- Normalize category
    occurred_at = COALESCE(occurred_at, created_at) -- Fallback if null
WHERE 
    amount_cents IS NULL 
    AND type = 'ENTRADA';
