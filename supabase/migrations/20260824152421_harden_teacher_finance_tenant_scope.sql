-- Enforce the active tenant boundary on legacy teacher-finance RPCs without
-- duplicating their calculation bodies. The original implementations remain
-- private implementation details and are no longer executable by API roles.

DO $guard$
BEGIN
  IF to_regclass('public.profiles') IS NULL
    OR to_regclass('public.tenant_memberships') IS NULL
    OR to_regprocedure('private.active_tenant_id(uuid)') IS NULL
    OR to_regprocedure('private.active_tenant_role(uuid)') IS NULL
    OR to_regprocedure('private.tenant_is_operational(text)') IS NULL
  THEN
    RAISE EXCEPTION 'tenant_membership_foundation_is_required';
  END IF;

  IF to_regprocedure('public.teacher_pay_projection(uuid,text)') IS NULL
    AND to_regprocedure('public.teacher_pay_projection_unchecked(uuid,text)') IS NULL
  THEN
    RAISE EXCEPTION 'teacher_pay_projection_is_required';
  END IF;

  IF to_regprocedure('public.get_teacher_closing_report(uuid,text)') IS NULL
    AND to_regprocedure('public.get_teacher_closing_report_unchecked(uuid,text)') IS NULL
  THEN
    RAISE EXCEPTION 'get_teacher_closing_report_is_required';
  END IF;

  IF to_regprocedure('public.create_teacher_transfer(uuid,uuid,jsonb,date,text)') IS NULL
    AND to_regprocedure('public.create_teacher_transfer_unchecked(uuid,uuid,jsonb,date,text)') IS NULL
  THEN
    RAISE EXCEPTION 'create_teacher_transfer_is_required';
  END IF;

  IF to_regprocedure('public.teacher_closing_adjustments(uuid,text)') IS NULL
    AND to_regprocedure('public.teacher_closing_adjustments_unchecked(uuid,text)') IS NULL
  THEN
    RAISE EXCEPTION 'teacher_closing_adjustments_is_required';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION private.can_access_teacher_projection(
  p_teacher_id uuid,
  p_month text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  actor_tenant_id text;
  target_tenant_id text;
  target_membership_count integer;
  normalized_month text := coalesce(p_month, to_char(current_date, 'YYYY-MM'));
BEGIN
  IF normalized_month !~ '^\d{4}-\d{2}$' THEN
    RETURN false;
  END IF;

  SELECT count(*), min(membership.tenant_id)
  INTO target_membership_count, target_tenant_id
  FROM public.tenant_memberships AS membership
  WHERE membership.user_id = p_teacher_id
    AND membership.role = 'TEACHER'
    AND membership.status = 'ACTIVE';

  IF target_membership_count <> 1
    OR target_tenant_id IS NULL
    OR NOT private.tenant_is_operational(target_tenant_id)
    OR NOT EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.id = p_teacher_id
        AND profile.role = 'TEACHER'
        AND profile.tenant_id = target_tenant_id
        AND lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
    )
  THEN
    RETURN false;
  END IF;

  -- The legacy calculation aggregates by teacher_id. Until the finance domain
  -- receives tenant_id as a first-class argument, fail closed whenever this
  -- identity has operational history in more than one tenant.
  IF EXISTS (
    SELECT 1 FROM public.bookings AS booking
    WHERE booking.teacher_id = p_teacher_id
      AND booking.tenant_id IS DISTINCT FROM target_tenant_id
  ) OR EXISTS (
    SELECT 1 FROM public.class_logs AS class_log
    WHERE class_log.teacher_id = p_teacher_id
      AND class_log.tenant_id IS DISTINCT FROM target_tenant_id
  ) OR EXISTS (
    SELECT 1 FROM public.attendance_confirmations AS confirmation
    WHERE confirmation.teacher_id = p_teacher_id
      AND confirmation.tenant_id IS DISTINCT FROM target_tenant_id
  ) OR EXISTS (
    SELECT 1 FROM public.teacher_closings AS closing
    WHERE closing.teacher_id = p_teacher_id
      AND closing.tenant_id IS DISTINCT FROM target_tenant_id
  ) OR EXISTS (
    SELECT 1 FROM public.closing_adjustments AS adjustment
    WHERE adjustment.teacher_id = p_teacher_id
      AND adjustment.tenant_id IS DISTINCT FROM target_tenant_id
  ) OR EXISTS (
    SELECT 1
    FROM public.bookings AS booking
    JOIN public.profiles AS student ON student.id = booking.student_id
    WHERE booking.teacher_id = p_teacher_id
      AND student.tenant_id IS DISTINCT FROM target_tenant_id
  ) OR EXISTS (
    SELECT 1
    FROM public.class_logs AS class_log
    JOIN public.profiles AS student ON student.id = class_log.student_id
    WHERE class_log.teacher_id = p_teacher_id
      AND student.tenant_id IS DISTINCT FROM target_tenant_id
  ) THEN
    RETURN false;
  END IF;

  IF coalesce(auth.role(), '') = 'service_role' THEN
    RETURN true;
  END IF;

  IF actor_id IS NULL OR coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN false;
  END IF;

  actor_role := private.active_tenant_role(actor_id);
  actor_tenant_id := private.active_tenant_id(actor_id);

  IF actor_tenant_id IS DISTINCT FROM target_tenant_id THEN
    RETURN false;
  END IF;

  RETURN (actor_id = p_teacher_id AND actor_role = 'TEACHER')
    OR actor_role IN ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN');
