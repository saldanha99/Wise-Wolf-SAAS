-- Compra de minutos adicionais de conversa ao vivo.
--
-- O crédito comprado SOMA ao limite do plano, não o substitui: quem comprou
-- 60 min num plano de 30 continua ganhando os 30 do mês seguinte.
--
-- Créditos NÃO expiram no virar do mês (o aluno pagou por eles), diferente da
-- franquia do plano, que é mensal e não cumulativa.

CREATE TABLE IF NOT EXISTS public.wolfie_topup_packages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  name        text NOT NULL,
  minutes     integer NOT NULL,
  price_brl   numeric(10,2) NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wolfie_topup_minutes_check CHECK (minutes > 0),
  CONSTRAINT wolfie_topup_price_check CHECK (price_brl >= 0)
);

ALTER TABLE public.wolfie_topup_packages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wtp_read ON public.wolfie_topup_packages;
CREATE POLICY wtp_read ON public.wolfie_topup_packages
  FOR SELECT TO authenticated
  USING (
    active
    AND tenant_id = (SELECT p.tenant_id FROM public.profiles p WHERE p.id = auth.uid())
  );

-- Créditos efetivamente pagos. Uma linha por compra confirmada.
CREATE TABLE IF NOT EXISTS public.student_minute_credits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  student_id  uuid NOT NULL,
  minutes     integer NOT NULL,
  payment_id  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_minute_credits_positive CHECK (minutes > 0)
);

-- Idempotência: o Asaas reenvia webhook, e crédito duplicado é prejuízo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_minute_credits_payment
  ON public.student_minute_credits (payment_id)
  WHERE payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_minute_credits_student
  ON public.student_minute_credits (tenant_id, student_id);

ALTER TABLE public.student_minute_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS smc_read_own ON public.student_minute_credits;
CREATE POLICY smc_read_own ON public.student_minute_credits
  FOR SELECT TO authenticated USING (student_id = auth.uid());

-- Credita minutos após pagamento confirmado. Idempotente por payment_id.
CREATE OR REPLACE FUNCTION public.credit_wolfie_minutes(
  p_student_id uuid,
  p_minutes integer,
  p_payment_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant   text;
  v_min      integer := GREATEST(COALESCE(p_minutes, 0), 0);
  v_inserted integer := 0;
BEGIN
  IF p_student_id IS NULL OR v_min <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entrada_invalida');
  END IF;

  SELECT p.tenant_id INTO v_tenant
  FROM public.profiles p WHERE p.id = p_student_id;
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'aluno_nao_encontrado');
  END IF;

  -- O índice é PARCIAL (WHERE payment_id IS NOT NULL), então o ON CONFLICT
  -- precisa repetir o mesmo predicado — sem ele o Postgres não encontra o
  -- índice e o INSERT falha, o que faria um webhook reenviado creditar duas
  -- vezes. Mesma pegadinha já documentada em uq_bookings_no_dup_active.
  INSERT INTO public.student_minute_credits
    (tenant_id, student_id, minutes, payment_id)
  VALUES (v_tenant, p_student_id, v_min, NULLIF(p_payment_id, ''))
  ON CONFLICT (payment_id) WHERE payment_id IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('ok', true, 'idempotente', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'minutes', v_min);
END;
$$;

REVOKE ALL ON FUNCTION
  public.credit_wolfie_minutes(uuid, integer, text) FROM public;

-- Saldo passa a somar a franquia do plano + os minutos comprados.
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
  v_limit    integer;
  v_plan     uuid;
  v_used     integer;
  v_credits  integer;
  v_total    integer;
  v_start    date := date_trunc('month', current_date)::date;
BEGIN
  SELECT sp.id INTO v_plan
  FROM public.profiles p
  LEFT JOIN public.student_pricing_plans sp
    ON sp.tenant_id = p.tenant_id AND sp.name = p.fidelity_plan
  WHERE p.id = p_student_id;

  SELECT e.limit_value INTO v_limit
  FROM public.student_plan_entitlements e
  WHERE e.tenant_id = p_tenant_id
    AND e.feature_key = 'wolfie.live_minutes'
    AND (e.plan_id = v_plan OR e.plan_id IS NULL)
  ORDER BY e.plan_id NULLS LAST
  LIMIT 1;

  IF v_limit IS NULL OR v_limit <= 0 THEN
    RETURN jsonb_build_object('enforced', false, 'allowed', true);
  END IF;

  -- Consumo do mês corrente (a franquia é mensal, não cumulativa).
  SELECT COALESCE(ceil(sum(m.seconds) / 60.0), 0)::int INTO v_used
  FROM public.student_live_minutes m
  WHERE m.tenant_id = p_tenant_id AND m.student_id = p_student_id
    AND m.created_at >= v_start
    AND m.created_at < (v_start + interval '1 month');

  -- Créditos comprados NÃO expiram: o aluno pagou por eles.
  SELECT COALESCE(sum(c.minutes), 0)::int INTO v_credits
  FROM public.student_minute_credits c
  WHERE c.tenant_id = p_tenant_id AND c.student_id = p_student_id;

  v_total := v_limit + v_credits;

  RETURN jsonb_build_object(
    'enforced',  true,
    'allowed',   v_used < v_total,
    'used',      v_used,
    'limit',     v_total,
    'plan_limit', v_limit,
    'credits',   v_credits,
    'remaining', GREATEST(0, v_total - v_used)
  );
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('enforced', false, 'allowed', true,
                            'reason', 'balance_check_failed');
END;
$$;

REVOKE ALL ON FUNCTION public.wolfie_live_balance(text, uuid) FROM public;

-- Pacotes recomendados (31/07/2026). O diretor ajusta preço/minutos depois.
INSERT INTO public.wolfie_topup_packages (tenant_id, name, minutes, price_brl)
SELECT 'school-wise-wolf', v.name, v.minutes, v.price
FROM (VALUES
  ('60 minutos extras',  60,  39.90),
  ('180 minutos extras', 180, 99.90)
) AS v(name, minutes, price)
WHERE NOT EXISTS (
  SELECT 1 FROM public.wolfie_topup_packages p
  WHERE p.tenant_id = 'school-wise-wolf' AND p.minutes = v.minutes
);
