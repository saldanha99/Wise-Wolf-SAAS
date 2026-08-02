-- Snapshot gerencial — a base factual do assistente do grupo.
--
-- O assistente NÃO consulta o banco livremente e não tem laço de ferramentas.
-- Ele recebe este retrato pronto e responde em cima dele. Três razões:
--   1. Uma IA que monta a própria query decide sozinha o que é "receita" — e
--      este projeto passou a semana consertando justamente relatórios que
--      divergiam por usarem definições diferentes. Aqui a definição continua
--      sendo a das RPCs (dre_gerencial, balancete_professores), uma só.
--   2. Escopo: o snapshot é montado com o tenant resolvido pelo servidor. Não
--      existe caminho para a pergunta alcançar outra escola.
--   3. Custo e latência previsíveis — uma chamada, sem ida e volta.
--
-- O preço é conhecido: o que não estiver aqui, o assistente não sabe. O prompt
-- manda dizer que não sabe em vez de inventar, e a lista de pendências existe
-- justamente para cobrir o que mais se pergunta.

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
  -- O mês anterior é o que interessa para "como fomos": o corrente ainda está
  -- pela metade e induz a conclusão errada se comparado de igual para igual.
  v_bal       := balancete_professores(v_ant, v_tenant);
  v_caixa     := get_cashflow(v_mes);
  v_mei       := get_mei_radar(v_tenant);
  IF v_mei ? 'error' THEN v_mei := NULL; END IF;

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

    -- Sem alunos_detalhe: o prompt ficaria enorme e a pergunta típica é por
    -- professor. Quem quiser aluno a aluno abre o balancete na tela.
    'professores_mes_fechado', COALESCE((
      SELECT jsonb_agg(p - 'alunos_detalhe')
        FROM jsonb_array_elements(v_bal->'professores') p), '[]'::jsonb),

    'pendencias', jsonb_build_object(
      'fechamentos_nao_pagos', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('professor', trim(pr.full_name),
                 'mes', tc.month_year, 'valor', tc.total_amount, 'status', tc.status)
               ORDER BY tc.month_year DESC, tc.total_amount DESC)
          FROM teacher_closings tc JOIN profiles pr ON pr.id = tc.teacher_id
         WHERE tc.tenant_id = v_tenant AND tc.status <> 'PAGO'), '[]'::jsonb),
      'pagamentos_sem_aluno', jsonb_build_object(
        'valor', v_bal->'receita_sem_aluno'),
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

COMMENT ON FUNCTION public.gestao_snapshot(text, text) IS
  'Retrato gerencial da escola (resultado, professores, pendências, inadimplência, MEI) para o assistente do grupo de gestão. Deriva das RPCs existentes — não redefine receita nem custo.';

REVOKE ALL ON FUNCTION public.gestao_snapshot(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gestao_snapshot(text, text) TO authenticated, service_role;
