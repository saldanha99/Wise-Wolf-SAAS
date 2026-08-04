-- Financeiro do professor — visão simplificada por aluno + edição pelo diretor.
--
-- Contexto (01/08/2026): a tela do professor listava UMA LINHA POR AULA. Com 128
-- aulas no mês o professor não conseguia conferir nada. A escola sempre conferiu
-- por ALUNO (tempo de aula, quantidade, valor base, valor total) — é o formato da
-- folha manual. Esta migration entrega os dados nesse formato e dá ao diretor o
-- botão de corrigir o valor de um aluno no mês inteiro (antes só dava para editar
-- aula por aula, via set_class_log_rate_override).
--
-- Também corrige a contagem da carteira do professor (cláusula 3.4 do contrato):
-- ela vinha de profiles.professor_id, que está vazio em 20 dos 39 alunos ativos,
-- então a remuneração progressiva NUNCA ativava. Passa a contar pela AGENDA
-- (bookings SCHEDULED), que o CLAUDE.md define como fonte de verdade de quem é
-- aluno real. A trava de 10+ alunos (regra de 04/07/2026) é mantida por decisão
-- do diretor — o texto do contrato foi alinhado a ela no mesmo commit.

-- 1) Duração da aula do aluno -------------------------------------------------
-- Não existia nenhum campo de duração no sistema (class_logs.start_time/end_time
-- nunca foram preenchidos: 0 de 553 registros). A grade de horários é de 30 min,
-- que vira o default.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS lesson_duration_minutes integer;

COMMENT ON COLUMN profiles.lesson_duration_minutes IS
  'Duração da aula do aluno em minutos (NULL = 30, a grade padrão da escola). Editável pelo diretor no Financeiro do professor.';

-- 2) Carteira do professor pela agenda ---------------------------------------
-- Aluno "da carteira" = tem agendamento vigente com o professor, está ativo e é
-- faturável (exclui os perfis-fantasma de treinamento/experimental).
CREATE OR REPLACE FUNCTION public.teacher_carteira(p_teacher uuid)
RETURNS TABLE(student_id uuid, rnk int)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT s.id,
         row_number() OVER (ORDER BY COALESCE(s.start_date, s.created_at::date),
                                     s.created_at, s.id)::int
  FROM profiles s
  WHERE s.role = 'STUDENT'
    AND s.lifecycle_status = 'active'
    AND is_billable_student(s.id)
    AND EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.teacher_id = p_teacher
        AND b.student_id = s.id
        AND COALESCE(b.status, 'SCHEDULED') = 'SCHEDULED'
    );
$function$;

COMMENT ON FUNCTION public.teacher_carteira(uuid) IS
  'Alunos da carteira do professor (agenda vigente + ativo + faturável), numerados por antiguidade de matrícula — a ordem que a cláusula 3.4 do contrato usa.';

-- 3) Turbo: mesma trava de 10, contagem pela agenda ---------------------------
CREATE OR REPLACE FUNCTION public.teacher_turbo_on(p_teacher uuid, p_date date DEFAULT CURRENT_DATE)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    -- (0) carteira mínima de 10 alunos (regra de 04/07/2026, mantida em 01/08/2026).
    --     ANTES contava por profiles.professor_id (vazio em metade da base) — nunca batia.
    (SELECT count(*) FROM teacher_carteira(p_teacher)) >= 10
    -- (a) completou pelo menos 1 mês de casa (contrato 3.4: "1 mês consecutivo")
    AND EXISTS (
      SELECT 1 FROM class_logs cl WHERE cl.teacher_id = p_teacher
        AND cl.class_date <= p_date - INTERVAL '30 days'
    )
    -- (b) teve atividade na janela (assiduidade a premiar)
    AND EXISTS (
      SELECT 1 FROM class_logs cl WHERE cl.teacher_id = p_teacher
        AND cl.class_date > p_date - INTERVAL '30 days' AND cl.class_date <= p_date
        AND cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
    )
    -- (c) nenhuma falta LANÇADA na janela (contrato 3.5)
    AND NOT EXISTS (
      SELECT 1 FROM class_logs cl WHERE cl.teacher_id = p_teacher
        AND cl.class_date > p_date - INTERVAL '30 days' AND cl.class_date <= p_date
        AND cl.presence IN ('TEACHER_ABSENCE','Falta do Professor')
    )
    -- (d) nenhuma falta COMPROVADA pelo antifraude na janela
    AND NOT EXISTS (
      SELECT 1 FROM attendance_confirmations ac
      WHERE ac.teacher_id = p_teacher
        AND ac.class_date > p_date - INTERVAL '30 days' AND ac.class_date <= p_date
        AND ac.status = 'RESOLVED_UNPAID'
    );
$function$;

