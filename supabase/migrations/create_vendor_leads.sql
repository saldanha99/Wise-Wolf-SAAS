-- Tabela para candidatos a vendedor (captados pelo formulário /vendedores)
CREATE TABLE IF NOT EXISTS public.vendor_leads (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome        TEXT NOT NULL,
    email       TEXT NOT NULL,
    whatsapp    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    status      TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'contacted', 'hired', 'rejected'))
);

-- Índice para busca por e-mail e status
CREATE INDEX IF NOT EXISTS vendor_leads_email_idx  ON public.vendor_leads (email);
CREATE INDEX IF NOT EXISTS vendor_leads_status_idx ON public.vendor_leads (status);

-- RLS: somente admins lêem/escrevem; insert anônimo liberado para o formulário público
ALTER TABLE public.vendor_leads ENABLE ROW LEVEL SECURITY;

-- Qualquer pessoa autenticada ou anônima pode inserir (formulário público)
CREATE POLICY "vendor_leads_insert_public"
    ON public.vendor_leads
    FOR INSERT
    WITH CHECK (true);

-- Apenas usuários autenticados com role ADMIN ou SUPER_ADMIN podem ler
CREATE POLICY "vendor_leads_select_admin"
    ON public.vendor_leads
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
              AND profiles.role IN ('ADMIN', 'SUPER_ADMIN')
        )
    );

-- Apenas admins podem atualizar status
CREATE POLICY "vendor_leads_update_admin"
    ON public.vendor_leads
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
              AND profiles.role IN ('ADMIN', 'SUPER_ADMIN')
        )
    );
