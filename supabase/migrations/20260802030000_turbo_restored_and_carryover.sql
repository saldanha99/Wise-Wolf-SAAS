-- Turbo de volta (com uma trava a mais) + aula lançada tarde não some mais.
--
-- Decisão da direção em 01/08/2026, depois de eu ter desligado o turbo por
-- interpretar "é 8 para todos" como tarifa única: o turbo EXISTE e volta, mas
-- só com (i) 10+ alunos na carteira, (ii) sem falta do professor e (iii) SEM
-- CONFLITO DE LANÇAMENTO — esta terceira é nova, não existia antes.
--
-- E maio/junho ficam congelados como estão (decisão da direção). O que muda é o
-- mecanismo daqui pra frente: aula lançada depois que o fechamento foi congelado
-- deixa de sumir e passa a ser absorvida pelo próximo fechamento aberto.

-- 1) Turbo: carteira pela agenda + assiduidade + sem conflito -------------------
CREATE OR REPLACE FUNCTION public.teacher_turbo_on(p_teacher uuid, p_date date DEFAULT CURRENT_DATE)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    -- (0) carteira mínima de 10 alunos ativos, contada pela AGENDA.
    --     Contar por profiles.professor_id (como era até 01/08/2026) nunca
    --     funcionou: o campo está vazio em 20 dos 39 alunos ativos.
    (SELECT count(*) FROM teacher_carteira(p_teacher)) >= 10
    -- (a) pelo menos 1 mês de casa
    AND EXISTS (
      SELECT 1 FROM class_logs cl WHERE cl.teacher_id = p_teacher
        AND cl.class_date <= p_date - INTERVAL '30 days'
    )
    -- (b) atividade na janela
    AND EXISTS (
      SELECT 1 FROM class_logs cl WHERE cl.teacher_id = p_teacher
        AND cl.class_date > p_date - INTERVAL '30 days' AND cl.class_date <= p_date
        AND cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
    )
    -- (c) nenhuma falta do professor lançada na janela
    AND NOT EXISTS (
      SELECT 1 FROM class_logs cl WHERE cl.teacher_id = p_teacher
        AND cl.class_date > p_date - INTERVAL '30 days' AND cl.class_date <= p_date
        AND cl.presence IN ('TEACHER_ABSENCE','Falta do Professor')
    )
    -- (d) NOVO (01/08/2026): nenhum CONFLITO DE LANÇAMENTO na janela.
    --     Conflito = aula retida pelo antifraude (payment_hold) ou divergência
    --     entre o que o professor lançou e o que o aluno confirmou. Vale tanto o
    --     conflito ainda aberto quanto o resolvido contra o professor — enquanto
    --     houver divergência em aberto, o turbo não paga.
    AND NOT EXISTS (
      SELECT 1 FROM class_logs cl WHERE cl.teacher_id = p_teacher
        AND cl.class_date > p_date - INTERVAL '30 days' AND cl.class_date <= p_date
        AND COALESCE(cl.payment_hold, false)
    )
    AND NOT EXISTS (
      SELECT 1 FROM attendance_confirmations ac
      WHERE ac.teacher_id = p_teacher
        AND ac.class_date > p_date - INTERVAL '30 days' AND ac.class_date <= p_date
        AND ac.status IN ('CONFLICT','RESOLVED_UNPAID')
    );
$function$;

COMMENT ON FUNCTION public.teacher_turbo_on(uuid, date) IS
  'Turbo ligado? Exige 10+ alunos na carteira (contada pela AGENDA), 1 mês de casa, atividade recente, zero falta do professor e ZERO conflito de lançamento nos últimos 30 dias.';

