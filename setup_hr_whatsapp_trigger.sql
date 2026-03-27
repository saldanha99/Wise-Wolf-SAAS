-- Trigger automático para disparar WhatsApp quando um novo currículo é recebido
-- Usa a extensão pg_net para chamar a Edge Function whatsapp-hr-welcome

CREATE EXTENSION IF NOT EXISTS pg_net;

-- 1. Criar a função de trigger
CREATE OR REPLACE FUNCTION public.notify_hr_applicant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  supabase_url TEXT;
  service_key TEXT;
  payload JSONB;
BEGIN
  -- Pegar as variáveis do vault ou hardcode da URL do projeto
  supabase_url := 'https://dvalxbtngopxopzcbfdm.supabase.co';
  
  -- Montar o payload com os dados do candidato
  payload := jsonb_build_object(
    'whatsapp', NEW.whatsapp,
    'name', NEW.name,
    'tenant_id', NEW.tenant_id
  );

  -- Disparar a Edge Function via pg_net (assíncrono, não bloqueia o INSERT)
  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/whatsapp-hr-welcome',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE'
    )::jsonb,
    body := payload
  );

  RETURN NEW;
END;
$$;

-- 2. Criar o trigger no INSERT da tabela job_applications
DROP TRIGGER IF EXISTS trigger_notify_hr_applicant ON public.job_applications;

CREATE TRIGGER trigger_notify_hr_applicant
  AFTER INSERT ON public.job_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_hr_applicant();
