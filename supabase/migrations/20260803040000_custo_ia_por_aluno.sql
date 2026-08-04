-- Custo de IA em REAIS, por aluno.
--
-- O que existia dava token: `wolfie_realtime_usage_report` (voz) e
-- `ai_cost_report` (texto, em dólar e por FEATURE, não por pessoa). Para
-- responder "quanto o aluno X me custou" era preciso cruzar as duas na mão —
-- foi o que tive de fazer para descobrir o custo de R$ 0,31/min.
--
-- Decisões que mudam o número:
--
-- 1. CACHED SAI DO INPUT. Token em cache é subconjunto do input e é cobrado a
--    outro preço (US$ 0,40 contra US$ 32 por 1M no gpt-realtime-2.1). Somar os
--    dois inteiros inflaria o custo em ~5x — em agosto/2026 os 32 mil tokens
--    em cache são 62% de todo o input.
--
-- 2. MODELO SEM PREÇO NÃO VIRA ZERO SILENCIOSO. `text-embedding-3-small` não
--    está em ai_model_pricing e hoje aparece como custo 0,00, o que é mentira.
--    Aqui ele sai numa lista `sem_preco` para o custo faltante ser visível em
--    vez de ser confundido com custo inexistente.
--
-- 3. O DÓLAR É PARÂMETRO, não constante escondida. Muda toda hora, e uma taxa
--    chumbada no meio de uma função é o tipo de número que ninguém lembra de
--    atualizar e todo mundo passa a acreditar.
--
-- ⚠️ Voz e texto do Realtime são cobrados a preços DIFERENTES pela OpenAI, e
-- ai_model_pricing guarda um preço por modelo. Enquanto for assim, o custo de
-- voz aqui é TETO: os tokens de texto da conversa entram a preço de áudio. Está
-- declarado em `aviso` no retorno para ninguém tomar o teto por exato.

CREATE OR REPLACE FUNCTION public.ai_cost_por_aluno(
  p_month text DEFAULT NULL, p_usd_brl numeric DEFAULT 5.50)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt text; v_role text; v_tenant text; v_mes text;
  v_pin numeric; v_pout numeric; v_pcache numeric;