-- 4) Tarifa por aluno: rank também sai da agenda ------------------------------
CREATE OR REPLACE FUNCTION public.teacher_student_rate(p_teacher uuid, p_student uuid, p_date date DEFAULT CURRENT_DATE)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_tenant text; v_flat numeric; v_base numeric; v_rank int; v_rate numeric;
BEGIN
  SELECT tenant_id, hourly_rate INTO v_tenant, v_flat FROM profiles WHERE id = p_teacher;
  SELECT rate INTO v_base FROM teacher_pay_tiers WHERE tenant_id = v_tenant AND min_students = 1;
  v_base := COALESCE(v_base, v_flat, 0);

  -- Turbo desligado na data → todo mundo no base.
  IF NOT teacher_turbo_on(p_teacher, p_date) THEN RETURN v_base; END IF;

  -- Posição do aluno na carteira (antiguidade). Aluno fora da carteira — aula
  -- experimental, aluno que saiu — fica no base.
  SELECT c.rnk INTO v_rank FROM teacher_carteira(p_teacher) c WHERE c.student_id = p_student;
  IF v_rank IS NULL THEN RETURN v_base; END IF;

  SELECT rate INTO v_rate FROM teacher_pay_tiers
   WHERE tenant_id = v_tenant AND min_students <= v_rank
   ORDER BY min_students DESC LIMIT 1;
  RETURN COALESCE(v_rate, v_base);
END; $function$;

