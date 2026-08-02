-- Faltas e buraco de cobrança no snapshot do assistente.
--
-- Origem: o diretor perguntou no grupo quem deu mais lucro e o assistente
-- respondeu "Flávio, R$ 1.177,10". A conta estava certa e a conclusão, enganosa:
-- 7 alunos fizeram 78 aulas em julho/2026 SEM NENHUMA cobrança gerada no mês
-- (a assinatura pulou de junho para agosto). Quatro desses alunos são do Mateus.
-- Com as 5 mensalidades reais lançadas, Mateus passaria Flávio (1.249,00 contra
-- 1.177,10) — ou seja, o ranking de lucro estava medindo falha de faturamento,
-- não desempenho de professor.
--
-- Por isso `alunos_sem_cobranca` entra no snapshot: quem lê lucro por professor
-- precisa ver, na mesma resposta, quanto de receita não foi faturada. Sem isso o
-- assistente continua dando respostas corretas que levam à conclusão errada.
--
-- E `faltas`, que o diretor pediu: falta de aluno e de professor, com motivo —
-- `class_logs.subtype` guarda o porquê (Trabalho, Viagem, Doença…).

-- 1) Faltas do mês -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gestao_faltas(
  p_month text, p_tenant text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH aulas AS (
    SELECT cl.*, COALESCE(cl.subtype,'(não informado)') AS motivo
      FROM class_logs cl
     WHERE cl.tenant_id = p_tenant AND to_char(cl.class_date,'YYYY-MM') = p_month
  )
  SELECT jsonb_build_object(
    'aulas_no_mes',        (SELECT count(*)::int FROM aulas),
    'faltas_de_aluno',     (SELECT count(*)::int FROM aulas WHERE presence = 'STUDENT_ABSENCE'),
    'faltas_de_professor', (SELECT count(*)::int FROM aulas WHERE presence = 'TEACHER_ABSENCE'),
    'reposicoes',          (SELECT count(*)::int FROM aulas WHERE subtype = 'REPOSIÇÃO'),
    'pct_falta_aluno',     (SELECT round(100.0 * count(*) FILTER (WHERE presence='STUDENT_ABSENCE')
                                          / NULLIF(count(*),0), 1) FROM aulas),
    -- Quem mais faltou, por aluno. É a pergunta que o diretor faz.
    'alunos_que_mais_faltaram', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x->>'faltas')::int DESC) FROM (
        SELECT jsonb_build_object(
                 'aluno', trim(p.full_name), 'faltas', count(*)::int,
                 'motivos', (SELECT string_agg(DISTINCT a2.motivo, ', ')
                               FROM aulas a2 WHERE a2.student_id = a.student_id
                                AND a2.presence = 'STUDENT_ABSENCE')) AS x
          FROM aulas a JOIN profiles p ON p.id = a.student_id
         WHERE a.presence = 'STUDENT_ABSENCE' AND a.student_id IS NOT NULL
         GROUP BY a.student_id, p.full_name
         ORDER BY count(*) DESC LIMIT 8) y), '[]'::jsonb),
    -- Falta de PROFESSOR não paga e é sinal de risco: vai sempre, mesmo zerada.
    'professores_que_faltaram', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('professor', trim(t.full_name), 'faltas', n) ORDER BY n DESC)
        FROM (SELECT a.teacher_id, count(*)::int AS n FROM aulas a
               WHERE a.presence = 'TEACHER_ABSENCE' GROUP BY 1) z
        JOIN profiles t ON t.id = z.teacher_id), '[]'::jsonb),
    'motivos_de_falta', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('motivo', motivo, 'vezes', n) ORDER BY n DESC)
        FROM (SELECT motivo, count(*)::int AS n FROM aulas
               WHERE presence = 'STUDENT_ABSENCE' GROUP BY 1 ORDER BY 2 DESC LIMIT 6) m), '[]'::jsonb)
  );
$function$;

GRANT EXECUTE ON FUNCTION public.gestao_faltas(text,text) TO service_role, authenticated;