-- 2) Tarifa: base + faixa por antiguidade quando o turbo está ligado ------------
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

  IF NOT teacher_turbo_on(p_teacher, p_date) THEN RETURN v_base; END IF;

  -- Posição do aluno na carteira, por antiguidade de matrícula. Aluno fora da
  -- carteira (experimental, aluno que saiu) fica no base.
  SELECT c.rnk INTO v_rank FROM teacher_carteira(p_teacher) c WHERE c.student_id = p_student;
  IF v_rank IS NULL THEN RETURN v_base; END IF;

  SELECT rate INTO v_rate FROM teacher_pay_tiers
   WHERE tenant_id = v_tenant AND min_students <= v_rank
   ORDER BY min_students DESC LIMIT 1;
  RETURN COALESCE(v_rate, v_base);
END; $function$;

-- 3) Status do turbo para os painéis do professor -------------------------------
CREATE OR REPLACE FUNCTION public.teacher_turbo_status(p_teacher uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_last date; v_clean_since date; v_days int; v_students int; v_conflitos int;
BEGIN
  SELECT GREATEST(
    (SELECT max(class_date) FROM class_logs
      WHERE teacher_id = p_teacher AND presence IN ('TEACHER_ABSENCE','Falta do Professor')),
    (SELECT max(class_date) FROM attendance_confirmations
      WHERE teacher_id = p_teacher AND status IN ('CONFLICT','RESOLVED_UNPAID'))
  ) INTO v_last;
  v_clean_since := COALESCE(v_last + 1, (SELECT min(class_date) FROM class_logs WHERE teacher_id = p_teacher));
  v_days := GREATEST(0, current_date - COALESCE(v_clean_since, current_date));

  -- Carteira pela agenda — a mesma que o gate usa, para o card não mostrar um
  -- número diferente do que decide o pagamento.
  SELECT count(*) INTO v_students FROM teacher_carteira(p_teacher);

  SELECT count(*) INTO v_conflitos FROM class_logs cl
   WHERE cl.teacher_id = p_teacher AND COALESCE(cl.payment_hold, false)
     AND cl.class_date > current_date - INTERVAL '30 days';

  RETURN jsonb_build_object(
    'active', teacher_turbo_on(p_teacher, current_date),
    'last_absence', v_last,
    'clean_since', v_clean_since,
    'days_clean', v_days,
    'days_to_activate', CASE WHEN v_days >= 30 THEN 0 ELSE 30 - v_days END,
    'students_active', v_students,
    'students_required', 10,
    'students_missing', GREATEST(0, 10 - v_students),
    'conflicts_open', v_conflitos
  );
END; $function$;

-- 4) Projeção: potencial volta a considerar a faixa -----------------------------
CREATE OR REPLACE FUNCTION public.teacher_pay_projection(p_teacher uuid, p_month text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_month text; v_start date; v_end date; v_tenant text;
        v_logged_n int; v_logged numeric; v_pot_base numeric; v_pot_turbo numeric;
        v_active int; v_next int; v_next_rate numeric; v_base numeric;
BEGIN
  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  v_start := (v_month||'-01')::date;
  v_end   := (date_trunc('month', v_start) + INTERVAL '1 month - 1 day')::date;

  SELECT tenant_id INTO v_tenant FROM profiles WHERE id = p_teacher;
  SELECT rate INTO v_base FROM teacher_pay_tiers WHERE tenant_id = v_tenant AND min_students = 1;
  v_base := COALESCE(v_base, 0);

  SELECT count(*), COALESCE(sum(v.rate_efetivo),0) INTO v_logged_n, v_logged
  FROM v_payable_class_logs v
  WHERE v.teacher_id = p_teacher AND to_char(v.class_date,'YYYY-MM') = v_month;

  SELECT count(*) INTO v_active FROM teacher_carteira(p_teacher);

  WITH aulas_previstas AS (
    SELECT b.student_id
    FROM bookings b
    CROSS JOIN generate_series(v_start, v_end, '1 day') d
    WHERE b.teacher_id = p_teacher AND b.student_id IS NOT NULL
      AND COALESCE(b.status,'SCHEDULED') = 'SCHEDULED'
      AND dow_name_to_int(b.day_of_week) = EXTRACT(dow FROM d)::int
      AND (b.start_date IS NULL OR d >= b.start_date)
  )
  SELECT COALESCE(count(*),0) * v_base,
         COALESCE(sum(COALESCE(
           (SELECT t.rate FROM teacher_pay_tiers t
             WHERE t.tenant_id = v_tenant AND t.min_students <= c.rnk
             ORDER BY t.min_students DESC LIMIT 1), v_base)), 0)
    INTO v_pot_base, v_pot_turbo
  FROM aulas_previstas a
  LEFT JOIN teacher_carteira(p_teacher) c ON c.student_id = a.student_id;

  -- Sem os 10 alunos, o potencial "com turbo" é igual ao base: não prometer
  -- faixa que o professor não pode alcançar hoje.
  IF v_active < 10 THEN v_pot_turbo := v_pot_base; END IF;

  SELECT min_students, rate INTO v_next, v_next_rate FROM teacher_pay_tiers
   WHERE tenant_id = v_tenant AND min_students > v_active ORDER BY min_students ASC LIMIT 1;

  RETURN jsonb_build_object(
    'month', v_month, 'turbo', teacher_turbo_status(p_teacher),
    'lessons_logged', v_logged_n, 'amount_logged', round(v_logged,2),
    'amount_potential_base', round(v_pot_base,2), 'amount_potential_turbo', round(v_pot_turbo,2),
    'active_students', v_active, 'next_tier_at', v_next, 'next_tier_rate', v_next_rate,
    'students_to_next', CASE WHEN v_next IS NULL THEN NULL ELSE v_next - v_active END
  );
END; $function$;

-- 5) Aula lançada depois do fechamento congelado não some mais -----------------
-- run_monthly_teacher_closing só atualiza fechamento PENDENTE. Depois que o
-- diretor marca PAGO/UNDER_REVIEW, o que o professor lançar atrasado nunca mais
-- entrava e não virava saldo — foi assim que sumiram R$ 168 (mai) e R$ 32 (jun)
-- do Mateus e R$ 64 (mai) do Flávio. Agora cada aula nessa situação é registrada
-- e absorvida pelo próximo fechamento aberto, uma única vez.
CREATE TABLE IF NOT EXISTS public.closing_carryovers (
  class_log_id   uuid PRIMARY KEY REFERENCES class_logs(id) ON DELETE CASCADE,
  teacher_id     uuid NOT NULL,
  origin_month   text NOT NULL,   -- mês da aula (fechamento já congelado)
  absorbed_month text NOT NULL,   -- fechamento que pagou
  amount         numeric NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_carryovers_teacher_absorbed
  ON public.closing_carryovers (teacher_id, absorbed_month);

COMMENT ON TABLE public.closing_carryovers IS
  'Aulas lançadas depois que o fechamento do mês foi congelado. A PK em class_log_id garante que cada aula atrasada é paga UMA vez só.';

ALTER TABLE public.closing_carryovers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS carryover_read ON public.closing_carryovers;
CREATE POLICY carryover_read ON public.closing_carryovers FOR SELECT TO authenticated
  USING (
    teacher_id = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
                 AND p.role IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR'))
  );

-- Aulas de meses JÁ CONGELADOS que nunca foram pagas nem absorvidas.
CREATE OR REPLACE FUNCTION public.teacher_pending_carryover(p_teacher uuid)
RETURNS TABLE(class_log_id uuid, origin_month text, class_date date, amount numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT v.id, to_char(v.class_date,'YYYY-MM'), v.class_date, v.rate_efetivo
  FROM v_payable_class_logs v
  JOIN teacher_closings tc
    ON tc.teacher_id = v.teacher_id
   AND tc.month_year = to_char(v.class_date,'YYYY-MM')
  WHERE v.teacher_id = p_teacher
    AND tc.status <> 'PENDENTE'                 -- fechamento congelado
    AND v.created_at > tc.updated_at            -- lançada depois de congelar
    -- Corte: o mecanismo vale daqui pra frente. A direção decidiu manter maio e
    -- junho congelados como estão, então o passivo histórico (5 aulas, R$ 45,50
    -- em 01/08/2026) não é puxado retroativamente.
    AND v.created_at >= '2026-08-02'::date
    AND NOT EXISTS (SELECT 1 FROM closing_carryovers cc WHERE cc.class_log_id = v.id);
$function$;

CREATE OR REPLACE FUNCTION public.run_monthly_teacher_closing(p_month text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_month text; v_created int := 0; v_updated int := 0; v_carried int := 0; r record;
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
        OR EXISTS (SELECT 1 FROM teacher_pending_carryover(t.id))
      )
  LOOP
    DECLARE
      v_paid int; v_amount numeric; v_existing teacher_closings%ROWTYPE;
      v_carry_n int := 0; v_carry_amount numeric := 0; v_closing_id uuid;
    BEGIN
      SELECT count(*), round(COALESCE(sum(v.rate_efetivo),0), 2)
        INTO v_paid, v_amount
      FROM v_payable_class_logs v
       WHERE v.teacher_id = r.teacher_id AND to_char(v.class_date,'YYYY-MM') = v_month;

      -- Sobra de meses congelados entra neste fechamento (uma vez só).
      SELECT count(*), round(COALESCE(sum(amount),0),2)
        INTO v_carry_n, v_carry_amount
      FROM teacher_pending_carryover(r.teacher_id);

      SELECT * INTO v_existing FROM teacher_closings
       WHERE teacher_id=r.teacher_id AND month_year=v_month LIMIT 1;

      IF v_existing.id IS NOT NULL THEN
        IF v_existing.status = 'PENDENTE'
           AND (v_existing.total_lessons IS DISTINCT FROM v_paid + v_carry_n
             OR v_existing.total_amount IS DISTINCT FROM v_amount + v_carry_amount) THEN
          UPDATE teacher_closings SET
            total_lessons = v_paid + v_carry_n,
            total_amount  = v_amount + v_carry_amount,
            updated_at    = now(),
            teacher_confirmation_status = CASE WHEN teacher_confirmation_status='OK' THEN 'PENDENTE' ELSE teacher_confirmation_status END,
            teacher_confirmation_date   = CASE WHEN teacher_confirmation_status='OK' THEN NULL ELSE teacher_confirmation_date END
          WHERE id = v_existing.id;
          DELETE FROM automation_sent
           WHERE kind='MONTHLY_CLOSING' AND subject_id = r.teacher_id::text || ':' || v_month;
          v_updated := v_updated + 1;
          v_updated_ids := v_updated_ids || r.teacher_id;
          v_closing_id := v_existing.id;
        ELSE
          CONTINUE;
        END IF;
      ELSE
        INSERT INTO teacher_closings (teacher_id, tenant_id, month_year, total_lessons, total_amount, status,
          period_start, period_end, created_at)
        VALUES (r.teacher_id, r.tenant_id, v_month, v_paid + v_carry_n, v_amount + v_carry_amount, 'PENDENTE',
          (v_month||'-01')::date, (date_trunc('month',(v_month||'-01')::date) + interval '1 month - 1 day')::date, now())
        RETURNING id INTO v_closing_id;
        v_created := v_created + 1;
      END IF;

      -- Marca as sobras como absorvidas — a PK impede pagar duas vezes.
      IF v_carry_n > 0 AND v_closing_id IS NOT NULL THEN
        INSERT INTO closing_carryovers (class_log_id, teacher_id, origin_month, absorbed_month, amount)
        SELECT c.class_log_id, r.teacher_id, c.origin_month, v_month, c.amount
        FROM teacher_pending_carryover(r.teacher_id) c
        ON CONFLICT (class_log_id) DO NOTHING;
        v_carried := v_carried + v_carry_n;
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'month', v_month, 'created', v_created,
    'updated', v_updated, 'carried_over', v_carried, 'updated_teacher_ids', to_jsonb(v_updated_ids));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.teacher_pending_carryover(uuid) TO authenticated;