END;
$function$;

REVOKE ALL ON FUNCTION private.can_access_teacher_projection(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.can_access_teacher_projection(uuid, text)
  TO postgres, supabase_admin;

CREATE OR REPLACE FUNCTION private.can_access_teacher_closing(
  p_teacher_id uuid,
  p_month text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  actor_tenant_id text;
BEGIN
  IF p_month !~ '^\d{4}-\d{2}$'
    OR actor_id IS NULL
    OR coalesce(auth.role(), '') <> 'authenticated'
  THEN
    RETURN false;
  END IF;

  actor_role := private.active_tenant_role(actor_id);
  actor_tenant_id := private.active_tenant_id(actor_id);

  IF actor_tenant_id IS NULL
    OR NOT private.tenant_is_operational(actor_tenant_id)
    OR NOT EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.id = p_teacher_id
        AND profile.role = 'TEACHER'
    )
  THEN
    RETURN false;
  END IF;

  IF actor_id = p_teacher_id THEN
    IF actor_role <> 'TEACHER'
      OR NOT EXISTS (
        SELECT 1
        FROM public.tenant_memberships AS membership
        WHERE membership.user_id = actor_id
          AND membership.tenant_id = actor_tenant_id
          AND membership.role = 'TEACHER'
          AND membership.status = 'ACTIVE'
      )
    THEN
      RETURN false;
    END IF;
  ELSIF actor_role NOT IN ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
    OR NOT EXISTS (
      SELECT 1
      FROM public.tenant_memberships AS membership
      WHERE membership.user_id = p_teacher_id
        AND membership.tenant_id = actor_tenant_id
        AND membership.role = 'TEACHER'
    )
  THEN
    RETURN false;
  END IF;

  -- The legacy report has no tenant argument. Month-scoped ambiguity is denied
  -- before its implementation is allowed to run.
  IF EXISTS (
    SELECT 1 FROM public.class_logs AS class_log
    WHERE class_log.teacher_id = p_teacher_id
      AND to_char(class_log.class_date, 'YYYY-MM') = p_month
      AND class_log.tenant_id IS DISTINCT FROM actor_tenant_id
  ) OR EXISTS (
    SELECT 1 FROM public.teacher_closings AS closing
    WHERE closing.teacher_id = p_teacher_id
      AND closing.month_year = p_month
      AND closing.tenant_id IS DISTINCT FROM actor_tenant_id
  ) OR EXISTS (
    SELECT 1 FROM public.closing_adjustments AS adjustment
    WHERE adjustment.teacher_id = p_teacher_id
      AND adjustment.month_year = p_month
      AND adjustment.tenant_id IS DISTINCT FROM actor_tenant_id
  ) OR EXISTS (
    SELECT 1
    FROM public.class_logs AS class_log
    JOIN public.profiles AS student ON student.id = class_log.student_id
    WHERE class_log.teacher_id = p_teacher_id
      AND to_char(class_log.class_date, 'YYYY-MM') = p_month
      AND student.tenant_id IS DISTINCT FROM actor_tenant_id
  ) OR EXISTS (
    SELECT 1
    FROM public.class_logs AS class_log
    JOIN public.appointments AS appointment
      ON appointment.id::text = class_log.appointment_id
    WHERE class_log.teacher_id = p_teacher_id
      AND to_char(class_log.class_date, 'YYYY-MM') = p_month
      AND appointment.tenant_id IS DISTINCT FROM actor_tenant_id
  ) THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION private.can_access_teacher_closing(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.can_access_teacher_closing(uuid, text)
  TO postgres, supabase_admin;

CREATE OR REPLACE FUNCTION private.can_create_teacher_transfer(
  p_student_id uuid,
  p_to_teacher_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  actor_tenant_id text;
  student_tenant_id text;
  teacher_tenant_id text;
BEGIN
  SELECT profile.tenant_id
  INTO student_tenant_id
  FROM public.profiles AS profile
  JOIN public.tenant_memberships AS membership
    ON membership.user_id = profile.id
   AND membership.tenant_id = profile.tenant_id
   AND membership.role = 'STUDENT'
   AND membership.status = 'ACTIVE'
  WHERE profile.id = p_student_id
    AND profile.role = 'STUDENT'
    AND lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
  LIMIT 1;

  SELECT profile.tenant_id
  INTO teacher_tenant_id
  FROM public.profiles AS profile
  JOIN public.tenant_memberships AS membership
    ON membership.user_id = profile.id
   AND membership.tenant_id = profile.tenant_id
   AND membership.role = 'TEACHER'
   AND membership.status = 'ACTIVE'
  WHERE profile.id = p_to_teacher_id
    AND profile.role = 'TEACHER'
    AND lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
  LIMIT 1;

  IF student_tenant_id IS NULL
    OR teacher_tenant_id IS NULL
    OR student_tenant_id IS DISTINCT FROM teacher_tenant_id
    OR NOT private.tenant_is_operational(student_tenant_id)
  THEN
    RETURN false;
  END IF;

  IF actor_id IS NULL OR coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN false;
  END IF;

  actor_role := private.active_tenant_role(actor_id);
  actor_tenant_id := private.active_tenant_id(actor_id);

  RETURN actor_tenant_id = student_tenant_id
    AND actor_role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN');
END;
$function$;

REVOKE ALL ON FUNCTION private.can_create_teacher_transfer(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.can_create_teacher_transfer(uuid, uuid)
  TO postgres, supabase_admin;

DO $rename_legacy_functions$
BEGIN
  IF to_regprocedure('public.teacher_pay_projection_unchecked(uuid,text)') IS NULL THEN
    ALTER FUNCTION public.teacher_pay_projection(uuid, text)
      RENAME TO teacher_pay_projection_unchecked;
  END IF;

  IF to_regprocedure('public.get_teacher_closing_report_unchecked(uuid,text)') IS NULL THEN
    ALTER FUNCTION public.get_teacher_closing_report(uuid, text)
      RENAME TO get_teacher_closing_report_unchecked;
  END IF;

  IF to_regprocedure('public.create_teacher_transfer_unchecked(uuid,uuid,jsonb,date,text)') IS NULL THEN
    ALTER FUNCTION public.create_teacher_transfer(uuid, uuid, jsonb, date, text)
      RENAME TO create_teacher_transfer_unchecked;
  END IF;

  IF to_regprocedure('public.teacher_closing_adjustments_unchecked(uuid,text)') IS NULL THEN
    ALTER FUNCTION public.teacher_closing_adjustments(uuid, text)
      RENAME TO teacher_closing_adjustments_unchecked;
  END IF;
END
$rename_legacy_functions$;

REVOKE ALL ON FUNCTION public.teacher_pay_projection_unchecked(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_teacher_closing_report_unchecked(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_teacher_transfer_unchecked(uuid, uuid, jsonb, date, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.teacher_closing_adjustments_unchecked(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.teacher_pay_projection_unchecked(uuid, text)
  TO postgres, supabase_admin;
GRANT EXECUTE ON FUNCTION public.get_teacher_closing_report_unchecked(uuid, text)
  TO postgres, supabase_admin;
GRANT EXECUTE ON FUNCTION public.create_teacher_transfer_unchecked(uuid, uuid, jsonb, date, text)
  TO postgres, supabase_admin;
GRANT EXECUTE ON FUNCTION public.teacher_closing_adjustments_unchecked(uuid, text)
  TO postgres, supabase_admin;

CREATE OR REPLACE FUNCTION public.teacher_pay_projection(
  p_teacher uuid,
  p_month text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.can_access_teacher_projection(p_teacher, p_month) THEN
    RAISE EXCEPTION 'teacher_finance_access_denied' USING ERRCODE = '42501';
  END IF;

  RETURN public.teacher_pay_projection_unchecked(p_teacher, p_month);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_teacher_closing_report(
  p_teacher_id uuid,
  p_month text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.can_access_teacher_closing(p_teacher_id, p_month) THEN
    RAISE EXCEPTION 'teacher_finance_access_denied' USING ERRCODE = '42501';
  END IF;

  RETURN public.get_teacher_closing_report_unchecked(p_teacher_id, p_month);
END;
$function$;

CREATE OR REPLACE FUNCTION public.teacher_closing_adjustments(
  p_teacher_id uuid,
  p_month text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.can_access_teacher_closing(p_teacher_id, p_month) THEN
    RAISE EXCEPTION 'teacher_finance_access_denied' USING ERRCODE = '42501';
  END IF;

  RETURN public.teacher_closing_adjustments_unchecked(p_teacher_id, p_month);
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_teacher_transfer(
  p_student_id uuid,
  p_to_teacher uuid,
  p_slots jsonb,
  p_cutover date,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.can_create_teacher_transfer(p_student_id, p_to_teacher) THEN
    RAISE EXCEPTION 'teacher_transfer_tenant_mismatch' USING ERRCODE = '42501';
  END IF;

  IF p_cutover IS NULL
    OR p_cutover < current_date
    OR jsonb_typeof(p_slots) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_slots) < 1
    OR jsonb_array_length(p_slots) > 14
    OR length(coalesce(p_reason, '')) > 1000
  THEN
    RAISE EXCEPTION 'invalid_teacher_transfer_payload' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_slots) AS slot
    WHERE jsonb_typeof(slot) IS DISTINCT FROM 'object'
      OR slot->>'day_of_week' NOT IN (
        'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'
      )
      OR coalesce(slot->>'time_slot', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_slots) AS slot
    GROUP BY slot->>'day_of_week', slot->>'time_slot'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'invalid_teacher_transfer_slots' USING ERRCODE = '22023';
  END IF;

  RETURN public.create_teacher_transfer_unchecked(
    p_student_id,
    p_to_teacher,
    p_slots,
    p_cutover,
    p_reason
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_teacher_transfer(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  transfer_row public.teacher_transfers%ROWTYPE;
  conflict_count integer;
  student_name text;
  student_phone text;
  target_teacher_name text;
  director_name text;
  director_phone text;
BEGIN
  SELECT transfer.*
  INTO transfer_row
  FROM public.teacher_transfers AS transfer
  WHERE transfer.id = p_id
  FOR UPDATE;

  IF transfer_row.id IS NULL
    OR transfer_row.status <> 'ACCEPTED'
    OR transfer_row.cutover_date > current_date
    OR NOT private.tenant_is_operational(transfer_row.tenant_id)
  THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      transfer_row.tenant_id || ':teacher-transfer:' || transfer_row.to_teacher_id::text,
      0
    )
  );

  IF jsonb_typeof(transfer_row.proposed_slots) IS DISTINCT FROM 'array'
    OR jsonb_array_length(transfer_row.proposed_slots) < 1
    OR jsonb_array_length(transfer_row.proposed_slots) > 14
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(transfer_row.proposed_slots) AS slot
      WHERE jsonb_typeof(slot) IS DISTINCT FROM 'object'
        OR slot->>'day_of_week' NOT IN (
          'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'
        )
        OR coalesce(slot->>'time_slot', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(transfer_row.proposed_slots) AS slot
      GROUP BY slot->>'day_of_week', slot->>'time_slot'
      HAVING count(*) > 1
    )
  THEN
    RAISE EXCEPTION 'invalid_teacher_transfer_slots' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS student
    JOIN public.tenant_memberships AS membership
      ON membership.user_id = student.id
     AND membership.tenant_id = student.tenant_id
     AND membership.role = 'STUDENT'
     AND membership.status = 'ACTIVE'
    WHERE student.id = transfer_row.student_id
      AND student.tenant_id = transfer_row.tenant_id
      AND student.role = 'STUDENT'
      AND lower(trim(coalesce(student.lifecycle_status, ''))) = 'active'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.profiles AS teacher
    JOIN public.tenant_memberships AS membership
      ON membership.user_id = teacher.id
     AND membership.tenant_id = teacher.tenant_id
     AND membership.role = 'TEACHER'
     AND membership.status = 'ACTIVE'
    WHERE teacher.id = transfer_row.to_teacher_id
      AND teacher.tenant_id = transfer_row.tenant_id
      AND teacher.role = 'TEACHER'
      AND lower(trim(coalesce(teacher.lifecycle_status, ''))) = 'active'
  ) OR (
    transfer_row.from_teacher_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles AS teacher
      WHERE teacher.id = transfer_row.from_teacher_id
        AND teacher.tenant_id = transfer_row.tenant_id
        AND teacher.role = 'TEACHER'
    )
  ) THEN
    RAISE EXCEPTION 'teacher_transfer_tenant_mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)
  INTO conflict_count
  FROM jsonb_array_elements(transfer_row.proposed_slots) AS slot
  JOIN public.bookings AS booking
    ON booking.tenant_id = transfer_row.tenant_id
   AND booking.teacher_id = transfer_row.to_teacher_id
   AND booking.day_of_week = slot->>'day_of_week'
   AND booking.time_slot = slot->>'time_slot'
   AND coalesce(booking.status, 'SCHEDULED') = 'SCHEDULED';

  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'teacher_transfer_schedule_conflict' USING ERRCODE = '23505';
  END IF;

  DELETE FROM public.bookings AS booking
  WHERE booking.tenant_id = transfer_row.tenant_id
    AND booking.student_id = transfer_row.student_id
    AND booking.teacher_id = transfer_row.from_teacher_id
    AND booking.day_of_week IS NOT NULL;

  INSERT INTO public.bookings (
    tenant_id,
    teacher_id,
    student_id,
    day_of_week,
    time_slot,
    start_date
  )
  SELECT
    transfer_row.tenant_id,
    transfer_row.to_teacher_id,
    transfer_row.student_id,
    slot->>'day_of_week',
    slot->>'time_slot',
    transfer_row.cutover_date
  FROM jsonb_array_elements(transfer_row.proposed_slots) AS slot;

  UPDATE public.profiles AS student
  SET professor_id = transfer_row.to_teacher_id
  WHERE student.id = transfer_row.student_id
    AND student.tenant_id = transfer_row.tenant_id
    AND student.professor_id IS NOT DISTINCT FROM transfer_row.from_teacher_id;

  UPDATE public.profiles AS student
  SET professor_id2 = transfer_row.to_teacher_id
  WHERE student.id = transfer_row.student_id
    AND student.tenant_id = transfer_row.tenant_id
    AND transfer_row.from_teacher_id IS NOT NULL
    AND student.professor_id2 = transfer_row.from_teacher_id;

  UPDATE public.teacher_transfers
  SET status = 'APPLIED', applied_at = now()
  WHERE id = transfer_row.id
    AND tenant_id = transfer_row.tenant_id
    AND status = 'ACCEPTED';

  SELECT student.full_name, student.phone
  INTO student_name, student_phone
  FROM public.profiles AS student
  WHERE student.id = transfer_row.student_id
    AND student.tenant_id = transfer_row.tenant_id;

  SELECT teacher.full_name
  INTO target_teacher_name
  FROM public.profiles AS teacher
  WHERE teacher.id = transfer_row.to_teacher_id
    AND teacher.tenant_id = transfer_row.tenant_id;

  PERFORM public._enqueue_school_whatsapp(
    transfer_row.tenant_id,
    student_phone,
    student_name,
    'Olá ' || coalesce(student_name, '') || '! Sua aula foi transferida para o(a) professor(a) '
      || coalesce(target_teacher_name, '') || ' a partir de '
      || to_char(transfer_row.cutover_date, 'DD/MM/YYYY')
      || '. Seus valores e acesso continuam os mesmos. 🐺'
  );

  SELECT profile.phone, profile.full_name
  INTO director_phone, director_name
  FROM public.profiles AS profile
  WHERE profile.tenant_id = transfer_row.tenant_id
    AND profile.role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
    AND lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
  ORDER BY profile.role DESC
  LIMIT 1;

  PERFORM public._enqueue_school_whatsapp(
    transfer_row.tenant_id,
    director_phone,
    director_name,
    'Transferência aplicada: ' || coalesce(student_name, '') || ' agora é aluno(a) de '
      || coalesce(target_teacher_name, '') || ' (início '
      || to_char(transfer_row.cutover_date, 'DD/MM/YYYY') || ').'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.teacher_pay_projection(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_teacher_closing_report(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.teacher_closing_adjustments(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_teacher_transfer(uuid, uuid, jsonb, date, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.teacher_pay_projection(uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_teacher_closing_report(uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.teacher_closing_adjustments(uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_teacher_transfer(uuid, uuid, jsonb, date, text)
  TO authenticated;

-- These functions are implementation details or scheduled jobs. Explicit ACLs
-- make clean installs converge with production instead of inheriting old grants.
REVOKE ALL ON FUNCTION public._enqueue_school_whatsapp(text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_teacher_transfer(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_due_teacher_transfers()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_monthly_teacher_closing(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_carteira(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_pending_carryover(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_student_rate(uuid, uuid, date)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lesson_pays_teacher(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_turbo_on(uuid, date)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_turbo_status(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public._enqueue_school_whatsapp(text, text, text, text)
  TO postgres, supabase_admin, service_role;
GRANT EXECUTE ON FUNCTION public.apply_teacher_transfer(uuid)
  TO postgres, supabase_admin, service_role;
GRANT EXECUTE ON FUNCTION public.apply_due_teacher_transfers()
  TO postgres, supabase_admin, service_role;
GRANT EXECUTE ON FUNCTION public.run_monthly_teacher_closing(text)
  TO postgres, supabase_admin, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_carteira(uuid)
  TO postgres, supabase_admin, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_pending_carryover(uuid)
  TO postgres, supabase_admin, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_student_rate(uuid, uuid, date)
  TO postgres, supabase_admin, service_role;
GRANT EXECUTE ON FUNCTION public.lesson_pays_teacher(uuid)
  TO postgres, supabase_admin, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_on(uuid, date)
  TO postgres, supabase_admin, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_status(uuid)
  TO postgres, supabase_admin, service_role;

REVOKE ALL ON FUNCTION public.get_teacher_overview(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_teachers_overview()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_cashflow(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_teacher_overview(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_teachers_overview()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cashflow(text)
  TO authenticated;

ALTER VIEW public.v_school_cashflow_summary SET (security_invoker = true);
ALTER VIEW public.v_student_receivables SET (security_invoker = true);
ALTER VIEW public.v_teacher_payables SET (security_invoker = true);

REVOKE ALL ON public.v_school_cashflow_summary
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_student_receivables
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_teacher_payables
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_school_cashflow_summary TO service_role;
GRANT SELECT ON public.v_student_receivables TO service_role;
GRANT SELECT ON public.v_teacher_payables TO service_role;

COMMENT ON FUNCTION public.teacher_pay_projection(uuid, text) IS
  'Tenant-aware facade for the legacy teacher pay projection calculation.';
COMMENT ON FUNCTION public.get_teacher_closing_report(uuid, text) IS
  'Tenant-aware facade for the legacy teacher closing report calculation.';
COMMENT ON FUNCTION public.teacher_closing_adjustments(uuid, text) IS
  'Tenant-aware facade for legacy teacher closing adjustments.';
COMMENT ON FUNCTION public.create_teacher_transfer(uuid, uuid, jsonb, date, text) IS
  'Creates a transfer only when student, target teacher and active admin context share the same tenant.';
COMMENT ON FUNCTION public.apply_teacher_transfer(uuid) IS
  'Internal transfer application with tenant, lifecycle, schedule and cutover revalidation under lock.';