BEGIN
  v_jwt := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_jwt IN ('anon','authenticated') THEN
    IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
      RETURN jsonb_build_object('error','sem_permissao');
    END IF;
  END IF;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('error','escola_nao_identificada'); END IF;

  v_mes := COALESCE(p_month, to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date,'YYYY-MM'));
  IF v_mes !~ '^\d{4}-\d{2}$' THEN RETURN jsonb_build_object('error','mes_invalido'); END IF;
  IF p_usd_brl IS NULL OR p_usd_brl <= 0 THEN RETURN jsonb_build_object('error','cambio_invalido'); END IF;

  SELECT input_usd_per_1m, output_usd_per_1m, cached_usd_per_1m
    INTO v_pin, v_pout, v_pcache
    FROM ai_model_pricing WHERE model = 'gpt-realtime-2.1';
  IF v_pin IS NULL THEN RETURN jsonb_build_object('error','preco_da_voz_nao_cadastrado'); END IF;

  RETURN (
  WITH voz AS (
    SELECT r.student_id, r.student_name, r.sessions, r.turns,
           -- cached é subconjunto do input: tira antes de multiplicar
           GREATEST(r.input_audio_tokens + r.input_text_tokens - r.cached_tokens, 0) AS in_pago,
           r.cached_tokens,
           r.output_audio_tokens + r.output_text_tokens AS out_total
      FROM wolfie_realtime_usage_report(v_mes) r
  ), voz_custo AS (
    SELECT v.*,
           (v.in_pago * v_pin + v.cached_tokens * v_pcache + v.out_total * v_pout) / 1000000.0 AS usd
      FROM voz v
  ), minutos AS (
    SELECT g.student_id, ROUND(SUM(g.consumed_seconds)/60.0, 1) AS min
      FROM wolfie_live_grants g
     WHERE g.tenant_id = v_tenant
       AND to_char(g.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = v_mes
     GROUP BY 1
  ), texto AS (
    -- Texto atribuível a aluno. Evento sem user_id (cron, tarefa da escola) não
    -- pertence a ninguém e entra só no total geral.
    SELECT e.user_id AS student_id,
           SUM((GREATEST(e.input_tokens - COALESCE(e.cached_tokens,0),0) * COALESCE(pr.input_usd_per_1m,0)
              + COALESCE(e.cached_tokens,0) * COALESCE(pr.cached_usd_per_1m,0)
              + e.output_tokens * COALESCE(pr.output_usd_per_1m,0)) / 1000000.0) AS usd
      FROM ai_usage_events e
      LEFT JOIN ai_model_pricing pr ON pr.model = e.model
     WHERE e.tenant_id = v_tenant AND e.user_id IS NOT NULL
       AND to_char(e.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = v_mes
     GROUP BY 1
  ), juntos AS (
    SELECT COALESCE(vc.student_id, t.student_id) AS student_id,
           COALESCE(vc.student_name, trim(p.full_name), 'Sem nome') AS nome,
           COALESCE(vc.sessions,0)::int AS sessoes,
           COALESCE(m.min,0) AS minutos,
           ROUND(COALESCE(vc.usd,0) * p_usd_brl, 2) AS voz_brl,
           ROUND(COALESCE(t.usd,0) * p_usd_brl, 2) AS texto_brl,
           ROUND((COALESCE(vc.usd,0) + COALESCE(t.usd,0)) * p_usd_brl, 2) AS total_brl,
           COALESCE(p.monthly_fee,0) AS mensalidade
      FROM voz_custo vc
      FULL JOIN texto t ON t.student_id = vc.student_id
      LEFT JOIN profiles p ON p.id = COALESCE(vc.student_id, t.student_id)
      LEFT JOIN minutos m ON m.student_id = COALESCE(vc.student_id, t.student_id)
  )
  SELECT jsonb_build_object(
    'mes', v_mes,
    'usd_brl', p_usd_brl,
    'aviso', 'Custo de voz é TETO: ai_model_pricing guarda um preço por modelo, e a OpenAI cobra áudio e texto do Realtime a preços diferentes — o texto da conversa entra aqui a preço de áudio.',
    'total_brl', (SELECT ROUND(COALESCE(SUM(total_brl),0),2) FROM juntos),
    'minutos_totais', (SELECT COALESCE(SUM(minutos),0) FROM juntos),
    'custo_por_minuto_brl', (SELECT CASE WHEN COALESCE(SUM(minutos),0) > 0
        THEN ROUND(SUM(voz_brl)/SUM(minutos),2) END FROM juntos),
    'alunos', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'student_id', j.student_id, 'aluno', j.nome,
        'sessoes', j.sessoes, 'minutos', j.minutos,
        'voz_brl', j.voz_brl, 'texto_brl', j.texto_brl, 'total_brl', j.total_brl,
        'mensalidade', j.mensalidade,
        'pct_da_mensalidade', CASE WHEN j.mensalidade > 0
            THEN ROUND(100 * j.total_brl / j.mensalidade, 1) END)
        ORDER BY j.total_brl DESC) FROM juntos j WHERE j.total_brl > 0), '[]'::jsonb),
    -- Custo que a escola tem e não pertence a aluno nenhum (crons, IA de gestão).
    'sem_aluno_brl', (SELECT ROUND(COALESCE(SUM(
        (GREATEST(e.input_tokens - COALESCE(e.cached_tokens,0),0) * COALESCE(pr.input_usd_per_1m,0)
       + COALESCE(e.cached_tokens,0) * COALESCE(pr.cached_usd_per_1m,0)
       + e.output_tokens * COALESCE(pr.output_usd_per_1m,0)) / 1000000.0),0) * p_usd_brl, 2)
      FROM ai_usage_events e LEFT JOIN ai_model_pricing pr ON pr.model = e.model
     WHERE e.tenant_id = v_tenant AND e.user_id IS NULL
       AND to_char(e.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = v_mes),
    -- Modelo sem preço: custo real que este relatório NÃO está contando.
    'sem_preco', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'model', x.model, 'chamadas', x.n, 'tokens', x.tok))
      FROM (SELECT e.model, count(*)::int AS n,
                   SUM(e.input_tokens + e.output_tokens)::bigint AS tok
              FROM ai_usage_events e
             WHERE e.tenant_id = v_tenant
               AND to_char(e.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = v_mes
               AND NOT EXISTS (SELECT 1 FROM ai_model_pricing pr WHERE pr.model = e.model)
             GROUP BY 1) x), '[]'::jsonb)
  ));
END;
$function$;

COMMENT ON FUNCTION public.ai_cost_por_aluno(text, numeric) IS
  'Custo de IA em reais por aluno (voz + texto). Cached sai do input antes do cálculo; modelo sem preço aparece em sem_preco em vez de virar zero.';

REVOKE ALL ON FUNCTION public.ai_cost_por_aluno(text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_cost_por_aluno(text, numeric) TO authenticated, service_role;
