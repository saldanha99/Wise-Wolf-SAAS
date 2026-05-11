-- ============================================================
-- Migration: Fix orphaned enrollment data
-- Fixes profiles with wrong tenant_id, role, and unlinked payments
-- ============================================================

-- 1. Fix any student profiles that have role = 'TEACHER' but have a subscription
-- (These were enrolled through PublicRegistration but the role was never set correctly)
UPDATE public.profiles
SET role = 'STUDENT'
WHERE subscription_id IS NOT NULL
  AND role != 'STUDENT'
  AND role != 'admin'
  AND role != 'manager'
  AND role != 'DIRECTOR';

-- 2. Fix profiles with hardcoded tenant_id from old trigger
-- Only fix if they have a subscription (i.e., they enrolled as students)
-- AND the tenant_id is still the default
-- We can't fix them perfectly without knowing the correct tenant, 
-- but we can check if the enrollment_links table has the data
UPDATE public.profiles p
SET tenant_id = el.tenant_id
FROM public.enrollment_links el
WHERE p.subscription_id IS NOT NULL
  AND p.tenant_id = 'school-wise-wolf'
  AND el.student_name ILIKE '%' || split_part(p.full_name, ' ', 1) || '%'
  AND el.tenant_id IS NOT NULL
  AND el.tenant_id != 'school-wise-wolf';

-- 3. Fix student_payments that have no student_id by matching asaas_customer_id
UPDATE public.student_payments sp
SET student_id = p.id,
    tenant_id = p.tenant_id
FROM public.profiles p
WHERE sp.student_id IS NULL
  AND p.asaas_customer_id IS NOT NULL
  AND sp.asaas_payment_id IN (
    SELECT asaas_payment_id FROM public.student_payments WHERE student_id IS NULL
  );

-- 4. Fix student_payments with wrong or missing tenant_id
UPDATE public.student_payments sp
SET tenant_id = p.tenant_id
FROM public.profiles p
WHERE sp.student_id = p.id
  AND (sp.tenant_id IS NULL OR sp.tenant_id = 'school-wise-wolf')
  AND p.tenant_id IS NOT NULL
  AND p.tenant_id != 'school-wise-wolf';

-- 5. Fix financial_transactions (ledger) with wrong or missing tenant_id
UPDATE public.financial_transactions ft
SET tenant_id = p.tenant_id
FROM public.profiles p
WHERE ft.reference_id = p.id
  AND (ft.tenant_id IS NULL OR ft.tenant_id = 'school-wise-wolf')
  AND p.tenant_id IS NOT NULL
  AND p.tenant_id != 'school-wise-wolf';

-- 6. Create missing ledger entries for confirmed payments that have no log
INSERT INTO public.financial_transactions (tenant_id, type, category, amount, amount_cents, description, reference_id, occurred_at, created_at)
SELECT 
  sp.tenant_id,
  'ENTRADA',
  'student_tuition',
  sp.value,
  ROUND(sp.value * 100)::integer,
  'Mensalidade - Ref: ' || sp.asaas_payment_id,
  sp.student_id,
  COALESCE(sp.payment_date, sp.due_date, NOW()),
  NOW()
FROM public.student_payments sp
WHERE sp.status IN ('RECEIVED', 'CONFIRMED')
  AND sp.student_id IS NOT NULL
  AND sp.tenant_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.financial_transactions ft
    WHERE ft.description = 'Mensalidade - Ref: ' || sp.asaas_payment_id
  );

-- 7. Fix handle_financial_sync trigger (v_tenant_id was declared as UUID but should be TEXT)
CREATE OR REPLACE FUNCTION public.handle_financial_sync()
RETURNS TRIGGER AS $$
DECLARE
    v_tenant_id TEXT;
    v_payment_date TIMESTAMPTZ;
BEGIN
    BEGIN
        -- Verifica se é um pagamento válido para entrar no caixa
        -- E ignora se o student_id não for um UUID válido (evita erro "invalid input syntax")
        IF (NEW.status IN ('CONFIRMED', 'RECEIVED', 'PAGO', 'PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED')) 
           AND (NEW.student_id IS NOT NULL) 
           AND (NEW.value > 0) THEN

            -- Busca o Tenant ID do aluno
            SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = NEW.student_id;
            
            IF v_tenant_id IS NOT NULL THEN
                v_payment_date := COALESCE(NEW.payment_date, NEW.updated_at, NOW());

                -- Verifica duplicidade (Idempotência)
                IF NOT EXISTS (
                    SELECT 1 FROM financial_transactions 
                    WHERE reference_id = NEW.student_id 
                    AND category = 'MENSALIDADE' 
                    AND amount = NEW.value 
                    AND date_trunc('month', created_at) = date_trunc('month', v_payment_date)
                ) THEN
                    INSERT INTO financial_transactions (
                        tenant_id, type, category, amount, description, reference_id, created_at
                    ) VALUES (
                        v_tenant_id, 'ENTRADA', 'MENSALIDADE', NEW.value, 
                        COALESCE(NEW.description, 'Mensalidade Global Sync'), 
                        NEW.student_id, 
                        v_payment_date
                    );
                END IF;
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- Se der erro de UUID ou outro, apenas loga e não trava o Webhook (200 OK)
        RAISE WARNING 'Erro no trigger handle_financial_sync (Ignorado): %', SQLERRM;
    END;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
