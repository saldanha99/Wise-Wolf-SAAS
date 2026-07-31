-- Alerta funcional da IA do Wolfie.
--
-- `notify_cron_failures` vigia CRON que falha. O bug da chamada ao vivo não
-- falhou nenhum cron: a edge function rodava perfeitamente e devolvia 502
-- porque a OpenAI recusava a sessão. Ficou 100% quebrada por dias, e só
-- soubemos quando o aluno reclamou.
--
-- Aqui exercitamos o caminho real e avisamos no WhatsApp do diretor, usando o
-- mesmo canal e a mesma idempotência (automation_sent) das outras automações.

CREATE TABLE IF NOT EXISTS public.wolfie_health_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_name text NOT NULL,
  healthy    boolean NOT NULL,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wolfie_health_time
  ON public.wolfie_health_log (check_name, created_at DESC);

ALTER TABLE public.wolfie_health_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.wolfie_health_log IS
  'Histórico do healthcheck da IA. Permite ver desde quando algo quebrou.';

-- Registra o resultado e alerta o diretor quando quebra.
-- Só alerta UMA vez por dia por check: alarme repetido vira ruído e passa a
-- ser ignorado, que é como uma quebra real deixa de ser vista.
CREATE OR REPLACE FUNCTION public.record_wolfie_health(
  p_check text,
  p_healthy boolean,
  p_detail text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_admin   record;
  v_msg     text;
  v_alerted boolean := false;
  v_was_ok  boolean;
BEGIN
  INSERT INTO public.wolfie_health_log (check_name, healthy, detail)
  VALUES (p_check, COALESCE(p_healthy, false), left(COALESCE(p_detail, ''), 500));

  IF COALESCE(p_healthy, false) THEN
    RETURN jsonb_build_object('ok', true, 'alerted', false);
  END IF;

  SELECT id, phone, tenant_id, whatsapp_instance INTO v_admin
  FROM profiles
  WHERE role = 'SCHOOL_ADMIN'
    AND whatsapp_instance IS NOT NULL AND phone IS NOT NULL
  ORDER BY tenant_id LIMIT 1;
  IF v_admin.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'alerted', false, 'reason', 'sem_admin');
  END IF;

  -- Um alerta por check por dia.
  IF EXISTS (
    SELECT 1 FROM automation_sent
    WHERE kind = 'WOLFIE_HEALTH' AND subject_id = p_check AND ref_date = current_date
  ) THEN
    RETURN jsonb_build_object('ok', true, 'alerted', false, 'reason', 'ja_avisado_hoje');
  END IF;

  -- Estava saudável antes? Serve para o texto dizer se é queda nova.
  SELECT healthy INTO v_was_ok FROM public.wolfie_health_log
  WHERE check_name = p_check AND created_at < now()
  ORDER BY created_at DESC OFFSET 1 LIMIT 1;

  v_msg := '🚨 *Wolfie fora do ar*' || E'\n\n' ||
           'A verificação automática de *' || p_check || '* falhou.' || E'\n\n' ||
           'Motivo: ' || left(COALESCE(p_detail, 'sem detalhe'), 220) || E'\n\n' ||
           CASE WHEN COALESCE(v_was_ok, false)
                THEN 'Funcionava na verificação anterior — a quebra é recente.'
                ELSE 'Também falhou na verificação anterior.' END ||
           E'\n\nOs alunos caem no modo clássico enquanto isso.';

  INSERT INTO automation_sent (kind, subject_id, ref_date)
  VALUES ('WOLFIE_HEALTH', p_check, current_date);

  PERFORM net.http_post(
    url := 'https://api.2b.app.br/message/sendText/' || v_admin.whatsapp_instance,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets
                 WHERE name = 'evolution_api_key' LIMIT 1)
    ),
    body := jsonb_build_object(
      'number', v_admin.phone, 'text', v_msg, 'delay', 0, 'linkPreview', false
    )
  );
  v_alerted := true;

  RETURN jsonb_build_object('ok', true, 'alerted', v_alerted);
END;
$$;

REVOKE ALL ON FUNCTION public.record_wolfie_health(text, boolean, text) FROM public;

-- Wrapper do cron: chama a edge e registra o veredito.
CREATE OR REPLACE FUNCTION public.trigger_wolfie_healthcheck()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_key text;
  v_req bigint;
BEGIN
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets
  WHERE name = 'wisewolf_service_role_key' LIMIT 1;
  IF v_key IS NULL THEN
    PERFORM public.record_wolfie_health('realtime', false, 'service role key ausente no vault');
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/wolfie-healthcheck',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) INTO v_req;
  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_wolfie_healthcheck() FROM public;

-- Lê a resposta do disparo anterior e registra/alerta. Separado do disparo
-- porque net.http_post é assíncrono: a resposta não existe no mesmo instante.
CREATE OR REPLACE FUNCTION public.collect_wolfie_healthcheck()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_resp    record;
  v_healthy boolean;
  v_reason  text;
BEGIN
  SELECT status_code, content INTO v_resp
  FROM net._http_response
  WHERE created > now() - interval '20 minutes'
  ORDER BY id DESC LIMIT 1;

  IF v_resp.status_code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sem_resposta');
  END IF;

  BEGIN
    v_healthy := (v_resp.content::jsonb ->> 'healthy')::boolean;
    v_reason  := COALESCE(v_resp.content::jsonb ->> 'reason', '');
  EXCEPTION WHEN others THEN
    v_healthy := false;
    v_reason  := 'resposta ilegível do healthcheck';
  END;

  RETURN public.record_wolfie_health('realtime', COALESCE(v_healthy, false), v_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.collect_wolfie_healthcheck() FROM public;
