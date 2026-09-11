-- Wise Wolf: seventh student onward, for lessons dated 2026-09-09 onward.
-- Existing absence/dispute/streak rules, function owners and grants are preserved.
-- Earlier lessons still use the tenth-student threshold; no closing is rewritten.
CREATE OR REPLACE FUNCTION public.teacher_turbo_refresh_eligibility(
  p_teacher uuid,
  p_effective_on date DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_state public.teacher_turbo_state%ROWTYPE;
  v_students integer;
  v_required integer;
  v_on date := COALESCE(p_effective_on, public.teacher_turbo_business_date());
BEGIN
  PERFORM public.teacher_turbo_ensure_state(p_teacher);

  SELECT * INTO v_state
  FROM public.teacher_turbo_state
  WHERE teacher_id = p_teacher
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_required := CASE WHEN v_state.tenant_id = 'school-wise-wolf' AND v_on >= DATE '2026-09-09' THEN 7 ELSE 10 END;

  SELECT public.teacher_turbo_student_count(p_teacher) INTO v_students;

  IF v_students >= v_required AND v_state.students_eligible_since IS NULL THEN
    UPDATE public.teacher_turbo_state
       SET students_active = v_students,
           students_eligible_since = v_on,
           updated_at = now()
     WHERE teacher_id = p_teacher;

    PERFORM public.teacher_turbo_add_event(
      p_teacher, v_state.tenant_id, 'STUDENT_THRESHOLD_REACHED', v_on,
      NULL, NULL, auth.uid(),
      jsonb_build_object('students_active', v_students, 'students_required', v_required)
    );
  ELSIF v_students < v_required AND v_state.students_eligible_since IS NOT NULL THEN
    UPDATE public.teacher_turbo_state
       SET students_active = v_students,
           students_eligible_since = NULL,
           updated_at = now()
     WHERE teacher_id = p_teacher;

    PERFORM public.teacher_turbo_add_event(
      p_teacher, v_state.tenant_id, 'STUDENT_THRESHOLD_LOST', v_on,
      NULL, NULL, auth.uid(),
      jsonb_build_object('students_active', v_students, 'students_required', v_required)
    );
  ELSE
    UPDATE public.teacher_turbo_state
       SET students_active = v_students,
           updated_at = now()
     WHERE teacher_id = p_teacher;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.teacher_turbo_status_at(p_teacher uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_state public.teacher_turbo_state%ROWTYPE;
  v_students integer := 0;
  v_required integer;
  v_anchor date;
  v_last_absence date;
  v_threshold_event text;
  v_eligible_since date;
  v_students_eligible boolean := false;
  v_days_clean integer := 0;
  v_days_to_activate integer := 30;
  v_active_since date;
  v_active boolean := false;
  v_active_days integer := 0;
  v_suspensions integer := 0;
  v_suspended_at timestamptz;
  v_absences_this_month integer := 0;
  v_absences_last_month integer := 0;
  v_blocked_by text;
BEGIN
  IF p_date IS NULL THEN
    RETURN jsonb_build_object('active', false, 'blocked_by', 'data_invalida');
  END IF;

  SELECT * INTO v_state
  FROM public.teacher_turbo_state
  WHERE teacher_id = p_teacher;

  IF NOT FOUND THEN
    SELECT p.id, p.tenant_id,
           LEAST(p_date, COALESCE(p.start_date, p.created_at::date, p_date)),
           LEAST(p_date, COALESCE(p.start_date, p.created_at::date, p_date)),
           0, NULL::date, NULL::date, now(), now()
      INTO v_state
    FROM public.profiles p
    WHERE p.id = p_teacher AND p.role = 'TEACHER';

    IF NOT FOUND THEN
      RETURN jsonb_build_object('active', false, 'blocked_by', 'professor_invalido');
    END IF;
  END IF;

  v_required := CASE WHEN v_state.tenant_id = 'school-wise-wolf' AND p_date >= DATE '2026-09-09' THEN 7 ELSE 10 END;

  SELECT public.teacher_turbo_student_count(p_teacher) INTO v_students;

  SELECT max(e.effective_on) INTO v_last_absence
  FROM public.teacher_turbo_events e
  WHERE e.teacher_id = p_teacher
    AND e.tenant_id = v_state.tenant_id
    AND e.event_type IN ('ABSENCE_RECORDED', 'ABSENCE_CONFIRMED')
    AND e.effective_on <= p_date;

  v_anchor := GREATEST(v_state.initial_anchor_on, COALESCE(v_last_absence, v_state.initial_anchor_on));
  v_days_clean := GREATEST(0, p_date - v_anchor);
  v_days_to_activate := GREATEST(0, 30 - v_days_clean);

  -- Para datas historicas, o ultimo evento de limiar e a fonte. Para hoje/futuro,
  -- a carteira atual e soberana e students_eligible_since marca o inicio do ciclo.
  IF p_date >= public.teacher_turbo_business_date() THEN
    v_students_eligible := v_students >= v_required;
    v_eligible_since := CASE WHEN v_students_eligible THEN v_state.students_eligible_since END;
  ELSE
    SELECT e.event_type, e.effective_on
      INTO v_threshold_event, v_eligible_since
    FROM public.teacher_turbo_events e
    WHERE e.teacher_id = p_teacher
      AND e.tenant_id = v_state.tenant_id
      AND e.event_type IN ('STUDENT_THRESHOLD_REACHED', 'STUDENT_THRESHOLD_LOST')
      AND e.effective_on <= p_date
    ORDER BY e.effective_on DESC, e.happened_at DESC, e.id DESC
    LIMIT 1;

    v_students_eligible := COALESCE(
      v_threshold_event = 'STUDENT_THRESHOLD_REACHED',
      false
    );
    IF v_students_eligible IS NOT TRUE THEN
      v_eligible_since := NULL;
    END IF;
  END IF;

  -- Defesa para professor criado entre a migration e o primeiro refresh.
  IF v_students_eligible AND v_eligible_since IS NULL THEN
    v_eligible_since := p_date;
  END IF;

  SELECT count(*)::integer, min(d.suspended_at)
    INTO v_suspensions, v_suspended_at
  FROM public.teacher_turbo_disputes d
  WHERE d.teacher_id = p_teacher
    AND d.tenant_id = v_state.tenant_id
    AND d.status = 'OPEN'
    AND (d.suspended_at AT TIME ZONE 'America/Sao_Paulo')::date <= p_date;

  IF v_students_eligible AND v_days_clean >= 30 THEN
    v_active_since := GREATEST(v_anchor + 30, v_eligible_since);
  END IF;

  IF v_eligible_since IS NOT NULL THEN
    v_days_to_activate := GREATEST(
      v_days_to_activate,
      GREATEST(0, v_eligible_since - p_date)
    );
  END IF;

  v_active := v_active_since IS NOT NULL
              AND v_active_since <= p_date
              AND v_suspensions = 0;
  -- Uma inocentacao recompõe o ciclo como se a suspensao temporaria nunca o
  -- tivesse interrompido; por isso o tempo ativo continua visivel no intervalo.
  IF v_active_since IS NOT NULL AND v_active_since <= p_date THEN
    v_active_days := GREATEST(0, p_date - v_active_since);
  END IF;

  SELECT count(DISTINCT e.effective_on)::integer INTO v_absences_this_month
  FROM public.teacher_turbo_events e
  WHERE e.teacher_id = p_teacher
    AND e.tenant_id = v_state.tenant_id
    AND e.event_type IN ('ABSENCE_RECORDED', 'ABSENCE_CONFIRMED')
    AND e.effective_on >= date_trunc('month', p_date)::date
    AND e.effective_on < (date_trunc('month', p_date) + interval '1 month')::date;

  SELECT count(DISTINCT e.effective_on)::integer INTO v_absences_last_month
  FROM public.teacher_turbo_events e
  WHERE e.teacher_id = p_teacher
    AND e.tenant_id = v_state.tenant_id
    AND e.event_type IN ('ABSENCE_RECORDED', 'ABSENCE_CONFIRMED')
    AND e.effective_on >= (date_trunc('month', p_date) - interval '1 month')::date
    AND e.effective_on < date_trunc('month', p_date)::date;

  v_blocked_by := CASE
    WHEN v_suspensions > 0 THEN 'conflito'
    WHEN v_students_eligible IS NOT TRUE THEN 'carteira'
    WHEN v_days_clean < 30 OR v_active_since > p_date THEN 'ofensiva'
    ELSE NULL
  END;

  RETURN jsonb_build_object(
    'active', v_active,
    'status', CASE
      WHEN v_suspensions > 0 THEN 'SUSPENDED'
      WHEN v_students_eligible IS NOT TRUE THEN 'INELIGIBLE_STUDENTS'
      WHEN v_days_clean < 30 OR v_active_since > p_date THEN 'BUILDING'
      ELSE 'ACTIVE'
    END,
    'scope', 'rolling_30_days',
    'students_active', v_students,
    'students_required', v_required,
    'students_missing', GREATEST(0, v_required - v_students),
    'students_eligible_since', v_eligible_since,
    'clean_since', v_anchor,
    'days_clean', v_days_clean,
    'days_to_activate', v_days_to_activate,
    'active_since', v_active_since,
    'active_days', v_active_days,
    'last_absence', v_last_absence,
    'last_confirmed_absence_on', v_last_absence,
    'suspensions_open', v_suspensions,
    'suspension_since', v_suspended_at,
    -- aliases mantidos para consumidores antigos
    'conflicts_open', v_suspensions,
    'absences_this_month', v_absences_this_month,
    'absences_last_month', v_absences_last_month,
    'blocked_by', v_blocked_by
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.teacher_student_rate(p_teacher uuid, p_student uuid, p_date date DEFAULT CURRENT_DATE)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_tenant text; v_flat numeric; v_base numeric; v_rank int; v_rate numeric; v_per_lesson boolean;
BEGIN
  SELECT tenant_id, hourly_rate INTO v_tenant, v_flat FROM profiles WHERE id = p_teacher;
  SELECT coalesce((SELECT commercial_snapshot ->> 'rateUnit' = 'PER_LESSON'
    FROM tenant_contract_records WHERE user_id = p_teacher AND tenant_id = v_tenant
      AND contract_kind = 'TEACHER' ORDER BY accepted_at DESC, created_at DESC LIMIT 1), false)
    INTO v_per_lesson;
  SELECT rate INTO v_base FROM teacher_pay_tiers WHERE tenant_id = v_tenant AND min_students = 1;
  v_base := CASE WHEN v_per_lesson THEN coalesce(v_flat, v_base, 0) ELSE coalesce(v_base, v_flat, 0) END;
  IF NOT teacher_turbo_on(p_teacher, p_date) THEN RETURN v_base; END IF;
  SELECT c.rnk INTO v_rank FROM teacher_carteira(p_teacher) c WHERE c.student_id = p_student;
  IF v_rank IS NULL THEN RETURN v_base; END IF;
  SELECT rate INTO v_rate FROM teacher_pay_tiers
   WHERE tenant_id = v_tenant AND (CASE WHEN v_tenant = 'school-wise-wolf' AND p_date < DATE '2026-09-09' AND min_students = 7 THEN 10 ELSE min_students END) <= v_rank
   ORDER BY min_students DESC LIMIT 1;
  RETURN CASE WHEN v_per_lesson THEN greatest(v_base, coalesce(v_rate, v_base)) ELSE coalesce(v_rate, v_base) END;
END;
$function$;

UPDATE public.teacher_pay_tiers SET min_students = 7
WHERE tenant_id = 'school-wise-wolf' AND min_students = 10;

-- Seed the new eligibility event for teachers with 7–9 students without
-- backdating eligibility or resetting their clean attendance streak.
DO $refresh$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM public.profiles
    WHERE tenant_id = 'school-wise-wolf' AND role = 'TEACHER'
      AND lifecycle_status = 'active'
  LOOP
    PERFORM public.teacher_turbo_refresh_eligibility(t.id, DATE '2026-09-09');
  END LOOP;
END;
$refresh$;
