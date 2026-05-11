-- ============================================================================
-- SCRIPT DE CORREÇÃO AUTOMÁTICA - ALUNOS NOVOS SEM ESCOLA (TENANT)
-- ============================================================================
-- Este script localiza alunos criados recentemente que ficaram "sem escola" 
-- e os vincula à escola do Diretor principal, reprocessando seus pagamentos.

DO $$
DECLARE
    v_admin_tenant_id TEXT; -- Alterado para TEXT para suportar 'wise-wolf-school'
    v_count_fixed INTEGER := 0;
    v_count_payments INTEGER := 0;
BEGIN
    -- 1. IDENTIFICAR O TENANT PRINCIPAL (Escola Wise Wolf / Diretor)
    -- Busca o tenant_id do primeiro usuário ADMIN/SCHOOL_ADMIN encontrado
    SELECT tenant_id INTO v_admin_tenant_id 
    FROM profiles 
    WHERE role IN ('SCHOOL_ADMIN', 'ADMIN') 
    AND tenant_id IS NOT NULL 
    LIMIT 1;

    IF v_admin_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Não foi possível encontrar a Escola Principal automaticamente.';
    END IF;

    RAISE NOTICE 'Escola Principal Identificada: %', v_admin_tenant_id;

    -- 2. CORRIGIR ALUNOS RECENTES (Últimas 48h) SEM TENANT
    WITH updated_rows AS (
        UPDATE profiles
        SET tenant_id = v_admin_tenant_id
        WHERE created_at > NOW() - INTERVAL '48 hours'
        AND (tenant_id IS NULL)
        RETURNING id
    )
    SELECT count(*) INTO v_count_fixed FROM updated_rows;

    RAISE NOTICE 'Alunos corrigidos (vinculados à escola): %', v_count_fixed;

    -- 3. REPROCESSAR PAGAMENTOS DESSES ALUNOS
    -- Agora que os alunos têm escola, inserimos os pagamentos no caixa
    WITH inserted_payment AS (
        INSERT INTO financial_transactions (
            tenant_id, type, category, amount, description, reference_id, created_at
        )
        SELECT 
            p.tenant_id,
            'ENTRADA',
            'MENSALIDADE',
            sp.value,
            COALESCE(sp.description, 'Mensalidade (Sync Automático)'),
            sp.student_id,
            COALESCE(sp.payment_date, sp.updated_at, NOW())
        FROM student_payments sp
        JOIN profiles p ON sp.student_id = p.id
        WHERE 
            sp.status IN ('CONFIRMED', 'RECEIVED', 'PAGO', 'PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED')
            AND sp.value > 0
            AND p.tenant_id = v_admin_tenant_id
            AND sp.updated_at > NOW() - INTERVAL '48 hours' -- Apenas pagamentos recentes
            AND NOT EXISTS (
                SELECT 1 FROM financial_transactions ft 
                WHERE ft.reference_id = sp.student_id 
                AND ft.category = 'MENSALIDADE' 
                AND ft.amount = sp.value
            )
        RETURNING id
    )
    SELECT count(*) INTO v_count_payments FROM inserted_payment;

    RAISE NOTICE 'Pagamentos recuperados para o caixa: %', v_count_payments;

    -- 4. ATILIZAR O DASHBOARD (Force update timestamp if needed, otherwise data is live)
    -- Nenhuma ação extra necessária, o select do dashboard pegará os novos dados.

END $$;
