-- Wrapper cron do post-trial-pipeline (padrão vault + net.http_post).
-- Ataca o vazamento entre "aula experimental dada" e "matrícula": trials realizados sem
-- proposta gerada (nudge ao aluno + alerta ao diretor, escalonando em 24h) e links de
-- matrícula PENDING esquecidos (cadência D1/D3/D7). Não decide preço/plano — só avisa e lembra.
CREATE OR REPLACE FUNCTION public.trigger_post_trial_pipeline()
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
        url := 'https://dvalxbtngopxopzcbfdm.supabase.co/functions/v1/post-trial-pipeline',
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

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wisewolf-post-trial-pipeline') THEN
        PERFORM cron.unschedule('wisewolf-post-trial-pipeline');
    END IF;
    PERFORM cron.schedule('wisewolf-post-trial-pipeline', '*/30 * * * *', 'SELECT trigger_post_trial_pipeline();');
END;
$$;
