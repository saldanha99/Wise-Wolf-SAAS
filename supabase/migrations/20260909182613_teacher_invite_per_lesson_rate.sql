-- hourly_rate is the legacy storage name for the amount per 30-minute lesson.
-- Only contracts explicitly issued in PER_LESSON units opt into the agreed base;
-- historical teacher/tier policies remain unchanged.
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
   WHERE tenant_id = v_tenant AND min_students <= v_rank
   ORDER BY min_students DESC LIMIT 1;
  RETURN CASE WHEN v_per_lesson THEN greatest(v_base, coalesce(v_rate, v_base)) ELSE coalesce(v_rate, v_base) END;
END;
$function$;