-- 2) Aula dada sem cobrança gerada ---------------------------------------------
-- Aluno que teve aula no mês e NENHUM pagamento daquele mês. Não é inadimplência
-- (que é cobrança vencida e não paga) — é cobrança que nunca existiu, e por isso
-- não aparece em nenhum relatório de inadimplência.
CREATE OR REPLACE FUNCTION public.gestao_alunos_sem_cobranca(
  p_month text, p_tenant text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH com_aula AS (
    SELECT v.student_id, count(*)::int AS aulas, max(t.full_name) AS prof
      FROM v_payable_class_logs v JOIN profiles t ON t.id = v.teacher_id
     WHERE t.tenant_id = p_tenant AND to_char(v.class_date,'YYYY-MM') = p_month
       AND v.student_id IS NOT NULL
     GROUP BY 1
  ), cobrado AS (
    SELECT DISTINCT sp.student_id FROM student_payments sp
     WHERE sp.tenant_id = p_tenant AND sp.student_id IS NOT NULL
       AND to_char(COALESCE(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = p_month
  ), faltando AS (
    SELECT p.full_name, c.prof, c.aulas, COALESCE(p.monthly_fee,0) AS mensalidade
      FROM com_aula c JOIN profiles p ON p.id = c.student_id
     WHERE NOT EXISTS (SELECT 1 FROM cobrado x WHERE x.student_id = c.student_id)
  )
  SELECT jsonb_build_object(
    'alunos', (SELECT count(*)::int FROM faltando),
    'aulas',  (SELECT COALESCE(sum(aulas),0)::int FROM faltando),
    -- Só o que TEM mensalidade cadastrada: aluno com fee 0 é bolsa/cortesia e
    -- somá-lo inventaria receita que ninguém pretendia cobrar.
    'receita_nao_faturada', (SELECT round(COALESCE(sum(mensalidade),0),2) FROM faltando),
    'sem_mensalidade_cadastrada', (SELECT count(*)::int FROM faltando WHERE mensalidade = 0),
    'detalhe', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'aluno', trim(full_name), 'professor', prof, 'aulas', aulas, 'mensalidade', mensalidade)
        ORDER BY mensalidade DESC, aulas DESC) FROM faltando), '[]'::jsonb)
  );
$function$;

GRANT EXECUTE ON FUNCTION public.gestao_alunos_sem_cobranca(text,text) TO service_role, authenticated;

