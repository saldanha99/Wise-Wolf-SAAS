-- Regra ÚNICA de aula pagável + painel de custo/margem por professor e aluno.
--
-- Problema 1 — a regra de pagamento estava escrita em 4 lugares diferentes e já
-- tinha divergido: get_teacher_closing_report e run_monthly_teacher_closing pagam
-- reposição, lesson_pays_teacher (órfã, ninguém chama) não pagava, e o front tinha
-- a sua própria cópia. Agora existe UMA view — v_payable_class_logs — e todo mundo
-- lê dela. Mudou a regra? Muda num lugar só.
--
-- Problema 2 — regras que a direção pediu em 01/08/2026:
--   * falta do PROFESSOR não paga (já era assim) e só vira dinheiro quando a
--     reposição correspondente é dada — a reposição é que é paga;
--   * reposição de falta do ALUNO NÃO paga: a aula original (STUDENT_ABSENCE) já
--     foi remunerada, pagar a reposição pagaria a mesma aula duas vezes;
--   * aula experimental não pode ser paga em duplicidade (um lançamento por
--     appointment);
--   * lançamento solto (sem booking) não paga quando já existe, no mesmo dia e
--     para o mesmo aluno, um lançamento vinculado à agenda — é o padrão de
--     duplicata que sobrou no histórico (dois casos em julho).
--
-- ⚠️ Aluno com dois horários seguidos no mesmo dia (ex.: 19:00 + 19:30 = aula de
-- 1 hora partida em dois slots de 30 min) NÃO é duplicata e continua pagando as
-- duas. Auditei maio–julho: zero duplicatas de mesmo aluno + mesma data + mesmo
-- horário.

CREATE OR REPLACE VIEW public.v_payable_class_logs AS
SELECT
  cl.*,
  COALESCE(cl.rate_override,
           teacher_student_rate(cl.teacher_id, cl.student_id, cl.class_date)) AS rate_efetivo,
  -- Reposição sem origem registrada: paga (não dá para provar duplicidade), mas
  -- fica marcada para a direção conferir no painel.
  (cl.subtype IN ('REPOSIÇÃO','REPOSIÇÃO_PROF') AND r.id IS NULL) AS reposicao_sem_origem
FROM class_logs cl
LEFT JOIN reschedules r ON r.id::text = cl.reschedule_id
WHERE cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
  AND cl.subtype IS DISTINCT FROM 'Teste Oral'
  AND COALESCE(cl.payment_hold, false) = false
  AND is_billable_student(cl.student_id)
  -- Reposição de falta do ALUNO: a original já foi paga → não paga de novo.
  -- COALESCE obrigatório: a maioria das aulas tem subtype NULL, e `NULL IN (...)`
  -- devolve NULL — sem isso o NOT vira NULL e a aula normal some da folha.
  AND NOT COALESCE(cl.subtype IN ('REPOSIÇÃO','REPOSIÇÃO_PROF') AND r.fault_type = 'STUDENT', false)
  -- Experimental: só o primeiro lançamento de cada appointment.
  AND (
    cl.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL'
    OR cl.appointment_id IS NULL
    OR cl.id = (
      SELECT c2.id FROM class_logs c2
      WHERE c2.subtype = 'AULA EXPERIMENTAL'
        AND c2.appointment_id = cl.appointment_id
      ORDER BY c2.created_at, c2.id
      LIMIT 1
    )
  )
  -- Lançamento solto que espelha um lançamento da agenda no mesmo dia.
  AND NOT (
    cl.booking_id IS NULL
    AND cl.student_id IS NOT NULL
    AND cl.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL'
    AND EXISTS (
      SELECT 1 FROM class_logs c3
      WHERE c3.booking_id IS NOT NULL
        AND c3.teacher_id = cl.teacher_id
        AND c3.student_id = cl.student_id
        AND c3.class_date = cl.class_date
        AND c3.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
        AND COALESCE(c3.payment_hold, false) = false
    )
  );

