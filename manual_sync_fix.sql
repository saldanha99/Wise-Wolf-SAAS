-- ============================================================================
-- SCRIPT DE CORREÇÃO MANUAL - SINCRONIZAÇÃO FINANCEIRA
-- ============================================================================

-- 1. Identificar o Aluno Comprometido (Backup por Email ou Nome)
-- Tenta achar "Antomio" (nome no Asaas) ou alguém com email compatível.
-- Substitua 'antonio%' pelo nome correto se necessário.

DO $$
DECLARE
    v_student_id UUID;
    v_tenant_id UUID;
    v_value DECIMAL := 297.00; -- Valor pago
BEGIN
    -- Tentativa de Localizar Aluno (Por Email ou Nome Aproximado)
    SELECT id, tenant_id INTO v_student_id, v_tenant_id
    FROM profiles
    WHERE email ILIKE '%antonio%' 
       OR full_name ILIKE '%antonio%' 
       OR full_name ILIKE '%sergio%' -- Tentando o outro nome mencionado
    LIMIT 1;

    IF v_student_id IS NOT NULL THEN
        RAISE NOTICE 'Aluno encontrado: % (ID: %)', v_student_id, v_tenant_id;

        -- 2. Inserir Transação Financeira Manualmente
        INSERT INTO financial_transactions (
            tenant_id, 
            type, 
            category, 
            amount, 
            description, 
            reference_id, 
            created_at
        )
        VALUES (
            v_tenant_id, 
            'ENTRADA', 
            'MENSALIDADE', 
            v_value, 
            'Mensalidade Plano Anual (Correção Manual)', 
            v_student_id, 
            NOW()
        );

        RAISE NOTICE 'Sucesso! Transação de R$ % criada para o ID %', v_value, v_student_id;
    ELSE
        RAISE NOTICE 'ERRO: Aluno não encontrado com os critérios de busca.';
    END IF;
END $$;
