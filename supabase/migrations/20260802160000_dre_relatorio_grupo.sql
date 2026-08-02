-- Relatório gerencial no grupo de WhatsApp — agendamento e destino.
--
-- ⚠️ Nasce DESLIGADO (is_active default false) e sem nenhuma linha cadastrada.
-- Nada é enviado até o diretor configurar destino e cadência. Automação que
-- começa ligada manda mensagem para o grupo errado no primeiro deploy.
--
-- A cadência é do diretor, então quem decide "hoje envia?" é o banco, não um
-- cron por cadência. Um cron diário chama a edge; a edge pergunta ao banco quem
-- está no horário. Trocar de semanal para mensal vira um UPDATE, não um novo
-- agendamento — que é o que "administrável pelo grupo" exige.

CREATE TABLE IF NOT EXISTS public.dre_report_settings (
  tenant_id   text PRIMARY KEY,
  -- Grupo (…@g.us) ou telefone. O grupo é o caso pedido; telefone continua
  -- válido para quem não quer criar grupo.
  destino     text NOT NULL,
  cadencia    text NOT NULL DEFAULT 'semanal'
                CHECK (cadencia IN ('diaria','semanal','mensal')),
  -- 1 = segunda … 7 = domingo (ISO). Só é lido quando cadencia='semanal'.
  dia_semana  int  NOT NULL DEFAULT 1 CHECK (dia_semana BETWEEN 1 AND 7),
  is_active   boolean NOT NULL DEFAULT false,
  ultimo_envio_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dre_report_settings IS
  'Destino e cadência do relatório gerencial por WhatsApp. Sem linha ativa, nada é enviado.';

ALTER TABLE public.dre_report_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dre_report_settings_read ON public.dre_report_settings;
CREATE POLICY dre_report_settings_read ON public.dre_report_settings
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
                   AND p.role IN ('SCHOOL_ADMIN','SUPER_ADMIN')
                   AND (p.role = 'SUPER_ADMIN' OR p.tenant_id = dre_report_settings.tenant_id)));
GRANT SELECT ON public.dre_report_settings TO authenticated, service_role;

