-- ============================================================
-- Migration: Deduplicate Caixa Subscriptions and Reload Cache
-- Fixes duplicated entries (same reference, same amount, same month)
-- and triggers postgREST to reload its schema cache.
-- ============================================================

-- 1. Remove duplicate ledger entries for the same student, amount, and month
DELETE FROM public.financial_transactions a
USING public.financial_transactions b
WHERE a.id > b.id
  AND a.reference_id = b.reference_id
  AND a.amount = b.amount
  AND a.category IN ('MENSALIDADE', 'student_tuition')
  AND b.category IN ('MENSALIDADE', 'student_tuition')
  AND date_trunc('month', a.created_at) = date_trunc('month', b.created_at);

-- 2. Force PostgREST to reload the schema cache so new columns like professor_id are exposed
NOTIFY pgrst, 'reload schema';
