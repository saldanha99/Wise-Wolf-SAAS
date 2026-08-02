-- Snapshot gerencial: totais prontos, para o modelo não somar nada.
--
-- Defeito pego no primeiro teste real (02/08/2026). Perguntado "tem algo
-- pendente?", o assistente respondeu "R$ 1.048,00 em fechamentos pendentes para
-- julho" — que é o fechamento do Mateus. O pendente de julho é R$ 2.120,00,
-- somando os cinco professores. O modelo escolheu o maior item da lista em vez
-- de somar.
--
-- A culpa é do desenho, não do modelo: eu entreguei uma lista e esperei
-- aritmética. Número errado sobre dinheiro destrói a confiança no assistente
-- inteiro — e "quanto falta pagar" é das perguntas mais prováveis no grupo.
--
-- Correção: o snapshot passa a trazer os totais calculados no banco. O modelo lê
-- e repete; não agrega. Mesma disciplina do resto do projeto — quem define
-- número é SQL, não a camada que redige o texto.

CREATE OR REPLACE FUNCTION public.gestao_snapshot(
  p_month text DEFAULT NULL, p_tenant text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_role text; v_tenant text;
  v_mes text; v_ant text; v_hoje date;
  v_dre_atual jsonb; v_dre_ant jsonb; v_bal jsonb; v_caixa jsonb; v_mei jsonb;
  v_fech jsonb;
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

  -- Fechamentos em aberto: total geral, total por mês E o detalhe. O modelo
  -- responde "quanto falta pagar" lendo `total`, sem somar lista nenhuma.
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
    'hoje', v_hoje,
    'mes_corrente', v_mes,
    'mes_fechado', v_ant,

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
      'alertas', v_dre_ant->'alertas',
      'linhas', v_dre_ant->'linhas'),

    'professores_mes_fechado', COALESCE((
      SELECT jsonb_agg(p - 'alunos_detalhe')
        FROM jsonb_array_elements(v_bal->'professores') p), '[]'::jsonb),
    'total_a_pagar_professores_mes_fechado', v_bal#>'{totais,custo_total}',

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
