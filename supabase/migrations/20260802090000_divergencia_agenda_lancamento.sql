-- Alerta de divergência entre a AGENDA e o LANÇAMENTO, no fechamento.
--
-- Foi o padrão que mais custou tempo no fechamento de julho/2026: o sistema
-- pagava exatamente o que foi lançado (regra correta), mas ninguém via o que
-- DEIXOU de ser lançado. O diretor só descobria conferindo aluno por aluno na
-- mão. Os casos do mês:
--   * 5 aulas do Mateus que ele não conseguiu lançar (problema na plataforma);
--   * 3 quartas do Arthur que a agenda nem tinha;
--   * 3 faltas justificadas do Flavio Ramyres, aluno com início cadastrado errado.
--
-- Agora a comparação é feita pelo banco: para cada professor, quantas aulas a
-- agenda previa no mês e quantas foram lançadas — com a lista das datas que
-- ficaram sem lançamento, para o diretor cobrar antes de aprovar a folha.
--
-- Aula prevista para aluno que ainda não começou (class_date < start_date) NÃO
-- entra: ela não deveria mesmo existir.

CREATE OR REPLACE FUNCTION public.closing_divergences(p_month text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text;
  v_start date; v_end date; v_rows jsonb;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  SELECT role, tenant_id INTO v_caller_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_jwt_role IN ('anon','authenticated') THEN
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RAISE EXCEPTION 'Apenas a direção pode ver divergências de fechamento';
    END IF;
  END IF;

  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  IF v_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Mês inválido (use YYYY-MM)'; END IF;
  v_start := (v_month||'-01')::date;
  v_end   := (date_trunc('month', v_start) + INTERVAL '1 month')::date;

  WITH previstas AS (
    SELECT b.teacher_id, b.student_id, d::date AS dia, b.time_slot,
           row_number() OVER (PARTITION BY b.teacher_id, b.student_id, d ORDER BY b.time_slot) AS rn
    FROM bookings b
    JOIN profiles t ON t.id = b.teacher_id
    CROSS JOIN generate_series(v_start, v_end - 1, '1 day') d
    WHERE COALESCE(b.status,'SCHEDULED') = 'SCHEDULED'
      AND b.student_id IS NOT NULL
      AND dow_name_to_int(b.day_of_week) = EXTRACT(dow FROM d)::int
      -- aluno que ainda não começou não gera pendência
      AND (b.start_date IS NULL OR d >= b.start_date)
      -- e nada no futuro: aula que ainda não aconteceu não está "faltando"
      AND d <= current_date
      -- perfis de teste/treinamento não geram pendência
      AND is_billable_student(b.student_id)
      AND (v_caller_role = 'SUPER_ADMIN' OR t.tenant_id = v_tenant)
  ), lancadas AS (
    -- Sem filtrar por professor: aula COBERTA por outro professor foi dada, não
    -- está faltando. Sem isso o João Pedro de 07/07 (transferido do Mateus para a
    -- Debora) aparecia como pendência do Mateus.
    SELECT cl.student_id, cl.class_date, count(*) AS n
    FROM class_logs cl
    WHERE cl.class_date >= v_start AND cl.class_date < v_end
    GROUP BY 1,2
  ), faltando AS (
    SELECT p.teacher_id, p.student_id, p.dia, p.time_slot
    FROM previstas p
    LEFT JOIN lancadas l ON l.student_id = p.student_id AND l.class_date = p.dia
    WHERE p.rn > COALESCE(l.n, 0)
  )
  SELECT jsonb_agg(x ORDER BY x->>'teacher_name', x->>'student_name')
    INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'teacher_id', f.teacher_id,
      'teacher_name', trim(t.full_name),
      'student_id', f.student_id,
      'student_name', trim(COALESCE(s.full_name,'Aluno não cadastrado')),
      'aulas_sem_lancamento', count(*),
      'valor_estimado', round(count(*) * COALESCE(
        (SELECT rate FROM teacher_pay_tiers tp WHERE tp.tenant_id = t.tenant_id AND tp.min_students = 1), 0), 2),
      'datas', jsonb_agg(to_char(f.dia,'DD/MM') ORDER BY f.dia)
    ) AS x
    FROM faltando f
    JOIN profiles t ON t.id = f.teacher_id
    LEFT JOIN profiles s ON s.id = f.student_id
    GROUP BY f.teacher_id, t.full_name, t.tenant_id, f.student_id, s.full_name
  ) z;

  RETURN jsonb_build_object('month', v_month, 'rows', COALESCE(v_rows,'[]'::jsonb));
END;
$function$;

COMMENT ON FUNCTION public.closing_divergences(text) IS
  'Aulas que a agenda previa no mês e que ninguém lançou, por professor e aluno. Não inclui aluno antes do start_date nem datas futuras. Serve para o diretor cobrar o lançamento ANTES de aprovar a folha, em vez de descobrir conferindo à mão.';

REVOKE ALL ON FUNCTION public.closing_divergences(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.closing_divergences(text) TO authenticated;
