-- Balancete por professor — custo aberto por natureza e lucro por cabeça.
--
-- director_teacher_margin já dava custo × receita por professor/aluno, mas com
-- dois problemas que inviabilizam usá-la como balancete:
--
--   1. RECEITA CONTADA EM DOBRO. Ela junta a receita INTEIRA do aluno em cada
--      linha professor×aluno. Aluno com dois professores no mês aparece com a
--      mensalidade cheia nos dois — o lucro de ambos sai inflado. Existe 1 caso
--      em julho/2026 e 7 no histórico. Aqui a receita é RATEADA pelo número de
--      aulas que cada professor deu ao aluno.
--
--   2. DEFINIÇÃO DE RECEITA DIVERGENTE do DRE. Ela aceita status
--      ('RECEIVED','CONFIRMED','PAID','RECEIVED_IN_CASH') e escopo pelo tenant
--      do PERFIL do aluno; dre_gerencial aceita ('RECEIVED','RECEIVED_IN_CASH')
--      e escopo por student_payments.tenant_id. Dois relatórios com dois
--      faturamentos diferentes é como a regra de pagamento se espalhou por
--      quatro lugares e divergiu. Aqui a expressão é IDÊNTICA à do DRE, de
--      propósito, para que o balancete feche com o resultado.
--
-- ⚠️ Em julho/2026, R$ 2.365,00 (8 pagamentos) entraram com student_id NULO.
-- É receita real — está no DRE — mas não pertence a professor nenhum. Vai numa
-- linha própria ('receita_sem_aluno') em vez de ser diluída ou descartada:
-- descartar faria o balancete não fechar com o DRE; diluir inventaria lucro.
--
-- O custo NÃO é reconstruído: sai de v_payable_class_logs, a mesma fonte da
-- folha e do DRE. O que esta função faz é ABRIR esse custo por natureza.

