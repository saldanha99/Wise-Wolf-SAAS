-- Backfill Financial Transactions from Student Payments
-- This ensures that all payments marked as 'RECEIVED' or 'CONFIRMED' found in student_payments
-- have a corresponding entry in financial_transactions.

INSERT INTO public.financial_transactions (
    tenant_id,
    type,
    category,
    amount,
    amount_cents,
    description,
    reference_id,
    created_at
)
SELECT 
    sp.tenant_id,
    'ENTRADA',
    'student_tuition',
    sp.value,
    (sp.value * 100)::INTEGER,
    'Mensalidade (Sincronizada) - ' || COALESCE(p.full_name, 'Aluno'),
    sp.student_id,
    COALESCE(sp.payment_date, sp.due_date, sp.created_at) -- Use payment date if avail, else due date
FROM 
    public.student_payments sp
LEFT JOIN 
    public.profiles p ON sp.student_id = p.id
WHERE 
    (sp.status = 'RECEIVED' OR sp.status = 'CONFIRMED')
    AND NOT EXISTS (
        -- Check if a transaction already exists for this payment/student around the same time?
        -- Since we didn't link ID strictly before, we can use a basic heuristic or just insert all 
        -- ignoring duplicates if we trust the ledger was empty-ish.
        -- BETTER: Check if we have a transaction for this student with same amount in the same month.
        -- However, simpler is: If we assume financial_transactions is the SSOT, we might have holes.
        -- Let's rely on a check to avoid massive duplications if run twice.
        SELECT 1 FROM public.financial_transactions ft 
        WHERE ft.reference_id = sp.student_id 
        AND ft.amount = sp.value
        AND ft.created_at::date = COALESCE(sp.payment_date, sp.due_date, sp.created_at)::date
    );

-- Also ensuring Asaas Customers have notification enabled (Update local mirrors if needed? No, this is remote).
-- We can't update Asaas via SQL.
