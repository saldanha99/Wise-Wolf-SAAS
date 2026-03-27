/*
  DATABASE MAINTENANCE SCRIPT (COMPLETO v3 - AUDITORIA & FINANCEIRO)
  
  Objetivos Atendidos:
  1. GESTÃO DE INSTÂNCIAS: Colunas `whatsapp_instance` e `whatsapp_status`.
  2. AUDITORIA: Tabela `whatsapp_messages_log` para histórico de disparos.
  3. CAIXA: Sincronização abrangente para remover o "R$ 0,00" do dashboard.
  4. AUTOMAÇÃO: Triggers atualizados.
  
  EXECUÇÃO:
  Copie e rode no Supabase SQL Editor.
*/

-- ==============================================================================
-- 1. ALTERAÇÕES DE TABELA (USUÁRIOS / PERFIL)
-- ==============================================================================
DO $$
BEGIN
    -- Colunas Solicitadas
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'whatsapp_instance') THEN
        ALTER TABLE profiles ADD COLUMN whatsapp_instance TEXT;
    END IF;

    -- Mantendo retrocompatibilidade se já existir whatsapp_instance_name
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'whatsapp_instance_name') THEN
        -- Sincroniza dados antigos para a nova coluna se necessário
        UPDATE profiles SET whatsapp_instance = whatsapp_instance_name WHERE whatsapp_instance IS NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'whatsapp_status') THEN
        ALTER TABLE profiles ADD COLUMN whatsapp_status TEXT DEFAULT 'DISCONNECTED';
    END IF;

    -- Colunas de Rastreamento (Contrato e Welcome)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'contract_sent_at') THEN
        ALTER TABLE profiles ADD COLUMN contract_sent_at TIMESTAMPTZ;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'welcome_sent_at') THEN
        ALTER TABLE profiles ADD COLUMN welcome_sent_at TIMESTAMPTZ;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'typed_signature') THEN
        ALTER TABLE profiles ADD COLUMN typed_signature TEXT;
    END IF;

    -- Backfill de Email (Fundamental para Webhook Asaas)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'email') THEN
        ALTER TABLE profiles ADD COLUMN email TEXT;
    END IF;

    -- Sincroniza Emails de auth.users para profiles se estiver vazio
    UPDATE profiles 
    SET email = users.email
    FROM auth.users
    WHERE profiles.id = users.id AND profiles.email IS NULL;

    RAISE NOTICE 'Tabela profiles atualizada com sucesso.';
END $$;

-- ==============================================================================
-- 2. NOVA TABELA DE AUDITORIA (LOGS WHATSAPP)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS whatsapp_messages_log (
    id BIGSERIAL PRIMARY KEY,
    student_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    teacher_id UUID REFERENCES profiles(id) ON DELETE SET NULL, -- Quem disparou (ou system)
    phone TEXT NOT NULL,
    message_type TEXT NOT NULL, -- 'CONFIRMATION', 'RESCHEDULE', 'WELCOME', 'CONTRACT'
    content_preview TEXT,
    status TEXT DEFAULT 'SENT', -- 'SENT', 'FAILED'
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB
);

-- ==============================================================================
-- 3. SINCRONIZAÇÃO DE CAIXA (CORREÇÃO DE SALDO R$ 0,00)
-- ==============================================================================
DO $$
BEGIN
    RAISE NOTICE 'Sincronizando faturamento (incluindo status PAGO/CONFIRMED)...';
    
    -- Insere transações financeiras baseadas em pagamentos concluídos
    INSERT INTO financial_transactions (tenant_id, type, category, amount, description, reference_id, created_at)
    SELECT 
        p.tenant_id,
        'ENTRADA',
        'MENSALIDADE',
        sp.value,
        COALESCE(sp.description, 'Mensalidade (Sync)'),
        sp.student_id,
        COALESCE(sp.payment_date, sp.updated_at, NOW())
    FROM student_payments sp
    JOIN profiles p ON sp.student_id = p.id
    WHERE 
        -- Lista abrangente de status que indicam sucesso
        sp.status IN ('CONFIRMED', 'RECEIVED', 'PAGO', 'PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED') 
        AND sp.value > 0
    AND NOT EXISTS (
        -- Evita duplicidade
        SELECT 1 FROM financial_transactions ft 
        WHERE ft.reference_id = sp.student_id 
        AND ft.category = 'MENSALIDADE' 
        AND ft.amount = sp.value
        AND date_trunc('month', ft.created_at) = date_trunc('month', COALESCE(sp.payment_date::date, sp.updated_at::date, NOW()))
    );
    
    RAISE NOTICE 'Sincronização financeira concluída.';
