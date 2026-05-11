
-- Table for global financial transactions
CREATE TABLE IF NOT EXISTS public.financial_transactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    type TEXT NOT NULL, -- ENTRADA, SAIDA
    category TEXT NOT NULL, -- MENSALIDADE, SALARIO, INFRA, OUTROS
    amount DECIMAL(10,2) NOT NULL,
    description TEXT,
    reference_id UUID, -- Links to profile or closing
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.financial_transactions ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Super Admins can view all transactions"
    ON public.financial_transactions FOR SELECT
    USING (auth.uid() IN (SELECT id FROM profiles WHERE role = 'SUPER_ADMIN'));

CREATE POLICY "Admins can view transactions from their tenant"
    ON public.financial_transactions FOR SELECT
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
