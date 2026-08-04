-- get_mei_radar: reentrante dentro de uma transação.
--
-- A função cria `TEMP TABLE _receitas ON COMMIT DROP`. ON COMMIT DROP só apaga
-- no COMMIT, então a SEGUNDA chamada na MESMA transação falha com
-- "relation _receitas already exists". Descoberto em 02/08/2026 ao comparar o
-- acumulado do ano antes e depois de uma exclusão de receita, no mesmo BEGIN.
--
-- Não aparece em produção porque cada chamada via PostgREST é uma transação
-- própria. Mas qualquer função SQL, teste ou script que a chame duas vezes
-- quebra — e o sintoma ("relation already exists") não sugere nada sobre MEI,
-- então custaria caro para diagnosticar de novo.
--
-- Correção de UMA linha, de propósito: é a função que vigia o teto do MEI e
-- alimenta decisão fiscal. Reescrevê-la com CTE seria mais elegante e traria
-- risco desproporcional ao bug. O resto do corpo é idêntico ao que roda hoje.

CREATE OR REPLACE FUNCTION public.get_mei_radar(p_tenant text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_ano int := extract(year FROM now())::int;
  v_ini date := make_date(extract(year FROM now())::int, 1, 1);
  v_mes_atual_ini date := date_trunc('month', now())::date;
  v_meses_completos numeric := GREATEST(extract(month FROM now())::numeric - 1, 1);
  v_total numeric := 0;          -- ano inteiro (inclui mês corrente parcial)
  v_fechado numeric := 0;        -- só meses fechados
  v_asaas numeric := 0;
  v_manual numeric := 0;
  v_3m numeric := 0;             -- últimos 3 meses FECHADOS
  v_por_mes jsonb;
  v_teto numeric := 81000;
  v_tolerancia numeric := 97200;
  v_media numeric;
  v_ritmo numeric;
  v_proj_media numeric;
  v_proj_ritmo numeric;
BEGIN
  IF NOT mei_radar_caller_allowed() THEN
    RETURN jsonb_build_object('error', 'sem_permissao');
  END IF;

  -- receita bruta sem sobreposição: espelho Asaas + entradas manuais não vinculadas
  -- ↓ ESTA é a correção: torna a função chamável mais de uma vez na transação.
  DROP TABLE IF EXISTS _receitas;
  CREATE TEMP TABLE _receitas ON COMMIT DROP AS
    SELECT COALESCE(paid_at, payment_date)::date AS dia, value AS v
    FROM student_payments
    WHERE tenant_id = p_tenant AND status IN ('RECEIVED','RECEIVED_IN_CASH','CONFIRMED')
      AND COALESCE(paid_at, payment_date) >= v_ini
    UNION ALL
    SELECT occurred_at::date, amount
    FROM financial_transactions
    WHERE tenant_id = p_tenant AND type='ENTRADA' AND student_payment_id IS NULL
      AND occurred_at >= v_ini;

  SELECT COALESCE(sum(v),0) INTO v_total FROM _receitas;
  SELECT COALESCE(sum(v),0) INTO v_fechado FROM _receitas WHERE dia < v_mes_atual_ini;
  SELECT COALESCE(sum(v),0) INTO v_3m FROM _receitas
   WHERE dia >= (v_mes_atual_ini - interval '3 months') AND dia < v_mes_atual_ini;

  SELECT COALESCE(sum(value),0) INTO v_asaas FROM student_payments
  WHERE tenant_id = p_tenant AND status IN ('RECEIVED','RECEIVED_IN_CASH','CONFIRMED')
    AND COALESCE(paid_at, payment_date) >= v_ini;
  v_manual := v_total - v_asaas;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', mes, 'valor', valor) ORDER BY mes), '[]'::jsonb)
  INTO v_por_mes
  FROM (SELECT to_char(dia,'YYYY-MM') AS mes, round(sum(v),2) AS valor FROM _receitas GROUP BY 1) m;

  v_media := v_fechado / v_meses_completos;
  v_ritmo := v_3m / LEAST(3, v_meses_completos);
  v_proj_media := round(v_media * 12, 2);
  -- acumulado fechado + ritmo recente para os meses restantes (incluindo o corrente)
  v_proj_ritmo := round(v_fechado + v_ritmo * (12 - v_meses_completos), 2);

  RETURN jsonb_build_object(
    'ano', v_ano,
    'receita_acumulada', round(v_total, 2),
    'receita_asaas', round(v_asaas, 2),
    'receita_manual', round(v_manual, 2),
    'por_mes', v_por_mes,
    'media_mensal', round(v_media, 2),
    'ritmo_3m', round(v_ritmo, 2),
    'projecao_media', v_proj_media,
    'projecao_ritmo_3m', v_proj_ritmo,
    'teto', v_teto,
    'teto_tolerancia', v_tolerancia,
    'pct_teto', round(100 * v_total / v_teto, 1),
    'pct_projecao_teto', round(100 * GREATEST(v_proj_media, v_proj_ritmo) / v_teto, 1),
    'das_mensal', 86.05,
    'simples_anexo3_estimado_ano', round(GREATEST(v_proj_media, v_proj_ritmo) * 0.06, 2)
  );
END;
$function$;
