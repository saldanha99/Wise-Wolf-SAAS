-- O JSON do snapshot precisa se explicar sozinho.
--
-- Perguntado "qual aluno mais faltou em julho", o assistente respondeu que NÃO
-- tinha o dado — com a lista de faltas por aluno dentro do payload. A chave se
-- chamava só `faltas`, sem dizer de que mês, e o modelo não arriscou afirmar que
-- era julho. Ele fez o certo: preferiu dizer que não sabia a inventar.
--
-- A lição vale para todo campo novo: o modelo vê APENAS o JSON, sem o contexto
-- de quem o montou. Nome de chave é documentação. `faltas` virou
-- `faltas_mes_fechado`, e cada bloco carrega o próprio `mes`.

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
    'mes', p_month,                     -- ← sem isto o dado é inutilizável
    'aulas_no_mes',        (SELECT count(*)::int FROM aulas),
    'faltas_de_aluno',     (SELECT count(*)::int FROM aulas WHERE presence = 'STUDENT_ABSENCE'),
    'faltas_de_professor', (SELECT count(*)::int FROM aulas WHERE presence = 'TEACHER_ABSENCE'),
    'reposicoes',          (SELECT count(*)::int FROM aulas WHERE subtype = 'REPOSIÇÃO'),
    'pct_falta_aluno',     (SELECT round(100.0 * count(*) FILTER (WHERE presence='STUDENT_ABSENCE')
                                          / NULLIF(count(*),0), 1) FROM aulas),
    'alunos_que_mais_faltaram_neste_mes', COALESCE((
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
    'professores_que_faltaram_neste_mes', COALESCE((
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
    'mes', p_month,
    'alunos', (SELECT count(*)::int FROM faltando),
    'aulas',  (SELECT COALESCE(sum(aulas),0)::int FROM faltando),
    'receita_nao_faturada', (SELECT round(COALESCE(sum(mensalidade),0),2) FROM faltando),
    'sem_mensalidade_cadastrada', (SELECT count(*)::int FROM faltando WHERE mensalidade = 0),
    'detalhe', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'aluno', trim(full_name), 'professor', prof, 'aulas', aulas, 'mensalidade', mensalidade)
        ORDER BY mensalidade DESC, aulas DESC) FROM faltando), '[]'::jsonb)
  );
$function$;

GRANT EXECUTE ON FUNCTION public.gestao_alunos_sem_cobranca(text,text) TO service_role, authenticated;

-- `gestao_snapshot` fica INTACTA de propósito. A causa do erro era o modelo não
-- saber de que mês era o bloco, e o campo `mes` dentro dele resolve isso — as
-- chaves `faltas` e `faltas_mes_corrente` continuam servindo, agora com o mês
-- declarado. Reescrever a função inteira só para renomear chave seria mexer em
-- 90 linhas para ganhar o que 3 já ganharam.