END $$;

-- ==============================================================================
-- 4. TRIGGERS / FUNÇÕES (Atualizados para usar Logs se possível, ou mantidos simples)
-- ==============================================================================
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 4.1 Trigger Pagamento -> WhatsApp (Mantido)
CREATE OR REPLACE FUNCTION public.handle_new_payment_whatsapp()
RETURNS TRIGGER AS $$
DECLARE
    v_student_phone TEXT;
    v_student_name TEXT;
    v_contract_url TEXT;
    v_message TEXT;
BEGIN
    -- Verifica status de pagamento confirmado
    IF (NEW.status IN ('CONFIRMED', 'RECEIVED', 'PAGO', 'PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED')) 
       AND (OLD.status IS DISTINCT FROM NEW.status) THEN
       
        SELECT phone, full_name, signed_document_url 
        INTO v_student_phone, v_student_name, v_contract_url
        FROM profiles
        WHERE id = NEW.student_id;

        IF v_student_phone IS NOT NULL THEN
            IF v_contract_url IS NOT NULL AND Length(v_contract_url) > 0 THEN
                v_message := 'Olá ' || v_student_name || '! Pagamento confirmado. 🐺 Seu contrato: ' || v_contract_url;
            ELSE
                v_message := 'Olá ' || v_student_name || '! Pagamento confirmado na Wise Wolf. 🐺';
            END IF;

            -- Log de auditoria
            INSERT INTO whatsapp_messages_log (student_id, phone, message_type, content_preview)
            VALUES (NEW.student_id, v_student_phone, 'PAYMENT_CONFIRMATION', v_message);

            -- DISPARO COM A VARIÁVEL CORRIGIDA (v_student_phone)
            PERFORM net.http_post(
                url := 'https://dvalxbtngopxzcbfdm.supabase.co/functions/v1/whatsapp-wise-wolf',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
                ),
                body := jsonb_build_object('number', v_student_phone, 'message', v_message)
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger permanece o mesmo nome para substituir
DROP TRIGGER IF EXISTS trg_payment_whatsapp ON student_payments;
CREATE TRIGGER trg_payment_whatsapp
AFTER UPDATE ON student_payments
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_payment_whatsapp();

-- 4.2 Trigger Contrato -> WhatsApp (Mantido)
CREATE OR REPLACE FUNCTION public.handle_contract_signed_hook()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.contract_accepted = TRUE AND OLD.contract_accepted = FALSE THEN
        UPDATE profiles SET contract_sent_at = NOW() WHERE id = NEW.id;

        -- Log
        INSERT INTO whatsapp_messages_log (student_id, phone, message_type, status)
        VALUES (NEW.id, NEW.phone, 'CONTRACT_SIGNED', 'QUEUED');

        PERFORM net.http_post(
            url := 'https://dvalxbtngopxopzcbfdm.supabase.co/functions/v1/send-contract-confirmation',
            headers := '{"Content-Type": "application/json", "Authorization": "Bearer <SUPABASE_ANON_KEY>"}',
            body := jsonb_build_object(
                'student_name', NEW.full_name,
                'phone', NEW.phone,
                'class_frequency', COALESCE(NEW.class_frequency, '2'),
                'link_pdf', COALESCE(NEW.signed_document_url, 'https://aluno.wisewolf.com.br')
            )
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_contract_signed ON profiles;
CREATE TRIGGER trg_contract_signed
AFTER UPDATE ON profiles
FOR EACH ROW
EXECUTE FUNCTION public.handle_contract_signed_hook();

-- 4.3 Trigger Sincronização Financeira (Automática)
-- Garante que se o pagamento for vinculado a um aluno (UPDATE), ele entra no caixa automaticamente.
CREATE OR REPLACE FUNCTION public.handle_financial_sync()
RETURNS TRIGGER AS $$
DECLARE
    v_tenant_id UUID;
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

DROP TRIGGER IF EXISTS trg_sync_financial ON student_payments;
CREATE TRIGGER trg_sync_financial
AFTER INSERT OR UPDATE ON student_payments
FOR EACH ROW
EXECUTE FUNCTION public.handle_financial_sync();
