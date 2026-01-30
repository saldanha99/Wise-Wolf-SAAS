-- ============================================================================
-- SCRIPT DE CORREÇÃO MANUAL V2 - SINCRONIZAÇÃO POR SUBSCRIPTION ID
-- ============================================================================

-- 1. Inserir Transação Financeira Manualmente para Assinatura Específica
INSERT INTO financial_transactions (
    tenant_id, 
    type, 
    category, 
    amount, 
    description, 
    reference_id, 
    created_at
)
SELECT 
    p.tenant_id, 
    'ENTRADA', 
    'MENSALIDADE', 
    297.00, 
    'Mensalidade Plano Anual (Sincronização Pós-Erro UUID)', 
    p.id, 
    '2026-01-17 03:03:51' -- Data exata solicitada
FROM profiles p 
WHERE p.asaas_subscription_id = 'sub_ewq05qprmh144le4'
   OR p.asaas_customer_id = 'cus_000006323631' -- Fallback caso subscription ID não esteja salvo
ON CONFLICT DO NOTHING;

-- 2. Atualizar Status do Pagamento (Se existir registro em student_payments com erro)
-- Tenta achar o pagamento ligado a essa subscription ou customer e força status RECEIVED
UPDATE student_payments
SET status = 'RECEIVED', updated_at = NOW()
WHERE asaas_payment_id IN (
    SELECT id FROM student_payments 
    WHERE student_id IN (SELECT id FROM profiles WHERE asaas_subscription_id = 'sub_ewq05qprmh144le4')
    AND status != 'RECEIVED'
);

RAISE NOTICE 'Sincronização manual concluída para sub_ewq05qprmh144le4.';
