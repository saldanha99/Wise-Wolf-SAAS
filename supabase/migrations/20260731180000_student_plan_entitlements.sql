-- Limite de uso do Wolfie por plano do aluno, com upgrade.
--
-- Espelha o padrão já provado em `hub_plan_entitlements` (feature_key +
-- limit_value + reset_period) em vez de inventar um sistema paralelo.
--
-- REGRA INEGOCIÁVEL: a cota mede APENAS a conversa ao vivo
-- (`wolfie.live_minutes`). Os modos por escrita não têm limite e não podem
-- ser bloqueados por esta tabela — custam ~10x menos que a voz e são o que
-- garante que o aluno nunca fica sem praticar.

CREATE TABLE IF NOT EXISTS public.student_plan_entitlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  plan_id      uuid REFERENCES public.student_pricing_plans(id) ON DELETE CASCADE,
  feature_key  text NOT NULL,
  limit_value  integer NOT NULL DEFAULT 0,
  reset_period text NOT NULL DEFAULT 'MONTH',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_plan_entitlements_period_check
    CHECK (reset_period IN ('MONTH', 'SUBSCRIPTION')),
  -- plan_id NULO = padrão do tenant, vale para aluno sem plano atribuído.
  CONSTRAINT student_plan_entitlements_unique
    UNIQUE (tenant_id, plan_id, feature_key)
);

COMMENT ON TABLE public.student_plan_entitlements IS
  'Limites por plano de aluno. Só mede voz ao vivo; escrita é ilimitada.';

ALTER TABLE public.student_plan_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS spe_read ON public.student_plan_entitlements;
CREATE POLICY spe_read ON public.student_plan_entitlements
  FOR SELECT TO authenticated
  USING (
    tenant_id = (SELECT p.tenant_id FROM public.profiles p WHERE p.id = auth.uid())
  );

-- Minutos ao vivo consumidos no mês. Derivados da duração real das sessões
-- do Realtime; tokens continuam guardados à parte como verdade de custo.
CREATE TABLE IF NOT EXISTS public.student_live_minutes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  student_id  uuid NOT NULL,
  session_id  uuid,
  seconds     integer NOT NULL DEFAULT 0,
  source      text NOT NULL DEFAULT 'openai_realtime',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_minutes_student_time
  ON public.student_live_minutes (tenant_id, student_id, created_at DESC);

ALTER TABLE public.student_live_minutes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS slm_read_own ON public.student_live_minutes;
CREATE POLICY slm_read_own ON public.student_live_minutes
  FOR SELECT TO authenticated USING (student_id = auth.uid());

-- Saldo do aluno. Usada pela edge function (gate) e pelo medidor na tela.
-- Devolve jsonb para não sofrer com tipos de RETURNS TABLE.
CREATE OR REPLACE FUNCTION public.wolfie_live_balance(
  p_tenant_id text,
  p_student_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit   integer;
  v_plan    uuid;
  v_used    integer;
  v_start   date := date_trunc('month', current_date)::date;
BEGIN
  SELECT sp.id INTO v_plan
  FROM public.profiles p
  LEFT JOIN public.student_pricing_plans sp
    ON sp.tenant_id = p.tenant_id AND sp.name = p.fidelity_plan
  WHERE p.id = p_student_id;

  -- Entitlement do plano; se não houver, o padrão do tenant (plan_id NULO).
  SELECT e.limit_value INTO v_limit
  FROM public.student_plan_entitlements e
  WHERE e.tenant_id = p_tenant_id
    AND e.feature_key = 'wolfie.live_minutes'
    AND (e.plan_id = v_plan OR e.plan_id IS NULL)
  ORDER BY e.plan_id NULLS LAST
  LIMIT 1;

  -- Sem entitlement configurado = sem limite. Nunca bloqueia por omissão.
  IF v_limit IS NULL OR v_limit <= 0 THEN
    RETURN jsonb_build_object('enforced', false, 'allowed', true);
  END IF;

  SELECT COALESCE(ceil(sum(m.seconds) / 60.0), 0)::int INTO v_used
  FROM public.student_live_minutes m
  WHERE m.tenant_id = p_tenant_id AND m.student_id = p_student_id
    AND m.created_at >= v_start
    AND m.created_at < (v_start + interval '1 month');

  RETURN jsonb_build_object(
    'enforced',  true,
    'allowed',   v_used < v_limit,
    'used',      v_used,
    'limit',     v_limit,
    'remaining', GREATEST(0, v_limit - v_used)
  );
EXCEPTION WHEN others THEN
  -- Falha de contabilidade nunca tira a aula do aluno.
  RETURN jsonb_build_object('enforced', false, 'allowed', true,
                            'reason', 'balance_check_failed');
END;
$$;

REVOKE ALL ON FUNCTION public.wolfie_live_balance(text, uuid) FROM public;

-- Medidor do próprio aluno (é o que faz o upgrade ser comprado).
CREATE OR REPLACE FUNCTION public.my_wolfie_live_balance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_tenant text;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = auth.uid();
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('enforced', false, 'allowed', true);
  END IF;
  RETURN public.wolfie_live_balance(v_tenant, auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION public.my_wolfie_live_balance() FROM public;
GRANT EXECUTE ON FUNCTION public.my_wolfie_live_balance() TO authenticated;

-- Registra o tempo consumido ao encerrar a sessão ao vivo.
CREATE OR REPLACE FUNCTION public.record_wolfie_live_seconds(
  p_session_id uuid,
  p_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant text;
  v_secs   integer;
BEGIN
  -- Teto de 1h por lançamento: protege contra relógio do cliente maluco.
  v_secs := LEAST(GREATEST(COALESCE(p_seconds, 0), 0), 3600);
  IF v_secs <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sem_tempo');
  END IF;

  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = auth.uid();
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sem_perfil');
  END IF;

  INSERT INTO public.student_live_minutes
    (tenant_id, student_id, session_id, seconds)
  VALUES (v_tenant, auth.uid(), p_session_id, v_secs);

  RETURN jsonb_build_object('ok', true, 'seconds', v_secs);
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'falha_ao_registrar');
END;
$$;

REVOKE ALL ON FUNCTION public.record_wolfie_live_seconds(uuid, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.record_wolfie_live_seconds(uuid, integer)
  TO authenticated;

-- Diretor define o limite do plano (ou o padrão do tenant, com plan_id NULO).
CREATE OR REPLACE FUNCTION public.set_student_plan_entitlement(
  p_plan_id uuid,
  p_feature_key text,
  p_limit_value integer
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
  -- Trava explícita: nenhuma funcionalidade de escrita pode ser limitada aqui.
  IF p_feature_key <> 'wolfie.live_minutes' THEN
    RAISE EXCEPTION 'apenas_voz_ao_vivo_pode_ter_limite';
  END IF;

  INSERT INTO public.student_plan_entitlements
    (tenant_id, plan_id, feature_key, limit_value, reset_period)
  VALUES (v_tenant, p_plan_id, p_feature_key,
          GREATEST(COALESCE(p_limit_value, 0), 0), 'MONTH')
  ON CONFLICT (tenant_id, plan_id, feature_key) DO UPDATE
    SET limit_value = EXCLUDED.limit_value;

  RETURN jsonb_build_object('ok', true, 'limit', p_limit_value);
END;
$$;

REVOKE ALL ON FUNCTION
  public.set_student_plan_entitlement(uuid, text, integer) FROM public;
GRANT EXECUTE ON FUNCTION
  public.set_student_plan_entitlement(uuid, text, integer) TO authenticated;
