-- Revert Sync Ledger
-- Deletes transactions created by the 'Mensalidade (Sincronizada)' backfill script.

DELETE FROM public.financial_transactions 
WHERE description LIKE 'Mensalidade (Sincronizada)%';
