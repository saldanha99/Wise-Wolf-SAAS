-- Experimental deixa de ser "Aluno não cadastrado" e passa a mostrar o nome.
--
-- A aula experimental não vincula perfil de aluno (class_logs.student_id fica
-- NULL), então TODAS as experimentais do professor colapsavam numa linha só
-- chamada "Aluno não cadastrado" — a Lais aparecia com 19 experimentais num
-- bloco cego, sem dar para saber quem foi atendido.
--
-- O nome existe: class_logs.appointment_id → appointments.student_name (todas as
-- 28 experimentais de julho/2026 resolvem). Agora cada experimental é uma linha
-- com nome próprio, o que também expõe o que estava escondido no bloco: a escola
-- vinha usando a experimental para COBRIR aluno de outro professor e para lançar
-- TREINAMENTO, e havia treinamento lançado em duplicidade.

CREATE OR REPLACE FUNCTION public.get_teacher_closing_report(p_teacher_id uuid, p_month text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_students jsonb; v_resumo jsonb; v_excluidas jsonb;
  v_teacher jsonb; v_closing jsonb;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
    IF auth.uid() IS DISTINCT FROM p_teacher_id
       AND (v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR')) THEN
      RAISE EXCEPTION 'Sem permissão para ver este relatório';
    END IF;
  END IF;

  IF p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Mês inválido (use YYYY-MM)';
  END IF;

  SELECT jsonb_build_object('id', p.id, 'name', p.full_name, 'avatar_url', p.avatar_url)
    INTO v_teacher FROM profiles p WHERE p.id = p_teacher_id;

  SELECT jsonb_build_object('id', tc.id, 'status', tc.status, 'total_lessons', tc.total_lessons,
           'total_amount', tc.total_amount, 'paid_at', tc.paid_at, 'admin_notes', tc.admin_notes)
    INTO v_closing FROM teacher_closings tc
   WHERE tc.teacher_id = p_teacher_id AND tc.month_year = p_month LIMIT 1;

  WITH pagas AS (
    SELECT v.id, v.student_id, v.class_date, v.presence, v.subtype, v.appointment_id,
           v.rate_efetivo AS rate,
           (v.rate_override IS NOT NULL) AS overridden,
           v.reposicao_sem_origem,
           COALESCE(v.subtype = 'AULA EXPERIMENTAL', false) AS experimental,
           -- Nome de exibição: aluno cadastrado, senão o nome do agendamento da
           -- experimental/treinamento.
           COALESCE(sp.full_name, ap.student_name) AS nome,
           -- Chave de agrupamento: aluno cadastrado agrupa por perfil; experimental
           -- agrupa por agendamento, para cada uma virar a sua própria linha.
           COALESCE(v.student_id::text, 'appt:' || COALESCE(v.appointment_id, v.id::text)) AS grp
    FROM v_payable_class_logs v
    LEFT JOIN profiles sp ON sp.id = v.student_id
    LEFT JOIN appointments ap ON ap.id::text = v.appointment_id
    WHERE v.teacher_id = p_teacher_id
      AND to_char(v.class_date,'YYYY-MM') = p_month
  ), linhas AS (
    SELECT
      pg.grp,
      max(pg.student_id::text) AS student_id,
      max(COALESCE(pg.nome, 'Aluno não cadastrado')) AS student_name,
      pg.experimental,
      count(*) AS aulas,
      sum(pg.rate) AS valor,
      round(sum(pg.rate) / NULLIF(count(*),0), 2) AS valor_base,
      count(distinct pg.rate)::int AS qtd_tarifas,
      max(COALESCE(sp.lesson_duration_minutes, 30)) AS duracao_min,
      bool_or(pg.overridden) AS tem_ajuste,
      bool_or(pg.reposicao_sem_origem) AS revisar,
      count(distinct to_char(pg.class_date,'IYYY-IW')) AS semanas,
      max(sp.class_frequency) AS freq_perfil,
      count(*) FILTER (WHERE pg.presence <> 'COMPLETED') AS faltas_aluno,
      jsonb_agg(jsonb_build_object(
        'id', pg.id, 'date', pg.class_date, 'presence', pg.presence, 'subtype', pg.subtype,
        'valor', pg.rate, 'override', pg.overridden
      ) ORDER BY pg.class_date) AS detalhe
    FROM pagas pg
    LEFT JOIN profiles sp ON sp.id = pg.student_id
    GROUP BY pg.grp, pg.experimental
  )
  SELECT jsonb_agg(jsonb_build_object(
      'student_id', l.student_id,
      'student', trim(l.student_name),
      'tipo', CASE WHEN l.experimental THEN 'Aula experimental' ELSE 'Regular' END,
      'frequencia', CASE
        WHEN l.experimental THEN 'Aula experimental'
        WHEN l.freq_perfil IS NOT NULL AND l.freq_perfil ~ '^\d' THEN regexp_replace(l.freq_perfil,'^(\d+).*$','\1') || 'x por semana'
        WHEN l.semanas >= 3 AND round(l.aulas::numeric / l.semanas) >= 1
          THEN round(l.aulas::numeric / l.semanas) || 'x por semana'
        WHEN l.aulas = 1 THEN '1 aula'
        ELSE 'Aulas avulsas'
      END,
      'duracao_min', l.duracao_min,
      'aulas', l.aulas,
      'faltas_aluno', l.faltas_aluno,
      'valor_base', l.valor_base,
      'qtd_tarifas', l.qtd_tarifas,
      'valor', l.valor,
      'tem_ajuste', l.tem_ajuste,
      'revisar', l.revisar,
      'detalhe', l.detalhe
    ) ORDER BY l.experimental, trim(l.student_name))
  INTO v_students FROM linhas l;

  SELECT jsonb_build_object(
      'total_alunos', count(distinct v.student_id) FILTER (WHERE v.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL' AND v.student_id IS NOT NULL),
      'aulas_regulares', count(*) FILTER (WHERE v.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL'),
      'aulas_experimentais', count(*) FILTER (WHERE v.subtype = 'AULA EXPERIMENTAL'),
      'total_aulas', count(*),
      'valor_total', COALESCE(sum(v.rate_efetivo),0))
  INTO v_resumo
  FROM v_payable_class_logs v
  WHERE v.teacher_id = p_teacher_id AND to_char(v.class_date,'YYYY-MM') = p_month;

  SELECT jsonb_build_object(
      'falta_professor', count(*) FILTER (WHERE cl.presence IN ('TEACHER_ABSENCE','Falta do Professor')),
      'em_conflito', count(*) FILTER (WHERE COALESCE(cl.payment_hold,false)),
      'teste_oral', count(*) FILTER (WHERE cl.subtype = 'Teste Oral'),
      'nao_faturavel', count(*) FILTER (WHERE NOT is_billable_student(cl.student_id) AND cl.student_id IS NOT NULL),
      'reposicao_falta_aluno', count(*) FILTER (
         WHERE cl.subtype IN ('REPOSIÇÃO','REPOSIÇÃO_PROF')
           AND EXISTS (SELECT 1 FROM reschedules r2 WHERE r2.id::text = cl.reschedule_id AND r2.fault_type = 'STUDENT')),
      'duplicadas', count(*) FILTER (
         WHERE cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
           AND cl.subtype IS DISTINCT FROM 'Teste Oral'
           AND COALESCE(cl.payment_hold,false) = false
           AND NOT EXISTS (SELECT 1 FROM v_payable_class_logs v2 WHERE v2.id = cl.id)
           AND is_billable_student(cl.student_id)))
  INTO v_excluidas
  FROM class_logs cl
  WHERE cl.teacher_id = p_teacher_id AND to_char(cl.class_date,'YYYY-MM') = p_month;

  RETURN jsonb_build_object(
    'teacher', v_teacher, 'month', p_month, 'closing', v_closing,
    'students', COALESCE(v_students, '[]'::jsonb),
    'resumo', v_resumo, 'excluidas', v_excluidas
  );
END;
$function$;

-- Painel de custo/margem do diretor: mesma coisa, nome no lugar de "não cadastrado".
CREATE OR REPLACE FUNCTION public.director_teacher_margin(p_month text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text; v_rows jsonb; v_total jsonb;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  SELECT role, tenant_id INTO v_caller_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_jwt_role IN ('anon','authenticated') THEN
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RAISE EXCEPTION 'Apenas a direção pode ver custo e margem';
    END IF;
  END IF;

  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  IF v_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Mês inválido (use YYYY-MM)'; END IF;

  WITH custo AS (
    SELECT v.teacher_id,
           COALESCE(v.student_id::text, 'appt:' || COALESCE(v.appointment_id, v.id::text)) AS grp,
           max(v.student_id::text) AS student_id,
           max(COALESCE(sp.full_name, ap.student_name, 'Aluno não cadastrado')) AS student_name,
           bool_or(v.subtype = 'AULA EXPERIMENTAL') AS experimental,
           count(*) AS aulas, sum(v.rate_efetivo) AS custo
    FROM v_payable_class_logs v
    JOIN profiles t ON t.id = v.teacher_id
    LEFT JOIN profiles sp ON sp.id = v.student_id
    LEFT JOIN appointments ap ON ap.id::text = v.appointment_id
    WHERE to_char(v.class_date,'YYYY-MM') = v_month
      AND (v_caller_role = 'SUPER_ADMIN' OR t.tenant_id = v_tenant)
    GROUP BY v.teacher_id, COALESCE(v.student_id::text, 'appt:' || COALESCE(v.appointment_id, v.id::text))
  ), receita AS (
    SELECT sp.student_id, sum(COALESCE(sp.value, sp.amount_cents / 100.0)) AS receita
    FROM student_payments sp
    WHERE sp.status IN ('RECEIVED','CONFIRMED','PAID','RECEIVED_IN_CASH')
      AND to_char(COALESCE(sp.paid_at::date, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
    GROUP BY sp.student_id
  )
  SELECT jsonb_agg(x ORDER BY x->>'teacher_name', x->>'student_name')
    INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'teacher_id', c.teacher_id, 'teacher_name', trim(t.full_name),
      'student_id', c.student_id, 'student_name', trim(c.student_name),
      'experimental', c.experimental,
      'aulas', c.aulas, 'custo', round(c.custo,2),
      'receita', round(COALESCE(r.receita,0),2),
      'margem', round(COALESCE(r.receita,0) - c.custo, 2)
    ) AS x
    FROM custo c
    JOIN profiles t ON t.id = c.teacher_id
    LEFT JOIN receita r ON r.student_id::text = c.student_id
  ) z;

  WITH custo AS (
    SELECT sum(v.rate_efetivo) AS custo, count(*) AS aulas
    FROM v_payable_class_logs v JOIN profiles t ON t.id = v.teacher_id
    WHERE to_char(v.class_date,'YYYY-MM') = v_month
      AND (v_caller_role = 'SUPER_ADMIN' OR t.tenant_id = v_tenant)
  ), receita AS (
    SELECT sum(COALESCE(sp.value, sp.amount_cents / 100.0)) AS receita
    FROM student_payments sp JOIN profiles s ON s.id = sp.student_id
    WHERE sp.status IN ('RECEIVED','CONFIRMED','PAID','RECEIVED_IN_CASH')
      AND to_char(COALESCE(sp.paid_at::date, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
      AND (v_caller_role = 'SUPER_ADMIN' OR s.tenant_id = v_tenant)
  )
  SELECT jsonb_build_object(
    'aulas', COALESCE((SELECT aulas FROM custo),0),
    'custo', round(COALESCE((SELECT custo FROM custo),0),2),
    'receita', round(COALESCE((SELECT receita FROM receita),0),2),
    'margem', round(COALESCE((SELECT receita FROM receita),0) - COALESCE((SELECT custo FROM custo),0),2)
  ) INTO v_total;

  RETURN jsonb_build_object('month', v_month, 'rows', COALESCE(v_rows,'[]'::jsonb), 'total', v_total);
END;
$function$;
