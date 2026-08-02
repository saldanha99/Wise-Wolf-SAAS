-- Tarifa ÚNICA de R$ 8,00 por aula + treinamento de professor a R$ 16,00.
--
-- Decisão da direção em 01/08/2026: "é 8 para todos". A remuneração progressiva
-- por antiguidade de aluno (o "turbo": R$ 9,50 do 5º aluno, R$ 10,50 do 10º) está
-- DESLIGADA. Ela nunca chegou a pagar ninguém — a contagem de carteira saía de
-- profiles.professor_id, vazio em 20 dos 39 alunos ativos, então o gate de 10
-- alunos nunca era atingido desde que os tiers foram criados em 16/06/2026.
--
-- Única exceção à tarifa única: o professor habilitado como treinador
-- (profiles.is_trainer) recebe R$ 16,00 por TREINAMENTO ministrado a outro
-- professor.
--
-- Precedência do valor da aula:
--   1. rate_override  (ajuste manual da direção, sempre vence)
--   2. R$ 16,00       (subtype TREINAMENTO dado por quem é is_trainer)
--   3. tarifa base    (teacher_pay_tiers min_students=1, hoje R$ 8,00)

-- 1) Tarifa base achatada ------------------------------------------------------
-- A função continua existindo (vários lugares chamam) mas não consulta mais
-- antiguidade nem turbo: devolve sempre a base do tenant.
CREATE OR REPLACE FUNCTION public.teacher_student_rate(p_teacher uuid, p_student uuid, p_date date DEFAULT CURRENT_DATE)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_tenant text; v_flat numeric; v_base numeric;
BEGIN
  SELECT tenant_id, hourly_rate INTO v_tenant, v_flat FROM profiles WHERE id = p_teacher;
  SELECT rate INTO v_base FROM teacher_pay_tiers WHERE tenant_id = v_tenant AND min_students = 1;
  -- Tarifa única (decisão 01/08/2026). Para reativar a progressiva, restaure a
  -- versão de 20260802000000 — teacher_carteira e teacher_turbo_on seguem no banco.
  RETURN COALESCE(v_base, v_flat, 0);
END; $function$;

COMMENT ON FUNCTION public.teacher_student_rate(uuid, uuid, date) IS
  'Tarifa base por aula do tenant (R$ 8,00 na Wise Wolf). Achatada em 01/08/2026 — não usa mais antiguidade de aluno nem turbo. O bônus de treinamento é aplicado em v_payable_class_logs, não aqui.';

-- 2) Turbo desligado na origem -------------------------------------------------
-- Mantida para não quebrar quem chama (TeacherTurboCard, TeacherNudges,
-- teacher_pay_projection), mas responde sempre false: nada de prometer ao
-- professor uma faixa que não existe mais.
CREATE OR REPLACE FUNCTION public.teacher_turbo_on(p_teacher uuid, p_date date DEFAULT CURRENT_DATE)
RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$ SELECT false; $function$;

COMMENT ON FUNCTION public.teacher_turbo_on(uuid, date) IS
  'Desativada em 01/08/2026 (tarifa única de R$ 8,00). Mantida como stub para os painéis que a consultam.';

-- teacher_turbo_status: passa a dizer explicitamente que o programa saiu, em vez
-- de mostrar "faltam N alunos" para uma faixa que não existe mais.
CREATE OR REPLACE FUNCTION public.teacher_turbo_status(p_teacher uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'active', false,
    'discontinued', true,
    'flat_rate', (SELECT rate FROM teacher_pay_tiers t
                   WHERE t.tenant_id = (SELECT tenant_id FROM profiles WHERE id = p_teacher)
                     AND t.min_students = 1)
  );
$function$;