-- 3) Snapshot passa a carregar os dois -----------------------------------------
CREATE OR REPLACE FUNCTION public.gestao_snapshot(
  p_month text DEFAULT NULL, p_tenant text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_role text; v_tenant text;
  v_mes text; v_ant text; v_hoje date;
  v_dre_atual jsonb; v_dre_ant jsonb; v_bal jsonb; v_caixa jsonb; v_mei jsonb; v_fech jsonb;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_jwt_role IN ('anon','authenticated') THEN
    IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RETURN jsonb_build_object('error','sem_permissao');
    END IF;
    IF v_role = 'SUPER_ADMIN' THEN v_tenant := COALESCE(p_tenant, v_tenant); END IF;
  ELSE
    v_tenant := COALESCE(p_tenant, v_tenant);
  END IF;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('error','escola_nao_identificada'); END IF;

  v_hoje := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_mes  := COALESCE(p_month, to_char(v_hoje,'YYYY-MM'));
  IF v_mes !~ '^\d{4}-\d{2}$' THEN RETURN jsonb_build_object('error','mes_invalido'); END IF;
  v_ant  := to_char((v_mes || '-01')::date - interval '1 month','YYYY-MM');

  v_dre_atual := dre_gerencial(v_mes, v_tenant);
  v_dre_ant   := dre_gerencial(v_ant, v_tenant);
  v_bal       := balancete_professores(v_ant, v_tenant);
  v_caixa     := get_cashflow(v_mes);
  v_mei       := get_mei_radar(v_tenant);
  IF v_mei ? 'error' THEN v_mei := NULL; END IF;

  SELECT jsonb_build_object(
           'total_geral', round(COALESCE(sum(tc.total_amount),0),2),
           'quantidade', count(*)::int,
           'por_mes', COALESCE((
              SELECT jsonb_agg(x ORDER BY x->>'mes' DESC) FROM (
                SELECT jsonb_build_object('mes', t2.month_year,
                         'total', round(sum(t2.total_amount),2),
                         'professores', count(*)::int) AS x
                  FROM teacher_closings t2
                 WHERE t2.tenant_id = v_tenant AND t2.status <> 'PAGO'
                 GROUP BY t2.month_year) y), '[]'::jsonb),
           'detalhe', COALESCE(jsonb_agg(jsonb_build_object(
                'professor', trim(pr.full_name), 'mes', tc.month_year,
                'valor', tc.total_amount, 'status', tc.status)
              ORDER BY tc.month_year DESC, tc.total_amount DESC), '[]'::jsonb))
    INTO v_fech
    FROM teacher_closings tc JOIN profiles pr ON pr.id = tc.teacher_id
   WHERE tc.tenant_id = v_tenant AND tc.status <> 'PAGO';

  RETURN jsonb_build_object(
    'escola', COALESCE((SELECT t.name FROM tenants t WHERE t.id = v_tenant), v_tenant),
    'hoje', v_hoje, 'mes_corrente', v_mes, 'mes_fechado', v_ant,

    'resultado_mes_corrente', jsonb_build_object(
      'parcial', true,
      'receita', v_dre_atual->'receita_bruta', 'custo', v_dre_atual->'custo_servicos',
      'despesas', v_dre_atual->'despesas_operacionais', 'resultado', v_dre_atual->'resultado',
      'margem_pct', v_dre_atual->'margem_liquida_pct', 'aulas', v_dre_atual#>'{indicadores,aulas}'),

    'resultado_mes_fechado', jsonb_build_object(
      'receita', v_dre_ant->'receita_bruta', 'custo', v_dre_ant->'custo_servicos',
      'despesas', v_dre_ant->'despesas_operacionais', 'resultado', v_dre_ant->'resultado',
      'margem_pct', v_dre_ant->'margem_liquida_pct',
      'aulas', v_dre_ant#>'{indicadores,aulas}',
      'alunos_atendidos', v_dre_ant#>'{indicadores,alunos_atendidos}',
      'custo_por_aula', v_dre_ant#>'{indicadores,custo_por_aula}',
      'alertas', v_dre_ant->'alertas', 'linhas', v_dre_ant->'linhas'),

    'professores_mes_fechado', COALESCE((
      SELECT jsonb_agg(p - 'alunos_detalhe')
        FROM jsonb_array_elements(v_bal->'professores') p), '[]'::jsonb),
    'total_a_pagar_professores_mes_fechado', v_bal#>'{totais,custo_total}',

    -- ⚠️ Sem isto, "quem deu mais lucro" premia quem teve a sorte de os alunos
    -- serem faturados. Anda colado ao ranking de propósito.
    'ressalva_do_lucro_por_professor',
      'O lucro por professor usa a receita que FOI faturada no mês. Se houver alunos em alunos_sem_cobranca, o professor deles aparece com lucro menor do que o real — é falha de faturamento, não desempenho. Sempre cite essa ressalva ao comparar professores.',

    'faltas', gestao_faltas(v_ant, v_tenant),
    'faltas_mes_corrente', gestao_faltas(v_mes, v_tenant),
    'alunos_sem_cobranca', gestao_alunos_sem_cobranca(v_ant, v_tenant),

    'pendencias', jsonb_build_object(
      'fechamentos_nao_pagos', v_fech,
      'pagamentos_sem_aluno', jsonb_build_object('valor', v_bal->'receita_sem_aluno'),
      'receita_sem_aula_lancada', jsonb_build_object(
        'valor', v_bal->'receita_aluno_sem_aula',
        'por_professor', balancete_receita_sem_aula(v_ant, v_tenant)->'por_professor'),
      'aulas_em_conflito', (SELECT count(*)::int FROM class_logs cl
                             WHERE cl.tenant_id = v_tenant AND cl.payment_hold = true)),

    'inadimplencia', v_caixa->'inadimplencia',
    'a_receber_no_mes', v_caixa->'a_receber',

    'alunos', jsonb_build_object(
      'ativos', (SELECT count(*)::int FROM profiles p
                  WHERE p.tenant_id = v_tenant AND p.role = 'STUDENT'
                    AND is_student_notifiable(p.id)),
      'atendidos_mes_fechado', v_dre_ant#>'{indicadores,alunos_atendidos}'),

    'mei', CASE WHEN v_mei IS NULL THEN NULL ELSE jsonb_build_object(
        'acumulado_ano', v_mei->'receita_acumulada', 'teto', v_mei->'teto',
        'pct_teto', v_mei->'pct_teto', 'pct_projecao_teto', v_mei->'pct_projecao_teto',
        'projecao_ano', v_mei->'projecao_ritmo_3m') END,

    'despesas_fixas_cadastradas', (SELECT count(*)::int FROM recurring_expenses r
                                    WHERE r.tenant_id = v_tenant AND r.is_active)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.gestao_snapshot(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gestao_snapshot(text, text) TO authenticated, service_role;
