-- ============================================================================
-- ATUALIZAÇÃO DE CONTROLE WHATSAPP
-- ============================================================================

-- 1. Criação das Colunas de Controle
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS wa_welcome_sent BOOLEAN DEFAULT FALSE;

ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS whatsapp_instance TEXT; 
-- (Utilizado por Professores para salvar o nome da instância conectada)


-- 2. Atualização da Função de Disparo (com trava de segurança)
CREATE OR REPLACE FUNCTION public.handle_contract_signed_hook()
RETURNS TRIGGER AS $$
BEGIN
    -- Verifica se o contrato foi aceito E se a msg de boas-vindas AINDA NÃO foi enviada
    IF NEW.contract_accepted = TRUE AND (OLD.contract_accepted = FALSE OR OLD.wa_welcome_sent IS FALSE) AND NEW.wa_welcome_sent IS FALSE THEN
        
        -- Marca imediatamente como enviado para evitar duplo disparo (race condition)
        UPDATE profiles SET wa_welcome_sent = TRUE, contract_sent_at = NOW() WHERE id = NEW.id;

        -- Log para Auditoria
        INSERT INTO whatsapp_messages_log (student_id, phone, message_type, status)
        VALUES (NEW.id, NEW.phone, 'WELCOME_ENROLLMENT', 'QUEUED');

        -- Disparo para a Edge Function
        PERFORM net.http_post(
            url := 'https://dvalxbtngopxopzcbfdm.supabase.co/functions/v1/whatsapp-notificacao-matricula',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
            ),
            body := jsonb_build_object(
                'full_name', NEW.full_name,
                'phone', NEW.phone,
                'link_portal', COALESCE(NEW.signed_document_url, 'https://aluno.wisewolf.com.br')
            )
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Confirmação
-- Atualização concluída.