-- 3) Aula pagável: R$ 16,00 no treinamento dado por treinador -------------------
CREATE OR REPLACE VIEW public.v_payable_class_logs AS
SELECT
  cl.*,
  COALESCE(
    cl.rate_override,
    CASE WHEN cl.subtype = 'TREINAMENTO' AND COALESCE(tp.is_trainer, false)
         THEN 16.00 END,
    teacher_student_rate(cl.teacher_id, cl.student_id, cl.class_date)
  ) AS rate_efetivo,
  -- Ordem das colunas importa: CREATE OR REPLACE VIEW só permite ACRESCENTAR no
  -- fim, nunca inserir no meio. treinamento_ministrado entra depois da coluna
  -- que já existia na versão anterior da view.
  (cl.subtype IN ('REPOSIÇÃO','REPOSIÇÃO_PROF') AND r.id IS NULL) AS reposicao_sem_origem,
  (cl.subtype = 'TREINAMENTO' AND COALESCE(tp.is_trainer, false)) AS treinamento_ministrado
FROM class_logs cl
LEFT JOIN reschedules r ON r.id::text = cl.reschedule_id
LEFT JOIN profiles tp ON tp.id = cl.teacher_id
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
  -- Treinamento: um lançamento por appointment (mesma trava da experimental,
  -- agora que o treinamento vale o dobro).
  AND (
    cl.subtype IS DISTINCT FROM 'TREINAMENTO'
    OR cl.appointment_id IS NULL
    OR cl.id = (
      SELECT c4.id FROM class_logs c4
      WHERE c4.subtype = 'TREINAMENTO'
        AND c4.appointment_id = cl.appointment_id
      ORDER BY c4.created_at, c4.id
      LIMIT 1
    )
  )
  -- Lançamento solto que espelha um lançamento da agenda no mesmo dia.
  AND NOT (
    cl.booking_id IS NULL
    AND cl.student_id IS NOT NULL
    AND cl.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL'
    AND cl.subtype IS DISTINCT FROM 'TREINAMENTO'
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
  'Fonte ÚNICA de "esta aula paga o professor" e de quanto paga. R$ 8,00 por aula; R$ 16,00 no TREINAMENTO ministrado por quem é is_trainer; rate_override da direção vence tudo. Consumida por get_teacher_closing_report, run_monthly_teacher_closing e director_teacher_margin.';

GRANT SELECT ON public.v_payable_class_logs TO authenticated, service_role;

-- 4) Projeção do professor sem a promessa do turbo ------------------------------
CREATE OR REPLACE FUNCTION public.teacher_pay_projection(p_teacher uuid, p_month text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_month text; v_start date; v_end date; v_rate numeric;
        v_logged_n int; v_logged numeric; v_pot numeric; v_active int;
BEGIN
  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  v_start := (v_month||'-01')::date;
  v_end   := (date_trunc('month', v_start) + INTERVAL '1 month - 1 day')::date;

  SELECT count(*), COALESCE(sum(v.rate_efetivo),0) INTO v_logged_n, v_logged
  FROM v_payable_class_logs v
  WHERE v.teacher_id = p_teacher AND to_char(v.class_date,'YYYY-MM') = v_month;

  v_rate := teacher_student_rate(p_teacher, NULL, current_date);

  -- Potencial = aulas que a agenda prevê no mês × tarifa única.
  SELECT COALESCE(count(*),0) * v_rate INTO v_pot
  FROM bookings b
  CROSS JOIN generate_series(v_start, v_end, '1 day') d
  WHERE b.teacher_id = p_teacher AND b.student_id IS NOT NULL
    AND COALESCE(b.status,'SCHEDULED') = 'SCHEDULED'
    AND dow_name_to_int(b.day_of_week) = EXTRACT(dow FROM d)::int
    AND (b.start_date IS NULL OR d >= b.start_date);

  SELECT count(*) INTO v_active FROM profiles
   WHERE role='STUDENT' AND lifecycle_status='active' AND (professor_id=p_teacher OR professor_id2=p_teacher);

  RETURN jsonb_build_object(
    'month', v_month,
    'turbo', teacher_turbo_status(p_teacher),
    'rate', v_rate,
    'lessons_logged', v_logged_n,
    'amount_logged', round(v_logged,2),
    'amount_potential_base', round(COALESCE(v_pot,0),2),
    'amount_potential_turbo', round(COALESCE(v_pot,0),2),
    'active_students', v_active,
    'next_tier_at', NULL, 'next_tier_rate', NULL, 'students_to_next', NULL
  );
END; $function$;