-- Leitura e escrita pela direção ----------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dre_report_settings()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; r record;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;

  SELECT * INTO r FROM dre_report_settings WHERE tenant_id = v_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('configurado', false, 'is_active', false,
                              'cadencia','semanal','dia_semana',1,'destino','');
  END IF;
  RETURN jsonb_build_object(
    'configurado', true,
    'destino', r.destino, 'cadencia', r.cadencia, 'dia_semana', r.dia_semana,
    'is_active', r.is_active, 'ultimo_envio_at', r.ultimo_envio_at);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_dre_report_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dre_report_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.save_dre_report_settings(
  p_destino text, p_cadencia text, p_dia_semana int DEFAULT 1,
  p_is_active boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; v_destino text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;

  v_destino := btrim(COALESCE(p_destino,''));
  IF v_destino = '' THEN RETURN jsonb_build_object('error','destino_obrigatorio'); END IF;
  -- Grupo do WhatsApp termina em @g.us; fora isso tem de ser telefone com DDD.
  IF v_destino NOT LIKE '%@g.us'
     AND length(regexp_replace(v_destino,'\D','','g')) < 10 THEN
    RETURN jsonb_build_object('error','destino_invalido');
  END IF;
  IF p_cadencia NOT IN ('diaria','semanal','mensal') THEN
    RETURN jsonb_build_object('error','cadencia_invalida');
  END IF;
  IF p_dia_semana IS NULL OR p_dia_semana NOT BETWEEN 1 AND 7 THEN
    RETURN jsonb_build_object('error','dia_invalido');
  END IF;

  INSERT INTO dre_report_settings (tenant_id, destino, cadencia, dia_semana, is_active)
  VALUES (v_tenant, v_destino, p_cadencia, p_dia_semana, COALESCE(p_is_active,true))
  ON CONFLICT (tenant_id) DO UPDATE
    SET destino = EXCLUDED.destino, cadencia = EXCLUDED.cadencia,
        dia_semana = EXCLUDED.dia_semana, is_active = EXCLUDED.is_active,
        updated_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.save_dre_report_settings(text,text,int,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_dre_report_settings(text,text,int,boolean) TO authenticated;

-- Quem está no horário agora --------------------------------------------------
-- Só service_role: é a lista que dispara mensagem de verdade.
-- p_force existe para o botão "enviar agora" do painel — devolve a escola pedida
-- ignorando a cadência, mas continua respeitando o dedupe do lado da edge.
CREATE OR REPLACE FUNCTION public.dre_report_targets(p_force_tenant text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_hoje date; v_dow int;
BEGIN
  -- Horário de Brasília: o cron roda em UTC, mas "dia 1" e "segunda-feira" são
  -- do calendário do diretor. Sem o ajuste, o relatório mensal sairia no dia 31.
  v_hoje := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_dow  := EXTRACT(ISODOW FROM v_hoje)::int;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'tenant_id', s.tenant_id,
             'escola',    COALESCE(t.name, s.tenant_id),
             'destino',   s.destino,
             'cadencia',  s.cadencia,
             -- Mensal fecha o mês anterior; diária e semanal olham o mês corrente.
             'month', CASE WHEN s.cadencia = 'mensal'
                           THEN to_char(v_hoje - interval '1 month','YYYY-MM')
                           ELSE to_char(v_hoje,'YYYY-MM') END,
             'ref_date', v_hoje,
             'instancia', (SELECT p.whatsapp_instance FROM profiles p
                            WHERE p.tenant_id = s.tenant_id
                              AND p.role IN ('SCHOOL_ADMIN','SUPER_ADMIN')
                              AND COALESCE(p.whatsapp_instance,'') <> ''
                            LIMIT 1)))
      FROM dre_report_settings s
      LEFT JOIN tenants t ON t.id = s.tenant_id
     WHERE s.is_active
       AND (p_force_tenant IS NOT NULL AND s.tenant_id = p_force_tenant
            OR p_force_tenant IS NULL AND (
                 s.cadencia = 'diaria'
              OR (s.cadencia = 'semanal' AND s.dia_semana = v_dow)
              OR (s.cadencia = 'mensal'  AND EXTRACT(DAY FROM v_hoje) = 1)))
  ), '[]'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.dre_report_targets(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dre_report_targets(text) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_dre_report_sent(p_tenant text)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  UPDATE dre_report_settings SET ultimo_envio_at = now() WHERE tenant_id = p_tenant;
$function$;

REVOKE ALL ON FUNCTION public.mark_dre_report_sent(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_dre_report_sent(text) TO service_role;

-- Cron ------------------------------------------------------------------------
-- Mesmo padrão de trigger_weekly_director_digest: lê a service key do vault e
-- chama a edge pelo kong interno.
CREATE OR REPLACE FUNCTION public.trigger_dre_report()
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE request_id bigint; service_key text;
BEGIN
  SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name='wisewolf_service_role_key' LIMIT 1;
  IF service_key IS NULL OR service_key='' THEN
    RAISE WARNING 'service key ausente'; RETURN -1;
  END IF;
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/dre-report',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'Authorization','Bearer '||service_key),
    body := '{}'::jsonb, timeout_milliseconds := 120000
  ) INTO request_id;
  RETURN request_id;
END;
$function$;

-- Um cron diário só; a cadência de cada escola é resolvida por dre_report_targets.
-- 11:20 UTC = 08:20 BRT, depois do daily-automations (11:00) para não competir.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('wisewolf-dre-report')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wisewolf-dre-report');
    PERFORM cron.schedule('wisewolf-dre-report', '20 11 * * *',
                          'SELECT trigger_dre_report();');
  END IF;
END
$cron$;
