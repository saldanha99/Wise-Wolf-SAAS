-- Redefine v_school_cashflow_summary to ensure it includes ALL financial_transactions
-- specifically manual ones that might have been excluded by previous view logic.

CREATE OR REPLACE VIEW public.v_school_cashflow_summary AS
SELECT
    tenant_id,
    date_trunc('month', occurred_at) as month,
    COALESCE(SUM(amount_cents) FILTER (WHERE type = 'ENTRADA'), 0) as total_entry_cents,
    COALESCE(SUM(amount_cents) FILTER (WHERE type = 'SAIDA'), 0) as total_exit_cents,
    (
        COALESCE(SUM(amount_cents) FILTER (WHERE type = 'ENTRADA'), 0) -
        COALESCE(SUM(amount_cents) FILTER (WHERE type = 'SAIDA'), 0)
    ) as balance_cents
FROM financial_transactions
GROUP BY 1, 2;

-- Grant access to authenticated users (admins/directors)
GRANT SELECT ON public.v_school_cashflow_summary TO authenticated;