COMMENT ON VIEW public.v_payable_class_logs IS
  'Fonte ÚNICA de "esta aula paga o professor". Consumida por get_teacher_closing_report, run_monthly_teacher_closing e director_teacher_margin. Não reescreva a regra fora daqui.';

GRANT SELECT ON public.v_payable_class_logs TO authenticated, service_role;

-- lesson_pays_teacher estava órfã e com regra divergente (não pagava reposição).
-- Passa a responder pela view, para não voltar a mentir se alguém a chamar.
CREATE OR REPLACE FUNCTION public.lesson_pays_teacher(p_log_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM v_payable_class_logs v WHERE v.id = p_log_id);
$function$;

-- Relatório do professor: passa a ler da view -------------------------------
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
    SELECT v.id, v.student_id, v.class_date, v.presence, v.subtype,
           v.rate_efetivo AS rate,
           (v.rate_override IS NOT NULL) AS overridden,
           v.reposicao_sem_origem,
           COALESCE(v.subtype = 'AULA EXPERIMENTAL', false) AS experimental
    FROM v_payable_class_logs v
    WHERE v.teacher_id = p_teacher_id
      AND to_char(v.class_date,'YYYY-MM') = p_month
  ), linhas AS (
    SELECT
      pg.student_id,
      max(COALESCE(sp.full_name, 'Aluno não cadastrado')) AS student_name,
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
    GROUP BY pg.student_id, pg.experimental
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

  -- O que ficou de fora: agora inclui o que a regra nova barrou.
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

-- Fechamento mensal: mesma view ----------------------------------------------
CREATE OR REPLACE FUNCTION public.run_monthly_teacher_closing(p_month text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_month text; v_created int := 0; v_updated int := 0; r record;
  v_jwt_role text; v_caller_role text; v_updated_ids uuid[] := '{}';
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION 'Apenas administradores podem rodar o fechamento mensal';
    END IF;
  END IF;

  v_month := COALESCE(p_month, to_char(current_date - interval '1 month','YYYY-MM'));

  FOR r IN
    SELECT t.id AS teacher_id, t.tenant_id
    FROM profiles t WHERE t.role='TEACHER'
      AND (
        EXISTS (SELECT 1 FROM class_logs cl WHERE cl.teacher_id=t.id AND to_char(cl.class_date,'YYYY-MM')=v_month)
        OR EXISTS (SELECT 1 FROM teacher_closings tc0 WHERE tc0.teacher_id=t.id AND tc0.month_year=v_month AND tc0.status='PENDENTE')
      )
  LOOP
    DECLARE v_paid int; v_amount numeric; v_existing teacher_closings%ROWTYPE;
    BEGIN
      SELECT count(*), round(COALESCE(sum(v.rate_efetivo),0), 2)
        INTO v_paid, v_amount
      FROM v_payable_class_logs v
       WHERE v.teacher_id = r.teacher_id AND to_char(v.class_date,'YYYY-MM') = v_month;

      SELECT * INTO v_existing FROM teacher_closings
       WHERE teacher_id=r.teacher_id AND month_year=v_month LIMIT 1;

      IF v_existing.id IS NOT NULL THEN
        IF v_existing.status = 'PENDENTE'
           AND (v_existing.total_lessons IS DISTINCT FROM v_paid
             OR v_existing.total_amount IS DISTINCT FROM v_amount) THEN
          UPDATE teacher_closings SET
            total_lessons = v_paid,
            total_amount  = v_amount,
            updated_at    = now(),
            teacher_confirmation_status = CASE WHEN teacher_confirmation_status='OK' THEN 'PENDENTE' ELSE teacher_confirmation_status END,
            teacher_confirmation_date   = CASE WHEN teacher_confirmation_status='OK' THEN NULL ELSE teacher_confirmation_date END
          WHERE id = v_existing.id;
          DELETE FROM automation_sent
           WHERE kind='MONTHLY_CLOSING' AND subject_id = r.teacher_id::text || ':' || v_month;
          v_updated := v_updated + 1;
          v_updated_ids := v_updated_ids || r.teacher_id;
        END IF;
        CONTINUE;
      END IF;

      INSERT INTO teacher_closings (teacher_id, tenant_id, month_year, total_lessons, total_amount, status,
        period_start, period_end, created_at)
      VALUES (r.teacher_id, r.tenant_id, v_month, v_paid, v_amount, 'PENDENTE',
        (v_month||'-01')::date, (date_trunc('month',(v_month||'-01')::date) + interval '1 month - 1 day')::date, now());
      v_created := v_created + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'month', v_month, 'created', v_created,
    'updated', v_updated, 'updated_teacher_ids', to_jsonb(v_updated_ids));
END;
$function$;

-- set_student_month_pay: recalcula o fechamento pela view --------------------
CREATE OR REPLACE FUNCTION public.set_student_month_pay(
  p_teacher_id uuid, p_student_id uuid, p_month text,
  p_rate numeric DEFAULT NULL, p_duration_minutes integer DEFAULT NULL,
  p_clear_rate boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_caller_tenant text;
  v_teacher_tenant text; v_afetadas int := 0;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    SELECT role, tenant_id INTO v_caller_role, v_caller_tenant FROM profiles WHERE id = auth.uid();
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RAISE EXCEPTION 'Apenas a direção pode alterar valores de pagamento';
    END IF;
  END IF;

  SELECT tenant_id INTO v_teacher_tenant FROM profiles WHERE id = p_teacher_id;
  IF v_teacher_tenant IS NULL THEN RAISE EXCEPTION 'Professor não encontrado'; END IF;
  IF v_caller_role IN ('SCHOOL_ADMIN','COORDINATOR') AND v_caller_tenant IS DISTINCT FROM v_teacher_tenant THEN
    RAISE EXCEPTION 'Sem permissão para alterar pagamento de professor de outra escola';
  END IF;
  IF p_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Mês inválido (use YYYY-MM)'; END IF;
  IF p_rate IS NOT NULL AND p_rate < 0 THEN RAISE EXCEPTION 'O valor não pode ser negativo'; END IF;
  IF p_duration_minutes IS NOT NULL AND (p_duration_minutes <= 0 OR p_duration_minutes > 600) THEN
    RAISE EXCEPTION 'Duração inválida (informe entre 1 e 600 minutos)';
  END IF;

  IF p_clear_rate OR p_rate IS NOT NULL THEN
    UPDATE class_logs cl
       SET rate_override = CASE WHEN p_clear_rate THEN NULL ELSE p_rate END
     WHERE cl.teacher_id = p_teacher_id
       AND cl.student_id IS NOT DISTINCT FROM p_student_id
       AND to_char(cl.class_date,'YYYY-MM') = p_month
       AND EXISTS (SELECT 1 FROM v_payable_class_logs v WHERE v.id = cl.id);
    GET DIAGNOSTICS v_afetadas = ROW_COUNT;
  END IF;

  IF p_duration_minutes IS NOT NULL AND p_student_id IS NOT NULL THEN
    UPDATE profiles SET lesson_duration_minutes = p_duration_minutes WHERE id = p_student_id;
  END IF;

  UPDATE teacher_closings tc SET
    total_lessons = sub.paid, total_amount = sub.amount, updated_at = now(),
    teacher_confirmation_status = CASE WHEN tc.teacher_confirmation_status = 'OK' THEN 'PENDENTE' ELSE tc.teacher_confirmation_status END,
    teacher_confirmation_date   = CASE WHEN tc.teacher_confirmation_status = 'OK' THEN NULL ELSE tc.teacher_confirmation_date END
  FROM (
    SELECT count(*) AS paid, round(COALESCE(sum(v.rate_efetivo),0), 2) AS amount
    FROM v_payable_class_logs v
    WHERE v.teacher_id = p_teacher_id AND to_char(v.class_date,'YYYY-MM') = p_month
  ) sub
  WHERE tc.teacher_id = p_teacher_id AND tc.month_year = p_month AND tc.status = 'PENDENTE';

  RETURN jsonb_build_object('ok', true, 'aulas_ajustadas', v_afetadas,
    'teacher_id', p_teacher_id, 'student_id', p_student_id, 'month', p_month);
END;
$function$;

-- Painel do diretor: custo x receita x margem, por professor e aluno ----------
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
    -- Custo com professor = exatamente o que a folha paga (mesma view).
    SELECT v.teacher_id, v.student_id, count(*) AS aulas, sum(v.rate_efetivo) AS custo
    FROM v_payable_class_logs v
    JOIN profiles t ON t.id = v.teacher_id
    WHERE to_char(v.class_date,'YYYY-MM') = v_month
      AND (v_caller_role = 'SUPER_ADMIN' OR t.tenant_id = v_tenant)
    GROUP BY v.teacher_id, v.student_id
  ), receita AS (
    -- Receita = mensalidade efetivamente recebida do aluno no mês.
    SELECT sp.student_id, sum(COALESCE(sp.value, sp.amount_cents / 100.0)) AS receita
    FROM student_payments sp
    WHERE sp.status IN ('RECEIVED','CONFIRMED','PAID','RECEIVED_IN_CASH')
      AND to_char(COALESCE(sp.paid_at::date, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
    GROUP BY sp.student_id
  ), linhas AS (
    SELECT c.teacher_id, t.full_name AS teacher_name, c.student_id,
           COALESCE(s.full_name,'Aluno não cadastrado') AS student_name,
           c.aulas, round(c.custo,2) AS custo,
           round(COALESCE(r.receita,0),2) AS receita,
           round(COALESCE(r.receita,0) - c.custo, 2) AS margem
    FROM custo c
    JOIN profiles t ON t.id = c.teacher_id
    LEFT JOIN profiles s ON s.id = c.student_id
    LEFT JOIN receita r ON r.student_id = c.student_id
  )
  SELECT jsonb_agg(x ORDER BY x->>'teacher_name', x->>'student_name')
    INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'teacher_id', l.teacher_id, 'teacher_name', trim(l.teacher_name),
      'student_id', l.student_id, 'student_name', trim(l.student_name),
      'aulas', l.aulas, 'custo', l.custo, 'receita', l.receita, 'margem', l.margem
    ) AS x FROM linhas l
  ) z;

  WITH custo AS (
    SELECT v.teacher_id, sum(v.rate_efetivo) AS custo, count(*) AS aulas
    FROM v_payable_class_logs v JOIN profiles t ON t.id = v.teacher_id
    WHERE to_char(v.class_date,'YYYY-MM') = v_month
      AND (v_caller_role = 'SUPER_ADMIN' OR t.tenant_id = v_tenant)
    GROUP BY v.teacher_id
  ), receita AS (
    SELECT sum(COALESCE(sp.value, sp.amount_cents / 100.0)) AS receita
    FROM student_payments sp
    JOIN profiles s ON s.id = sp.student_id
    WHERE sp.status IN ('RECEIVED','CONFIRMED','PAID','RECEIVED_IN_CASH')
      AND to_char(COALESCE(sp.paid_at::date, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
      AND (v_caller_role = 'SUPER_ADMIN' OR s.tenant_id = v_tenant)
  )
  SELECT jsonb_build_object(
    'aulas', COALESCE((SELECT sum(aulas) FROM custo),0),
    'custo', round(COALESCE((SELECT sum(custo) FROM custo),0),2),
    'receita', round(COALESCE((SELECT receita FROM receita),0),2),
    'margem', round(COALESCE((SELECT receita FROM receita),0) - COALESCE((SELECT sum(custo) FROM custo),0),2)
  ) INTO v_total;

  RETURN jsonb_build_object('month', v_month, 'rows', COALESCE(v_rows,'[]'::jsonb), 'total', v_total);
END;
$function$;

COMMENT ON FUNCTION public.director_teacher_margin(text) IS
  'Custo x receita x margem do mês, quebrado por professor e aluno. Custo vem da MESMA view da folha (v_payable_class_logs) — não recalcula por fora, então bate com o que o professor vê.';

REVOKE ALL ON FUNCTION public.director_teacher_margin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.director_teacher_margin(text) TO authenticated;
