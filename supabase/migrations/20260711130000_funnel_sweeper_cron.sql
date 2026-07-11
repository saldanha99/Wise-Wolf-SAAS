-- Wrapper cron do funnel-sweeper (padrão idêntico aos demais trigger_*: vault + net.http_post).
-- O funnel-sweeper (edge) roda 3 varreduras anti-vazamento do funil de alunos a cada 15 min:
--   A) primeiro toque em leads NEW nunca contatados (site/quiz/blog), lotes de 4, teto 24/dia;
--   B) escalonamento de oportunidade TRIAL sem aceite (>20min re-broadcast, >60min alerta diretor);
--   C) expiração de oportunidade OPEN >48h ou com slot no passado (EXPIRED + conversion LOST).
CREATE OR REPLACE FUNCTION public.trigger_funnel_sweeper()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    request_id bigint;
    service_key text;
BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'wisewolf_service_role_key' LIMIT 1;

    IF service_key IS NULL OR service_key = '' THEN
        RAISE WARNING 'Vault secret wisewolf_service_role_key not set';
        RETURN -1;
    END IF;

    SELECT net.http_post(
        url := 'https://dvalxbtngopxopzcbfdm.supabase.co/functions/v1/funnel-sweeper',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000
    ) INTO request_id;
    RETURN request_id;
END;
$$;

-- Agenda (re)criando de forma idempotente
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wisewolf-funnel-sweeper') THEN
        PERFORM cron.unschedule('wisewolf-funnel-sweeper');
    END IF;
    PERFORM cron.schedule('wisewolf-funnel-sweeper', '*/15 * * * *', 'SELECT trigger_funnel_sweeper();');
END;
$$;
