-- Cota mensal de voz ao vivo por aluno.
--
-- DESLIGADA POR PADRÃO (enabled = false), de propósito: sem um mês de dados do
-- relatório de consumo qualquer número seria chute, e uma cota mal calibrada
-- bloquearia aluno pagante. O diretor liga depois de ver o custo real.
--
-- Quando estourar, o aluno NÃO fica sem aula: cai para o modo clássico, que
-- roda em TTS gratuito e modelos free. A cota tira o custo, não o serviço.

CREATE TABLE IF NOT EXISTS public.tenant_realtime_settings (
  tenant_id            text PRIMARY KEY,
  enabled              boolean NOT NULL DEFAULT false,
  monthly_token_quota  bigint  NOT NULL DEFAULT 2000000,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid
);

COMMENT ON TABLE public.tenant_realtime_settings IS
  'Cota mensal de tokens do modo ao vivo. enabled=false não limita nada.';
COMMENT ON COLUMN public.tenant_realtime_settings.monthly_token_quota IS
  'Teto de tokens por aluno por mês. Só vale quando enabled = true.';

ALTER TABLE public.tenant_realtime_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trs_read ON public.tenant_realtime_settings;
CREATE POLICY trs_read ON public.tenant_realtime_settings
  FOR SELECT TO authenticated
  USING (
    tenant_id = (SELECT p.tenant_id FROM public.profiles p WHERE p.id = auth.uid())
  );

-- Consumo do aluno no mês corrente + veredito. Usada pela edge function antes
-- de abrir a chamada; devolve jsonb para não sofrer com tipos de RETURNS TABLE.
CREATE OR REPLACE FUNCTION public.wolfie_realtime_quota_status(
  p_tenant_id text,
  p_student_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enabled boolean;
  v_quota   bigint;
  v_used    bigint;
  v_start   date := date_trunc('month', current_date)::date;
BEGIN
  SELECT s.enabled, s.monthly_token_quota INTO v_enabled, v_quota
  FROM public.tenant_realtime_settings s
  WHERE s.tenant_id = p_tenant_id;

  -- Sem linha configurada = cota desligada. Nunca bloqueia por omissão.
  IF v_enabled IS NOT TRUE OR COALESCE(v_quota, 0) <= 0 THEN
    RETURN jsonb_build_object('allowed', true, 'enforced', false);
  END IF;

  SELECT COALESCE(sum(
           COALESCE(t.usage_input_audio_tokens, 0)
         + COALESCE(t.usage_output_audio_tokens, 0)
         + COALESCE(t.usage_input_text_tokens, 0)
         + COALESCE(t.usage_output_text_tokens, 0)), 0)
    INTO v_used
  FROM public.wolfie_turns t
  JOIN public.wolfie_sessions ws ON ws.id = t.session_id
  WHERE t.source_kind = 'openai_realtime'
    AND ws.student_id = p_student_id
    AND ws.tenant_id  = p_tenant_id
    AND t.created_at >= v_start
    AND t.created_at <  (v_start + interval '1 month');

  RETURN jsonb_build_object(
    'allowed',  v_used < v_quota,
    'enforced', true,
    'used',     v_used,
    'quota',    v_quota
  );
EXCEPTION WHEN others THEN
  -- Falha de contabilidade nunca pode impedir a aula.
  RETURN jsonb_build_object('allowed', true, 'enforced', false,
                            'reason', 'quota_check_failed');
END;
$$;

REVOKE ALL ON FUNCTION
  public.wolfie_realtime_quota_status(text, uuid) FROM public;

-- Diretor lê e ajusta a cota da própria escola.
CREATE OR REPLACE FUNCTION public.save_realtime_settings(
  p_enabled boolean,
  p_monthly_token_quota bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant text;
  v_role   text;
BEGIN
  SELECT p.tenant_id, p.role INTO v_tenant, v_role
  FROM public.profiles p WHERE p.id = auth.uid();

  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN', 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'sem_permissao';
  END IF;
  IF p_monthly_token_quota IS NULL OR p_monthly_token_quota < 0 THEN
    RAISE EXCEPTION 'cota_invalida';
  END IF;

  INSERT INTO public.tenant_realtime_settings AS s
    (tenant_id, enabled, monthly_token_quota, updated_at, updated_by)
  VALUES (v_tenant, COALESCE(p_enabled, false), p_monthly_token_quota,
          now(), auth.uid())
  ON CONFLICT (tenant_id) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        monthly_token_quota = EXCLUDED.monthly_token_quota,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by;

  RETURN jsonb_build_object('ok', true, 'enabled', COALESCE(p_enabled, false),
                            'quota', p_monthly_token_quota);
END;
$$;

REVOKE ALL ON FUNCTION
  public.save_realtime_settings(boolean, bigint) FROM public;
GRANT EXECUTE ON FUNCTION
  public.save_realtime_settings(boolean, bigint) TO authenticated;