CREATE OR REPLACE FUNCTION public.balancete_professores(
  p_month text DEFAULT NULL, p_tenant text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text;
  v_base numeric;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  SELECT role, tenant_id INTO v_caller_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_jwt_role IN ('anon','authenticated') THEN
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RAISE EXCEPTION 'Apenas a direção pode ver o balancete';
    END IF;
    IF v_caller_role = 'SUPER_ADMIN' THEN v_tenant := COALESCE(p_tenant, v_tenant); END IF;
  ELSE
    v_tenant := COALESCE(p_tenant, v_tenant);
  END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Escola não identificada'; END IF;

  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  IF v_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Mês inválido (use YYYY-MM)'; END IF;

  -- Valor base da faixa 1, nunca chumbado: o diretor mexe em teacher_pay_tiers e
  -- a decomposição tem de acompanhar, senão o "adicional" vira número fantasma.
  SELECT rate INTO v_base FROM teacher_pay_tiers
   WHERE tenant_id = v_tenant AND min_students = 1;
  v_base := COALESCE(v_base, 0);

  RETURN (
  WITH aulas AS (
    SELECT v.id, v.teacher_id, v.student_id, v.rate_efetivo, v.rate_override, v.subtype
      FROM v_payable_class_logs v
      JOIN profiles t ON t.id = v.teacher_id
     WHERE to_char(v.class_date,'YYYY-MM') = v_month
       AND t.tenant_id = v_tenant
  ), classificado AS (
    -- A ordem espelha o COALESCE de rate_efetivo na view: override vence de
    -- tudo, depois o 16,00 de quem MINISTRA treinamento, e só então a faixa por
    -- carteira. Trocar a ordem faria um override de 10,50 ser lido como turbo.
    SELECT a.*,
           CASE
             WHEN a.rate_override IS NOT NULL                              THEN 'ajuste'
             WHEN a.subtype = 'TREINAMENTO' AND a.rate_efetivo > v_base    THEN 'treinamento'
             WHEN a.rate_efetivo > v_base                                  THEN 'turbo'
             ELSE 'base'
           END AS motivo
      FROM aulas a
  ), aulas_aluno_prof AS (
    SELECT c.student_id, c.teacher_id, count(*)::int AS n
      FROM classificado c WHERE c.student_id IS NOT NULL
     GROUP BY 1,2
  ), aulas_aluno AS (
    SELECT ap.student_id, sum(ap.n) AS total FROM aulas_aluno_prof ap GROUP BY 1
  ), receita_aluno AS (
    -- Expressão IDÊNTICA à de dre_gerencial. Não "melhore" só de um lado.
    SELECT sp.student_id, sum(sp.value) AS receita
      FROM student_payments sp
     WHERE sp.tenant_id = v_tenant
       AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
       AND to_char(COALESCE(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
       AND sp.student_id IS NOT NULL
     GROUP BY 1
  ), rateio AS (
    SELECT ap.teacher_id, ap.student_id,
           ra.receita * ap.n / NULLIF(aa.total,0) AS receita
      FROM aulas_aluno_prof ap
      JOIN aulas_aluno   aa ON aa.student_id = ap.student_id
      JOIN receita_aluno ra ON ra.student_id = ap.student_id
  ), por_aluno AS (
    SELECT c.teacher_id, c.student_id,
           max(COALESCE(sp.full_name,'Aluno não cadastrado')) AS student_name,
           count(*)::int                                          AS aulas,
           sum(c.rate_efetivo)                                    AS custo,
           count(*) FILTER (WHERE c.motivo = 'turbo')::int         AS aulas_turbo,
           COALESCE(max(r.receita), 0)                            AS receita
      FROM classificado c
      LEFT JOIN profiles sp ON sp.id = c.student_id
      LEFT JOIN rateio   r  ON r.teacher_id = c.teacher_id AND r.student_id = c.student_id
     WHERE c.student_id IS NOT NULL
     GROUP BY c.teacher_id, c.student_id
  ), ajustes AS (
    SELECT ca.teacher_id, sum(ca.amount) AS valor
      FROM closing_adjustments ca
     WHERE ca.tenant_id = v_tenant AND ca.month_year = v_month
     GROUP BY 1
  ), por_prof AS (
    SELECT c.teacher_id,
           count(*)::int                                              AS aulas,
           count(DISTINCT c.student_id) FILTER (WHERE c.student_id IS NOT NULL)::int AS alunos,
           (count(*) * v_base)                                        AS custo_base,
           sum(CASE WHEN c.motivo='turbo'       THEN c.rate_efetivo - v_base ELSE 0 END) AS comissao_turbo,
           sum(CASE WHEN c.motivo='treinamento' THEN c.rate_efetivo - v_base ELSE 0 END) AS bonus_treinamento,
           sum(CASE WHEN c.motivo='ajuste'      THEN c.rate_efetivo - v_base ELSE 0 END) AS ajuste_valor_base,
           count(*) FILTER (WHERE c.motivo='turbo')::int              AS aulas_turbo,
           count(*) FILTER (WHERE c.motivo='treinamento')::int        AS aulas_treinamento,
           count(*) FILTER (WHERE c.motivo='ajuste')::int             AS aulas_ajustadas,
           sum(c.rate_efetivo)                                        AS custo_aulas
      FROM classificado c
     GROUP BY c.teacher_id
  ), consolidado AS (
    SELECT p.*,
           COALESCE(aj.valor, 0)                          AS ajustes_fechamento,
           p.custo_aulas + COALESCE(aj.valor, 0)          AS custo_total,
           COALESCE((SELECT sum(r.receita) FROM rateio r WHERE r.teacher_id = p.teacher_id), 0) AS receita,
           trim(t.full_name)                              AS teacher_name
      FROM por_prof p
      JOIN profiles t   ON t.id = p.teacher_id
      LEFT JOIN ajustes aj ON aj.teacher_id = p.teacher_id
  )
  SELECT jsonb_build_object(
    'month', v_month,
    'base_rate', v_base,
    'professores', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'teacher_id', k.teacher_id, 'teacher_name', k.teacher_name,
        'aulas', k.aulas, 'alunos', k.alunos,
        'custo_base',         round(k.custo_base,2),
        'comissao_turbo',     round(k.comissao_turbo,2),
        'bonus_treinamento',  round(k.bonus_treinamento,2),
        'ajuste_valor_base',  round(k.ajuste_valor_base,2),
        'ajustes_fechamento', round(k.ajustes_fechamento,2),
        'custo_total',        round(k.custo_total,2),
        'aulas_turbo', k.aulas_turbo, 'aulas_treinamento', k.aulas_treinamento,
        'aulas_ajustadas', k.aulas_ajustadas,
        'receita',      round(k.receita,2),
        'lucro',        round(k.receita - k.custo_total,2),
        'margem_pct',   round(100 * (k.receita - k.custo_total) / NULLIF(k.receita,0),1),
        'custo_por_aula', round(k.custo_total / NULLIF(k.aulas,0),2),
        'alunos_detalhe', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'student_id', pa.student_id, 'student_name', pa.student_name,
                    'aulas', pa.aulas, 'aulas_turbo', pa.aulas_turbo,
                    'custo', round(pa.custo,2), 'receita', round(pa.receita,2),
                    'lucro', round(pa.receita - pa.custo,2))
                  ORDER BY pa.receita - pa.custo DESC)
             FROM por_aluno pa WHERE pa.teacher_id = k.teacher_id), '[]'::jsonb)
      ) ORDER BY k.receita - k.custo_total DESC)
      FROM consolidado k), '[]'::jsonb),
    'totais', (SELECT jsonb_build_object(
        'aulas',              COALESCE(sum(k.aulas),0),
        'custo_base',         round(COALESCE(sum(k.custo_base),0),2),
        'comissao_turbo',     round(COALESCE(sum(k.comissao_turbo),0),2),
        'bonus_treinamento',  round(COALESCE(sum(k.bonus_treinamento),0),2),
        'ajuste_valor_base',  round(COALESCE(sum(k.ajuste_valor_base),0),2),
        'ajustes_fechamento', round(COALESCE(sum(k.ajustes_fechamento),0),2),
        'custo_total',        round(COALESCE(sum(k.custo_total),0),2),
        'receita_alocada',    round(COALESCE(sum(k.receita),0),2),
        'lucro',              round(COALESCE(sum(k.receita),0) - COALESCE(sum(k.custo_total),0),2)
      ) FROM consolidado k),
    -- Receita que existe no DRE e não cabe em nenhum professor.
    'receita_total', round((SELECT COALESCE(sum(sp.value),0) FROM student_payments sp
        WHERE sp.tenant_id = v_tenant AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
          AND to_char(COALESCE(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month),2),
    'receita_sem_aluno', round((SELECT COALESCE(sum(sp.value),0) FROM student_payments sp
        WHERE sp.tenant_id = v_tenant AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
          AND to_char(COALESCE(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
          AND sp.student_id IS NULL),2),
    'receita_aluno_sem_aula', round(
        (SELECT COALESCE(sum(sp.value),0) FROM student_payments sp
          WHERE sp.tenant_id = v_tenant AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
            AND to_char(COALESCE(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
            AND sp.student_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM aulas_aluno aa WHERE aa.student_id = sp.student_id)),2),
    'alunos_multi_professor', (SELECT count(*)::int FROM (
        SELECT ap.student_id FROM aulas_aluno_prof ap
         GROUP BY ap.student_id HAVING count(DISTINCT ap.teacher_id) > 1) z)
  ));
END;
$function$;

COMMENT ON FUNCTION public.balancete_professores(text, text) IS
  'Balancete por professor: custo aberto em base/turbo/treinamento/ajustes (fonte v_payable_class_logs) e receita RATEADA por aulas quando o aluno tem mais de um professor. Receita usa a mesma expressão de dre_gerencial para os dois fecharem.';

REVOKE ALL ON FUNCTION public.balancete_professores(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.balancete_professores(text, text) TO authenticated, service_role;
