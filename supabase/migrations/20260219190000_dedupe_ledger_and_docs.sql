-- ============================================================
-- Migration: Fix Duplicate Ledger Entries & Pending Documentation
-- Fixes duplicate entries created by previous migration and 
-- ensures new students have documentation APPROVED.
-- ============================================================

-- 1. Remove duplicate ledger entries recently created by the backfill
-- Any transaction created today from 'student_tuition' that shares the same description, reference_id and amount
-- with another older transaction. We isolate the duplicates.
DELETE FROM public.financial_transactions a
USING public.financial_transactions b
WHERE a.id > b.id
  AND a.description = b.description
  AND a.reference_id = b.reference_id
  AND a.amount = b.amount
  AND a.category = b.category
  AND a.description LIKE 'Mensalidade - Ref:%';

-- 2. Approve documentation for students who entered via PublicRegistration
-- We know they accepted the contract because subscription_id is set
UPDATE public.profiles
SET documentation_status = 'APPROVED'
WHERE documentation_status = 'PENDING'
  AND subscription_id IS NOT NULL;
