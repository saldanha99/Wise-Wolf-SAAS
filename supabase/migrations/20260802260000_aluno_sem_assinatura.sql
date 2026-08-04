-- Aluno com mensalidade e SEM assinatura: o vazamento que ninguém via.
--
-- Investigação (02/08/2026): o diretor perguntou quem deu mais lucro, o ranking
-- saiu enganoso, e a apuração chegou aqui — 20 alunos com `monthly_fee > 0` estão
-- com `subscription_id` NULO. Sem assinatura no Asaas, NADA gera a cobrança
-- mensal deles: ela só existe se alguém criar à mão ou se cair um Pix avulso.
--
-- O caso mais gritante: Gabriel Cavalcante Natal, 61 aulas entre março e julho,
-- mensalidade R$ 187,00 cadastrada, ZERO cobrança na vida. São R$ 4.663,05 em
-- meses posteriores à matrícula sem faturar.
--
-- Por que passou despercebido: inadimplência é cobrança VENCIDA e não paga.
-- Cobrança que nunca foi criada não vence — não entra em relatório de
-- inadimplência, não dispara lembrete, não aparece em lugar nenhum. O aluno
-- assiste às aulas normalmente e o professor é pago normalmente.
--
-- ⚠️ Esta migration NÃO cria assinatura nem cobrança retroativa. Cobrar cinco
-- meses de alguém que nunca foi cobrado é conversa com o cliente, não INSERT.
-- O que ela faz é impedir que continue invisível.

CREATE OR REPLACE FUNCTION public.alunos_sem_assinatura(p_tenant text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_jwt text; v_role text; v_tenant text;
BEGIN
  v_jwt := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_jwt IN ('anon','authenticated') THEN
    IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RETURN jsonb_build_object('error','sem_permissao');
    END IF;
    IF v_role = 'SUPER_ADMIN' THEN v_tenant := COALESCE(p_tenant, v_tenant); END IF;
  ELSE
    v_tenant := COALESCE(p_tenant, v_tenant);
  END IF;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('error','escola_nao_identificada'); END IF;

  RETURN (
    WITH candidatos AS (
      SELECT p.id, trim(p.full_name) AS nome, p.monthly_fee AS mensalidade,
             p.created_at::date AS matriculado,
             -- Só conta quem REALMENTE estuda: a base tem conta de teste, e
             -- alarmar por elas ensina o diretor a ignorar o alerta.
             (SELECT count(*) FROM v_payable_class_logs v
               WHERE v.student_id = p.id
                 AND v.class_date >= (current_date - 60))::int AS aulas_60d,
             (SELECT max(v.class_date) FROM v_payable_class_logs v WHERE v.student_id = p.id) AS ultima_aula,
             (SELECT count(*) FROM student_payments sp WHERE sp.student_id = p.id)::int AS cobrancas_na_vida
        FROM profiles p
       WHERE p.tenant_id = v_tenant AND p.role = 'STUDENT'
         AND COALESCE(p.monthly_fee,0) > 0
         AND COALESCE(p.subscription_id,'') = ''
         AND is_student_notifiable(p.id)
    ), reais AS (
      SELECT * FROM candidatos WHERE aulas_60d > 0
    )
    SELECT jsonb_build_object(
      'alunos', (SELECT count(*)::int FROM reais),
      'mensalidade_mensal_em_risco', (SELECT round(COALESCE(sum(mensalidade),0),2) FROM reais),
      'nunca_cobrados', (SELECT count(*)::int FROM reais WHERE cobrancas_na_vida = 0),
      'detalhe', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'aluno', nome, 'mensalidade', mensalidade, 'matriculado', matriculado,
          'aulas_ultimos_60d', aulas_60d, 'ultima_aula', ultima_aula,
          'cobrancas_na_vida', cobrancas_na_vida)
          ORDER BY cobrancas_na_vida, mensalidade DESC) FROM reais), '[]'::jsonb)
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.alunos_sem_assinatura(text) IS
  'Aluno ATIVO, com mensalidade cadastrada, tendo aula, e sem subscription_id — ninguém gera a cobrança dele. Não aparece em inadimplência porque a cobrança nunca chega a vencer.';

REVOKE ALL ON FUNCTION public.alunos_sem_assinatura(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alunos_sem_assinatura(text) TO authenticated, service_role;

-- Entra no snapshot do assistente pendurado no bloco que já existe, em vez de
-- reescrever gestao_snapshot inteira só para acrescentar uma chave. Semântica
-- casa: quem pergunta "tem aluno sem ser cobrado" quer saber os dois — o mês que
-- falhou E quem não tem nada gerando cobrança.
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
        ORDER BY mensalidade DESC, aulas DESC) FROM faltando), '[]'::jsonb),
    -- Causa raiz, não sintoma: aluno sem assinatura nunca vai gerar cobrança.
    'causa_raiz_sem_assinatura_ativa', alunos_sem_assinatura(p_tenant)
  );
$function$;

GRANT EXECUTE ON FUNCTION public.gestao_alunos_sem_cobranca(text,text) TO service_role, authenticated;

-- Entra na Central de Pendências, que é onde o diretor olha o que espera ação.
CREATE OR REPLACE FUNCTION public.director_pending_counts()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN RETURN '{}'::jsonb; END IF;

  RETURN jsonb_build_object(
    'acolhimento', (SELECT count(*) FROM profiles
        WHERE tenant_id = v_tenant AND role='STUDENT' AND documentation_status='PENDING'),
    'presenca', (SELECT count(*) FROM attendance_confirmations ac
        JOIN class_logs cl ON cl.id = ac.class_log_id
        WHERE cl.tenant_id = v_tenant AND ac.status='CONFLICT'),
    'materiais', (SELECT count(*) FROM pedagogical_materials
        WHERE tenant_id = v_tenant AND approval_status='PENDING'),
    'trials', (SELECT count(*) FROM appointments a
        WHERE a.tenant_id = v_tenant AND a.type IN ('experimental','training')
          AND a.status='scheduled' AND a.start_time <= now()
          AND a.start_time >= '2026-06-01'::timestamptz
          AND NOT EXISTS (SELECT 1 FROM class_logs cl WHERE cl.appointment_id = a.id::text)),
    'pagamentos_retidos', (SELECT count(*) FROM class_logs
        WHERE tenant_id = v_tenant AND COALESCE(payment_hold,false)=true),
    'fechamentos', (SELECT count(*) FROM teacher_closings
        WHERE tenant_id = v_tenant AND status='PENDENTE'),
    -- NOVO: aluno tendo aula que ninguém está cobrando.
    'sem_assinatura', COALESCE((alunos_sem_assinatura(v_tenant)->>'alunos')::int, 0)
  );
END;
$function$;