-- 5) Relatório por aluno: + student_id, duração e valor base -------------------
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
    SELECT cl.id, cl.student_id, cl.class_date, cl.presence, cl.subtype,
           COALESCE(cl.rate_override, teacher_student_rate(cl.teacher_id, cl.student_id, cl.class_date)) AS rate,
           (cl.rate_override IS NOT NULL) AS overridden,
           COALESCE(cl.subtype = 'AULA EXPERIMENTAL', false) AS experimental
    FROM class_logs cl
    WHERE cl.teacher_id = p_teacher_id
      AND to_char(cl.class_date,'YYYY-MM') = p_month
      AND cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
      AND cl.subtype IS DISTINCT FROM 'Teste Oral'
      AND COALESCE(cl.payment_hold,false) = false
      AND is_billable_student(cl.student_id)
  ), linhas AS (
    SELECT
      pg.student_id,
      max(COALESCE(sp.full_name, 'Aluno não cadastrado')) AS student_name,
      pg.experimental,
      count(*) AS aulas,
      sum(pg.rate) AS valor,
      -- Valor base = tarifa unitária do aluno no mês. Sempre valor_total / qtd_aulas,
      -- para a conta fechar na tela. Pode dar quebrado quando a tarifa variou dentro
      -- do mês (progressiva ligando pela assiduidade, ou ajuste manual em parte das
      -- aulas) — nesse caso qtd_tarifas > 1 e a tela mostra que é média.
      round(sum(pg.rate) / NULLIF(count(*),0), 2) AS valor_base,
      count(distinct pg.rate)::int AS qtd_tarifas,
      max(COALESCE(sp.lesson_duration_minutes, 30)) AS duracao_min,
      bool_or(pg.overridden) AS tem_ajuste,
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
      'detalhe', l.detalhe
    ) ORDER BY l.experimental, trim(l.student_name))
  INTO v_students FROM linhas l;

  SELECT jsonb_build_object(
      'total_alunos', count(distinct cl.student_id) FILTER (WHERE cl.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL' AND cl.student_id IS NOT NULL),
      'aulas_regulares', count(*) FILTER (WHERE cl.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL'),
      'aulas_experimentais', count(*) FILTER (WHERE cl.subtype = 'AULA EXPERIMENTAL'),
      'total_aulas', count(*),
      'valor_total', COALESCE(sum(COALESCE(cl.rate_override, teacher_student_rate(cl.teacher_id, cl.student_id, cl.class_date))),0))
  INTO v_resumo
  FROM class_logs cl
  WHERE cl.teacher_id = p_teacher_id
    AND to_char(cl.class_date,'YYYY-MM') = p_month
    AND cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
    AND cl.subtype IS DISTINCT FROM 'Teste Oral'
    AND COALESCE(cl.payment_hold,false) = false
    AND is_billable_student(cl.student_id);

  SELECT jsonb_build_object(
      'falta_professor', count(*) FILTER (WHERE cl.presence IN ('TEACHER_ABSENCE','Falta do Professor')),
      'em_conflito', count(*) FILTER (WHERE COALESCE(cl.payment_hold,false)),
      'teste_oral', count(*) FILTER (WHERE cl.subtype = 'Teste Oral'),
      'nao_faturavel', count(*) FILTER (WHERE NOT is_billable_student(cl.student_id) AND cl.student_id IS NOT NULL))
  INTO v_excluidas
  FROM class_logs cl
  WHERE cl.teacher_id = p_teacher_id AND to_char(cl.class_date,'YYYY-MM') = p_month;

  RETURN jsonb_build_object(
    'teacher', v_teacher,
    'month', p_month,
    'closing', v_closing,
    'students', COALESCE(v_students, '[]'::jsonb),
    'resumo', v_resumo,
    'excluidas', v_excluidas
  );
END;
$function$;

-- 6) Edição do diretor: valor base e duração de UM aluno no mês ---------------
CREATE OR REPLACE FUNCTION public.set_student_month_pay(
  p_teacher_id uuid,
  p_student_id uuid,
  p_month text,
  p_rate numeric DEFAULT NULL,
  p_duration_minutes integer DEFAULT NULL,
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
  -- Só diretor/coordenador do próprio tenant (ou super admin).
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    SELECT role, tenant_id INTO v_caller_role, v_caller_tenant FROM profiles WHERE id = auth.uid();
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RAISE EXCEPTION 'Apenas a direção pode alterar valores de pagamento';
    END IF;
  END IF;

  SELECT tenant_id INTO v_teacher_tenant FROM profiles WHERE id = p_teacher_id;
  IF v_teacher_tenant IS NULL THEN
    RAISE EXCEPTION 'Professor não encontrado';
  END IF;
  IF v_caller_role IN ('SCHOOL_ADMIN','COORDINATOR') AND v_caller_tenant IS DISTINCT FROM v_teacher_tenant THEN
    RAISE EXCEPTION 'Sem permissão para alterar pagamento de professor de outra escola';
  END IF;

  IF p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Mês inválido (use YYYY-MM)';
  END IF;
  IF p_rate IS NOT NULL AND p_rate < 0 THEN
    RAISE EXCEPTION 'O valor não pode ser negativo';
  END IF;
  IF p_duration_minutes IS NOT NULL AND (p_duration_minutes <= 0 OR p_duration_minutes > 600) THEN
    RAISE EXCEPTION 'Duração inválida (informe entre 1 e 600 minutos)';
  END IF;

  -- Valor base do aluno no mês: aplica em todas as aulas pagáveis daquele aluno
  -- com aquele professor. p_clear_rate volta ao cálculo automático (tier).
  IF p_clear_rate OR p_rate IS NOT NULL THEN
    UPDATE class_logs cl
       SET rate_override = CASE WHEN p_clear_rate THEN NULL ELSE p_rate END
     WHERE cl.teacher_id = p_teacher_id
       AND cl.student_id IS NOT DISTINCT FROM p_student_id
       AND to_char(cl.class_date,'YYYY-MM') = p_month
       AND cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
       AND cl.subtype IS DISTINCT FROM 'Teste Oral'
       AND COALESCE(cl.payment_hold,false) = false;
    GET DIAGNOSTICS v_afetadas = ROW_COUNT;
  END IF;

  -- Duração fica no perfil do aluno (vale para os meses seguintes também).
  IF p_duration_minutes IS NOT NULL AND p_student_id IS NOT NULL THEN
    UPDATE profiles SET lesson_duration_minutes = p_duration_minutes WHERE id = p_student_id;
  END IF;

  -- Mantém o fechamento PENDENTE em dia (congela PAGO/UNDER_REVIEW/PAID_WAITING_NF).
  UPDATE teacher_closings tc SET
    total_lessons = sub.paid,
    total_amount  = sub.amount,
    updated_at    = now(),
    teacher_confirmation_status = CASE WHEN tc.teacher_confirmation_status = 'OK' THEN 'PENDENTE' ELSE tc.teacher_confirmation_status END,
    teacher_confirmation_date   = CASE WHEN tc.teacher_confirmation_status = 'OK' THEN NULL ELSE tc.teacher_confirmation_date END
  FROM (
    SELECT count(*) AS paid,
      round(COALESCE(sum(COALESCE(cl.rate_override, teacher_student_rate(cl.teacher_id, cl.student_id, cl.class_date))),0), 2) AS amount
    FROM class_logs cl
    WHERE cl.teacher_id = p_teacher_id AND to_char(cl.class_date,'YYYY-MM') = p_month
      AND cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
      AND cl.subtype IS DISTINCT FROM 'Teste Oral'
      AND COALESCE(cl.payment_hold,false) = false
      AND is_billable_student(cl.student_id)
  ) sub
  WHERE tc.teacher_id = p_teacher_id AND tc.month_year = p_month AND tc.status = 'PENDENTE';

  RETURN jsonb_build_object('ok', true, 'aulas_ajustadas', v_afetadas,
    'teacher_id', p_teacher_id, 'student_id', p_student_id, 'month', p_month);
END;
$function$;

COMMENT ON FUNCTION public.set_student_month_pay(uuid, uuid, text, numeric, integer, boolean) IS
  'Diretor ajusta o valor base e/ou a duração da aula de UM aluno no mês inteiro. Substitui a edição aula-a-aula (set_class_log_rate_override), que continua existindo para casos pontuais.';

REVOKE ALL ON FUNCTION public.set_student_month_pay(uuid, uuid, text, numeric, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_student_month_pay(uuid, uuid, text, numeric, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.teacher_carteira(uuid) TO authenticated;
