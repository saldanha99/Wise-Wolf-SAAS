-- Adiciona coluna school_info (JSONB) na tabela tenants
-- Armazena dados de identificação da escola para contratos multi-tenant
ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS school_info JSONB DEFAULT NULL;

COMMENT ON COLUMN public.tenants.school_info IS
    'Dados da escola para preenchimento do contrato (nome, cnpj, endereço, email, telefone, cidade, estado, diretor). Quando NULL, usa os dados padrão da Wise Wolf Language.';
