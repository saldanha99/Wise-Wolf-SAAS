-- ============================================================================
-- SCRIPT DE CORREÇÃO V3 - FORÇAR APARECIMENTO NO DASHBOARD
-- ============================================================================

DO $$
DECLARE
    v_target_tenant UUID;
    v_student_id UUID;
    v_count INTEGER;
BEGIN
    -- 1. Identificar o Tenant ID Principal (Baseado no primeiro Admin/Diretor encontrado)
    SELECT tenant_id INTO v_target_tenant 
    FROM profiles 
    WHERE role IN ('SCHOOL_ADMIN', 'DIRECTOR', 'admin') 
    AND tenant_id IS NOT NULL 
    LIMIT 1;

    -- 2. Identificar o Aluno da Assinatura
    SELECT id INTO v_student_id
    FROM profiles
    WHERE asaas_subscription_id = 'sub_ewq05qprmh144le4'
       OR asaas_customer_id = 'cus_000006323631';

    IF v_target_tenant IS NOT NULL AND v_student_id IS NOT NULL THEN
        RAISE NOTICE 'Tenant Principal: %', v_target_tenant;
        RAISE NOTICE 'Aluno ID: %', v_student_id;

        -- 3. Corrigir o Aluno (Garantir que ele pertence à escola)
        UPDATE profiles
        SET tenant_id = v_target_tenant
        WHERE id = v_student_id AND (tenant_id IS NULL OR tenant_id != v_target_tenant);

        -- 4. Corrigir a Transação Financeira (Garantir que pertence à escola para aparecer no Dashboard)
        UPDATE financial_transactions
        SET tenant_id = v_target_tenant
        WHERE reference_id = v_student_id
          AND category = 'MENSALIDADE'
          AND amount = 297.00;
          
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RAISE NOTICE 'Transações corrigidas/confirmadas: %', v_count;

    ELSE
        RAISE NOTICE 'ERRO: Não foi possível identificar o Tenant ou o Aluno.';
        IF v_target_tenant IS NULL THEN RAISE NOTICE 'Motivo: Tenant Admin não encontrado.'; END IF;
        IF v_student_id IS NULL THEN RAISE NOTICE 'Motivo: Aluno da assinatura não encontrado.'; END IF;
    END IF;
END $$;
