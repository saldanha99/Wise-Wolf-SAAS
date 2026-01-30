-- ============================================================================
-- SCRIPT DE ATUALIZAÇÃO - NOTIFICAÇÃO DE MATRÍCULA
-- ============================================================================

-- Atualiza a função do gatilho para usar a nova rota 'whatsapp-notificacao-matricula'
CREATE OR REPLACE FUNCTION public.handle_contract_signed_hook()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.contract_accepted = TRUE AND OLD.contract_accepted = FALSE THEN
        UPDATE profiles SET contract_sent_at = NOW() WHERE id = NEW.id;

        -- Log para Auditoria
        INSERT INTO whatsapp_messages_log (student_id, phone, message_type, status)
        VALUES (NEW.id, NEW.phone, 'WELCOME_ENROLLMENT', 'QUEUED');

        -- Disparo para a Nova Edge Function
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

-- Reinicia o trigger (por segurança)
DROP TRIGGER IF EXISTS trg_contract_signed ON profiles;
CREATE TRIGGER trg_contract_signed
AFTER UPDATE ON profiles
FOR EACH ROW
EXECUTE FUNCTION public.handle_contract_signed_hook();

-- Trigger atualizado com sucesso.
