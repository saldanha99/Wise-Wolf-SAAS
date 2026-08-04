-- Ajuste de fechamento volta a contar na folha.
--
-- `closing_adjustments` existe desde 02/08 e guarda acordos com o professor —
-- reserva de agenda, bônus, desconto. A RPC de gravação (`set_closing_adjustment`)
-- também existe. Só que NENHUMA das funções da folha lê a tabela:
--
--   run_monthly_teacher_closing  → soma aulas + sobras, ignora ajustes
--   get_teacher_closing_report   → mostra só o valor das aulas
--   director_teacher_margin      → idem
--
-- Efeito real: a Lais tem R$ 30,00 de "Reserva de agenda — Mariana Pastro
-- (acordo com a direção)" gravado, e as duas telas que o diretor abre mostram
-- R$ 232,00. Se pagassem pela tela, o acordo simplesmente não seria honrado —
-- e ninguém perceberia, porque o valor combinado não aparece em lugar nenhum.
--
-- Só o DRE e o balancete enxergavam, porque foram escritos depois e já leem a
-- tabela. Era por isso que o resultado gerencial e a folha divergiam.
--
-- ⚠️ Não mexo em `director_teacher_margin`: ela foi substituída pelo balancete
-- para comparar professor, e alterá-la agora mudaria número de uma tela que o
-- diretor já aprendeu a ler. O balancete, que é a fonte recomendada, já soma.

DO $migration$
DECLARE
  v_def text; v_novo text;
  -- run_monthly_teacher_closing
  c_decl_old text := 'v_carry_n int := 0; v_carry_amount numeric := 0; v_closing_id uuid;';
  c_decl_new text := 'v_carry_n int := 0; v_carry_amount numeric := 0; v_closing_id uuid;' || E'\n      v_adj_amount numeric := 0;';
  c_carry_old text := '      SELECT count(*), round(COALESCE(sum(amount),0),2)
        INTO v_carry_n, v_carry_amount
      FROM teacher_pending_carryover(r.teacher_id);';
  c_carry_new text := '      SELECT count(*), round(COALESCE(sum(amount),0),2)
        INTO v_carry_n, v_carry_amount
      FROM teacher_pending_carryover(r.teacher_id);

      -- Acordos com a direção (reserva de agenda, bônus, desconto). Sem esta
      -- linha o combinado com o professor não entra no que ele recebe.
      SELECT round(COALESCE(sum(ca.amount),0),2) INTO v_adj_amount
        FROM closing_adjustments ca
       WHERE ca.teacher_id = r.teacher_id AND ca.month_year = v_month;';
  -- get_teacher_closing_report
  r_old text := '  INTO v_resumo
  FROM v_payable_class_logs v
  WHERE v.teacher_id = p_teacher_id AND to_char(v.class_date,''YYYY-MM'') = p_month;';
  r_new text := '  INTO v_resumo
  FROM v_payable_class_logs v
  WHERE v.teacher_id = p_teacher_id AND to_char(v.class_date,''YYYY-MM'') = p_month;

  -- Ajustes acordados com a direção entram no total e aparecem discriminados.
  -- valor_aulas fica preservado para a tela poder mostrar a composição.
  v_resumo := v_resumo || (
    SELECT jsonb_build_object(
      ''valor_aulas'', (v_resumo->>''valor_total'')::numeric,
      ''ajustes'', COALESCE(sum(ca.amount),0),
      ''ajustes_detalhe'', COALESCE(jsonb_agg(jsonb_build_object(
          ''descricao'', ca.description, ''valor'', ca.amount) ORDER BY ca.created_at), ''[]''::jsonb),
      ''valor_total'', (v_resumo->>''valor_total'')::numeric + COALESCE(sum(ca.amount),0))
    FROM closing_adjustments ca
    WHERE ca.teacher_id = p_teacher_id AND ca.month_year = p_month);';
BEGIN
  -- 1) Fechamento mensal ------------------------------------------------------
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc WHERE proname='run_monthly_teacher_closing';
  IF v_def IS NULL THEN RAISE EXCEPTION 'run_monthly_teacher_closing não encontrada'; END IF;

  IF position('v_adj_amount' IN v_def) > 0 THEN
    RAISE NOTICE 'fechamento já soma ajustes';
  ELSE
    IF position(c_decl_old IN v_def) = 0 OR position(c_carry_old IN v_def) = 0
       OR position('v_amount + v_carry_amount' IN v_def) = 0 THEN
      RAISE EXCEPTION 'estrutura de run_monthly_teacher_closing mudou — revise antes de aplicar';
    END IF;
    v_novo := replace(v_def, c_decl_old, c_decl_new);
    v_novo := replace(v_novo, c_carry_old, c_carry_new);
    v_novo := replace(v_novo, 'v_amount + v_carry_amount', 'v_amount + v_carry_amount + v_adj_amount');
    EXECUTE v_novo;

    SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc WHERE proname='run_monthly_teacher_closing';
    IF position('v_adj_amount' IN v_def) = 0 THEN
      RAISE EXCEPTION 'ajuste não entrou em run_monthly_teacher_closing';
    END IF;
  END IF;

  -- 2) Relatório do professor -------------------------------------------------
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc WHERE proname='get_teacher_closing_report';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_teacher_closing_report não encontrada'; END IF;

  IF position('ajustes_detalhe' IN v_def) > 0 THEN
    RAISE NOTICE 'relatório já mostra ajustes';
  ELSE
    IF position(r_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'estrutura de get_teacher_closing_report mudou — revise antes de aplicar';
    END IF;
    EXECUTE replace(v_def, r_old, r_new);

    SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc WHERE proname='get_teacher_closing_report';
    IF position('ajustes_detalhe' IN v_def) = 0 THEN
      RAISE EXCEPTION 'ajuste não entrou em get_teacher_closing_report';
    END IF;
  END IF;
END
$migration$;
