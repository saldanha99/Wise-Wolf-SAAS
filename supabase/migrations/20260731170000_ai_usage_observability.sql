-- Medição de custo de TODA IA do sistema, não só da voz ao vivo.
--
-- Motivo: as funções de escrita (wolfie-brain, pedagogical-content,
-- wolfie-activity, lesson-planner) rodam em modelos PAGOS
-- (anthropic/claude-haiku-4.5 na frente), e nada media o gasto delas. No
-- volume atual isso é barato (~US$6/mês), mas ninguém saberia se virasse caro:
-- o custo cresce com o número de alunos e não havia sinal nenhum.
--
-- `planner_ai_runs` já tinha coluna `usage` e estava com ZERO linhas — a
-- observabilidade existia no schema e não no código.

CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text,
  user_id        uuid,
  feature        text NOT NULL,
  provider       text NOT NULL DEFAULT 'openrouter',
  model          text NOT NULL DEFAULT '',
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  cached_tokens  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_usage_events IS
  'Um evento por chamada de IA. Base do custo por funcionalidade e por aluno.';

CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_time
  ON public.ai_usage_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_feature_time
  ON public.ai_usage_events (feature, created_at DESC);

ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;
-- Sem policy de leitura: só service_role (edge functions) e as RPCs abaixo.

-- Tabela de preços editável: os valores mudam e não podem ficar no código.
CREATE TABLE IF NOT EXISTS public.ai_model_pricing (
  model              text PRIMARY KEY,
  input_usd_per_1m   numeric(12,4) NOT NULL DEFAULT 0,
  output_usd_per_1m  numeric(12,4) NOT NULL DEFAULT 0,
  cached_usd_per_1m  numeric(12,4) NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_model_pricing ENABLE ROW LEVEL SECURITY;

-- Preços verificados em 31/07/2026 nas tabelas oficiais.
INSERT INTO public.ai_model_pricing
  (model, input_usd_per_1m, output_usd_per_1m, cached_usd_per_1m) VALUES
  ('anthropic/claude-haiku-4.5',        1.00,  5.00,  0.10),
  ('google/gemini-3.6-flash',           0.30,  2.50,  0.03),
  ('openai/gpt-5-mini',                 0.25,  2.00,  0.03),
  ('openai/gpt-4o-mini',                0.15,  0.60,  0.075),
  -- Realtime: áudio é a categoria cara; input/output aqui são os de áudio.
  ('gpt-realtime-2.1',                 32.00, 64.00,  0.40),
  ('gpt-4o-mini-transcribe',            1.25,  5.00,  0.00)
ON CONFLICT (model) DO UPDATE
  SET input_usd_per_1m  = EXCLUDED.input_usd_per_1m,
      output_usd_per_1m = EXCLUDED.output_usd_per_1m,
      cached_usd_per_1m = EXCLUDED.cached_usd_per_1m,
      updated_at = now();

-- Custo por funcionalidade no mês. Modelo sem preço cadastrado aparece com
-- custo 0 mas com os tokens visíveis — some do dinheiro, nunca do volume.
CREATE OR REPLACE FUNCTION public.ai_cost_report(p_month text DEFAULT NULL)
RETURNS TABLE (
  feature        text,
  model          text,
  chamadas       bigint,
  input_tokens   bigint,
  output_tokens  bigint,
  cached_tokens  bigint,
  custo_usd      numeric,
  tem_preco      boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_tenant text;
  v_role   text;
  v_start  date;
BEGIN
  SELECT p.tenant_id, p.role INTO v_tenant, v_role
  FROM public.profiles p WHERE p.id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN
     ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') THEN
    RAISE EXCEPTION 'sem_permissao';
  END IF;

  v_start := date_trunc('month',
    COALESCE(to_date(NULLIF(p_month, ''), 'YYYY-MM'), current_date))::date;

  RETURN QUERY
  SELECT
    e.feature,
    e.model,
    count(*)::bigint,
    sum(e.input_tokens)::bigint,
    sum(e.output_tokens)::bigint,
    sum(e.cached_tokens)::bigint,
    round(sum(
      (e.input_tokens  - e.cached_tokens) * COALESCE(pr.input_usd_per_1m, 0)
    + e.cached_tokens                     * COALESCE(pr.cached_usd_per_1m, 0)
    + e.output_tokens                     * COALESCE(pr.output_usd_per_1m, 0)
    ) / 1000000.0, 4),
    bool_or(pr.model IS NOT NULL)
  FROM public.ai_usage_events e
  LEFT JOIN public.ai_model_pricing pr ON pr.model = e.model
  WHERE e.tenant_id = v_tenant
    AND e.created_at >= v_start
    AND e.created_at <  (v_start + interval '1 month')
  GROUP BY e.feature, e.model
  ORDER BY 7 DESC NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_cost_report(text) FROM public;
GRANT EXECUTE ON FUNCTION public.ai_cost_report(text) TO authenticated;
