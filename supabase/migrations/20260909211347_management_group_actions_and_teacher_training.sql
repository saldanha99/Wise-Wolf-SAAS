-- ⚠️ ARQUIVO DE ESTADO — NÃO REGISTRAR EM MIGRATION_RELATIVES (deploy/vps/release.sh).
--
-- Cópia fiel do SQL aplicado à mão na VPS em 09/09/2026 (trazida pelo sync de
-- 10/09). Serve para documentar o que o banco de produção tem; não foi escrito
-- para rodar de novo: tem `create table`/`create function` sem `if not exists`
-- nem `or replace`, e o release.sh re-executa a lista inteira a cada deploy.
-- Registrar este arquivo derruba o próximo release na segunda execução.
-- O equivalente re-executável, quando precisar, deve ser uma migration nova.
begin;
alter table public.dre_report_settings add column if not exists allow_group_member_actions boolean not null default false;
comment on column public.dre_report_settings.allow_group_member_actions is 'Owner opt-in: authenticated messages from participants of the configured management WhatsApp group can prepare and confirm management actions without a platform profile.';

create or replace function private.management_group_execution_authorized(
  p_tenant text, p_actor_id uuid, p_request_id text, p_expected jsonb, p_group_jid text default null
) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(auth.role(), '') = 'service_role' and exists (
    select 1 from public.gestao_acao_pendente p
    join public.dre_report_settings c on c.tenant_id = p.tenant_id and c.destino = p.group_jid
    where c.is_active and c.allow_group_member_actions
      and p.tenant_id = p_tenant and p.request_id = p_request_id
      and (p_group_jid is null or p.group_jid = p_group_jid)
      and p.status = 'executing' and p.schema_version = 1
      and p.requested_by_user_id is not distinct from p_actor_id
      and p.confirmed_by_user_id is not distinct from p_actor_id
      and p.requested_by_jid ~ '^[0-9]{6,20}@(lid|s\.whatsapp\.net)$'
      and p.confirmed_by_jid = p.requested_by_jid
      and p.confirmed_at <= p.expires_at
      and p.updated_at > now() - interval '2 minutes'
      and p.acao @> p_expected
  );
$$;
revoke all on function private.management_group_execution_authorized(text,uuid,text,jsonb,text) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION public.gestao_lanca_ajuste_idempotente(p_tenant text, p_request_id text, p_actor_id uuid, p_teacher_id uuid, p_month text, p_descricao text, p_valor numeric, p_pedido_por text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_existing public.closing_adjustments%ROWTYPE;
  v_id uuid;
  v_sync boolean := false;
  v_refresh jsonb;
  v_actor_role text;
  v_actor_profile_role text;
  v_teto numeric := 500;
  v_request_id text := left(btrim(coalesce(p_request_id, '')), 200);
  v_closing_status text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_tenant IS NULL OR p_teacher_id IS NULL
     OR length(v_request_id) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'parametros_invalidos');
  END IF;

  SELECT membership.role, actor.role
    INTO v_actor_role, v_actor_profile_role
    FROM public.tenant_memberships AS membership
    JOIN public.profiles AS actor ON actor.id = membership.user_id
   WHERE membership.user_id = p_actor_id
     AND membership.tenant_id = p_tenant
     AND membership.status = 'ACTIVE'
     AND membership.role IN ('SCHOOL_ADMIN', 'COORDINATOR')
     AND lower(coalesce(actor.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
   LIMIT 1;
  IF (v_actor_role IS NULL OR NOT (
    v_actor_role = 'SCHOOL_ADMIN' OR v_actor_profile_role = 'SUPER_ADMIN'
  )) AND NOT private.management_group_execution_authorized(p_tenant, p_actor_id, v_request_id,
    jsonb_build_object('tipo','ajuste_repasse','teacher_id',p_teacher_id,'mes',p_month,'valor',p_valor,'motivo',p_descricao)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'actor_not_allowed';
  END IF;

  IF p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mes_invalido');
  END IF;
  IF p_valor IS NULL OR p_valor = 0 OR p_valor = 'NaN'::numeric THEN
    RETURN jsonb_build_object('ok', false, 'error', 'valor_invalido');
  END IF;
  IF abs(p_valor) > v_teto THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'acima_do_teto', 'teto', v_teto
    );
  END IF;
  IF length(btrim(coalesce(p_descricao, ''))) NOT BETWEEN 3 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'motivo_invalido');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles AS teacher
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = teacher.id
       AND membership.tenant_id = p_tenant
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     WHERE teacher.id = p_teacher_id
       AND teacher.role = 'TEACHER'
       AND lower(coalesce(teacher.lifecycle_status, '')) = 'active'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'professor_invalido');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'management-adjustment:' || p_tenant || ':' || v_request_id,
      0
    )
  );
  PERFORM private.lock_teacher_closing_pair(
    p_tenant,
    p_month,
    p_teacher_id,
    NULL
  );
  SELECT adjustment.*
    INTO v_existing
    FROM public.closing_adjustments AS adjustment
   WHERE adjustment.tenant_id = p_tenant
     AND adjustment.request_id = v_request_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.teacher_id IS DISTINCT FROM p_teacher_id
       OR v_existing.month_year IS DISTINCT FROM p_month
       OR v_existing.amount IS DISTINCT FROM p_valor THEN
      RETURN jsonb_build_object('ok', false, 'error', 'request_id_em_conflito');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'id', v_existing.id,
      'idempotent', true,
      'repasse_atualizado', v_existing.closing_synced
    );
  END IF;

  SELECT closing.status
    INTO v_closing_status
    FROM public.teacher_closings AS closing
   WHERE closing.tenant_id = p_tenant
     AND closing.teacher_id = p_teacher_id
     AND closing.month_year = p_month
   ORDER BY closing.created_at
   LIMIT 1
   FOR UPDATE;
  IF v_closing_status IS NOT NULL AND v_closing_status <> 'PENDENTE' THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'fechamento_nao_pendente'
    );
  END IF;

  INSERT INTO public.closing_adjustments (
    tenant_id, teacher_id, month_year, description, amount, created_by,
    request_id, closing_synced
  ) VALUES (
    p_tenant,
    p_teacher_id,
    p_month,
    btrim(p_descricao) || ' [via WhatsApp: ' ||
      left(btrim(coalesce(p_pedido_por, 'gestor')), 80) || ']',
    p_valor,
    p_actor_id,
    v_request_id,
    false
  )
  RETURNING id INTO v_id;

  v_refresh := private.refresh_teacher_closing_snapshot(
    p_tenant,
    p_teacher_id,
    p_month,
    false
  );
  v_sync := coalesce((v_refresh ->> 'synced')::boolean, false);

  UPDATE public.closing_adjustments
     SET closing_synced = v_sync
   WHERE id = v_id;

  INSERT INTO public.audit_logs (
    tenant_id, user_id, user_role, action, resource_type, resource_id,
    new_values
  ) VALUES (
    p_tenant, p_actor_id, v_actor_role,
    'teacher_payout_adjusted_via_management_group', 'closing_adjustment',
    v_id::text,
    jsonb_build_object(
      'teacher_id', p_teacher_id,
      'month', p_month,
      'amount', p_valor,
      'request_id', v_request_id,
      'closing_synced', v_sync
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_id,
    'idempotent', false,
    'repasse_atualizado', v_sync
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION public.gestao_change_booking_schedule(p_tenant text, p_actor_id uuid, p_booking_id uuid, p_expected_student_id uuid, p_day_of_week text, p_time_slot text, p_group_jid text, p_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_actor_role text;
  v_actor_name text;
  v_teacher_name text;
  v_student_name text;
  v_day text;
  v_day_number integer;
  v_time text;
  v_notification_id uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_tenant IS NULL OR p_booking_id IS NULL
     OR p_expected_student_id IS NULL
     OR coalesce(length(btrim(p_request_id)), 0) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'parametros_invalidos');
  END IF;

  SELECT membership.role, actor.full_name
    INTO v_actor_role, v_actor_name
    FROM public.tenant_memberships AS membership
    JOIN public.profiles AS actor ON actor.id = membership.user_id
   WHERE membership.user_id = p_actor_id
     AND membership.tenant_id = p_tenant
     AND membership.status = 'ACTIVE'
     AND membership.role IN ('SCHOOL_ADMIN', 'COORDINATOR')
     AND lower(coalesce(actor.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
   LIMIT 1;
  IF v_actor_role IS NULL AND NOT private.management_group_execution_authorized(p_tenant, p_actor_id, p_request_id,
    jsonb_build_object('tipo','alterar_horario_aluno','booking_id',p_booking_id,'student_id',p_expected_student_id,'novo_dia',p_day_of_week,'novo_horario',p_time_slot), p_group_jid) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'actor_not_allowed';
  END IF;

  SELECT booking.*
    INTO v_booking
    FROM public.bookings AS booking
   WHERE booking.id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND OR v_booking.tenant_id IS DISTINCT FROM p_tenant THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_nao_encontrada');
  END IF;
  IF v_booking.student_id IS DISTINCT FROM p_expected_student_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_nao_pertence_ao_aluno');
  END IF;
  IF upper(coalesce(v_booking.status, '')) <> 'SCHEDULED' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_nao_ativa');
  END IF;
  IF v_booking.date IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'ocorrencia_pontual_exige_remarcacao_por_data'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles AS teacher
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = teacher.id
       AND membership.tenant_id = p_tenant
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     WHERE teacher.id = v_booking.teacher_id
       AND teacher.role = 'TEACHER'
       AND lower(coalesce(teacher.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.profiles AS student
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = student.id
       AND membership.tenant_id = p_tenant
       AND membership.role = 'STUDENT'
       AND membership.status = 'ACTIVE'
     WHERE student.id = v_booking.student_id
       AND student.role = 'STUDENT'
       AND lower(coalesce(student.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'vinculos_da_aula_invalidos');
  END IF;

  v_day := CASE public.fold_accents(btrim(coalesce(p_day_of_week, '')))
    WHEN 'domingo' THEN 'Domingo'
    WHEN 'segunda' THEN 'Segunda'
    WHEN 'terca' THEN 'Terça'
    WHEN 'quarta' THEN 'Quarta'
    WHEN 'quinta' THEN 'Quinta'
    WHEN 'sexta' THEN 'Sexta'
    WHEN 'sabado' THEN 'Sábado'
    ELSE NULL
  END;
  v_day_number := CASE v_day
    WHEN 'Domingo' THEN 0 WHEN 'Segunda' THEN 1 WHEN 'Terça' THEN 2
    WHEN 'Quarta' THEN 3 WHEN 'Quinta' THEN 4 WHEN 'Sexta' THEN 5
    WHEN 'Sábado' THEN 6 ELSE NULL
  END;
  v_time := left(btrim(coalesce(p_time_slot, '')), 5);
  IF v_day IS NULL OR v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'novo_horario_invalido');
  END IF;

  IF public.fold_accents(v_booking.day_of_week) = public.fold_accents(v_day)
     AND left(v_booking.time_slot, 5) = v_time THEN
    RETURN jsonb_build_object(
      'ok', true, 'changed', false, 'booking_id', v_booking.id,
      'day_of_week', v_day, 'time_slot', v_time
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'schedule:teacher:' || v_booking.teacher_id::text || ':' ||
      public.fold_accents(v_day) || ':' || v_time,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'schedule:student:' || v_booking.student_id::text || ':' ||
      public.fold_accents(v_day) || ':' || v_time,
      0
    )
  );

  IF NOT EXISTS (
    SELECT 1
      FROM public.teacher_availability AS availability
     WHERE availability.tenant_id = p_tenant
       AND availability.teacher_id = v_booking.teacher_id
       AND availability.day_of_week = v_day_number
       AND (
         availability.start_time = v_time::time
         OR (
           availability.end_time IS NOT NULL
           AND availability.start_time <= v_time::time
           AND availability.end_time > v_time::time
         )
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'professor_sem_disponibilidade');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.bookings AS conflict
     WHERE conflict.id <> v_booking.id
       AND conflict.tenant_id = p_tenant
       AND conflict.teacher_id = v_booking.teacher_id
       AND upper(coalesce(conflict.status, '')) = 'SCHEDULED'
       AND public.fold_accents(conflict.day_of_week) = public.fold_accents(v_day)
       AND left(conflict.time_slot, 5) = v_time
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflito_professor');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.bookings AS conflict
     WHERE conflict.id <> v_booking.id
       AND conflict.tenant_id = p_tenant
       AND conflict.student_id = v_booking.student_id
       AND upper(coalesce(conflict.status, '')) = 'SCHEDULED'
       AND public.fold_accents(conflict.day_of_week) = public.fold_accents(v_day)
       AND left(conflict.time_slot, 5) = v_time
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflito_aluno');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.class_coverages AS coverage
     WHERE coverage.tenant_id = p_tenant
       AND coverage.cover_teacher_id = v_booking.teacher_id
       AND left(coverage.class_time, 5) = v_time
       AND extract(dow FROM coverage.class_date)::integer = v_day_number
       AND (
         coverage.class_date::text || ' ' ||
         left(coverage.class_time, 5) || ':00-03'
       )::timestamptz > now()
       AND (
         v_booking.start_date IS NULL
         OR coverage.class_date >= v_booking.start_date
       )
       AND (
         lower(coverage.status) = 'confirmed'
         OR (
           lower(coverage.status) = 'pending'
           AND now() < coalesce(
             coverage.invite_expires_at,
             (
               coverage.class_date::text || ' ' ||
               left(coverage.class_time, 5) || ':00-03'
             )::timestamptz
           )
         )
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflito_cobertura_ativa');
  END IF;

  SELECT profile.full_name INTO v_teacher_name
    FROM public.profiles AS profile
   WHERE profile.id = v_booking.teacher_id;
  SELECT profile.full_name INTO v_student_name
    FROM public.profiles AS profile
   WHERE profile.id = v_booking.student_id;
  IF v_teacher_name IS NULL OR v_student_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'vinculos_da_aula_invalidos');
  END IF;

  UPDATE public.bookings
     SET day_of_week = v_day,
         time_slot = v_time
   WHERE id = v_booking.id
     AND tenant_id = p_tenant
     AND student_id = p_expected_student_id;

  INSERT INTO public.audit_logs (
    tenant_id, user_id, user_role, action, resource_type, resource_id,
    old_values, new_values, diff
  ) VALUES (
    p_tenant, p_actor_id, v_actor_role,
    'booking_schedule_changed_via_management_group', 'booking',
    v_booking.id::text,
    jsonb_build_object(
      'day_of_week', v_booking.day_of_week,
      'time_slot', left(v_booking.time_slot, 5),
      'teacher_id', v_booking.teacher_id,
      'student_id', v_booking.student_id
    ),
    jsonb_build_object(
      'day_of_week', v_day,
      'time_slot', v_time,
      'teacher_id', v_booking.teacher_id,
      'student_id', v_booking.student_id,
      'request_id', left(btrim(p_request_id), 200)
    ),
    jsonb_build_object(
      'day_of_week', jsonb_build_array(v_booking.day_of_week, v_day),
      'time_slot', jsonb_build_array(left(v_booking.time_slot, 5), v_time)
    )
  );

  IF coalesce(p_group_jid, '') ~ '^[0-9]{8,25}@g[.]us$' THEN
    INSERT INTO public.notification_queue (
      tenant_id, teacher_id, student_id, student_name, student_phone,
      message_body, scheduled_for, status, source_id, source_type,
      notification_kind
    ) VALUES (
      p_tenant, v_booking.teacher_id, v_booking.student_id, v_student_name,
      p_group_jid,
      format(
        E'🔄 *ALTERAÇÃO DE AULA*\n\n👨‍🏫 Professor: *%s*\n👤 Aluno: *%s*\n\nAntes: %s às %s\nAgora: *%s às %s*\n\nAlterado por: %s',
        v_teacher_name, v_student_name, v_booking.day_of_week,
        left(v_booking.time_slot, 5), v_day, v_time,
        coalesce(v_actor_name, v_actor_role)
      ),
      now(), 'pending', v_booking.id, 'BOOKING_SCHEDULE',
      'SCHEDULE_CHANGE_GROUP'
    )
    RETURNING id INTO v_notification_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'changed', true,
    'booking_id', v_booking.id,
    'old_day', v_booking.day_of_week,
    'old_time', left(v_booking.time_slot, 5),
    'day_of_week', v_day,
    'time_slot', v_time,
    'notification_queued', v_notification_id IS NOT NULL
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION public.gestao_create_coverage_invite(p_tenant text, p_actor_id uuid, p_booking_id uuid, p_cover_teacher_id uuid, p_class_date date, p_class_time text, p_reason text, p_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_absence public.teacher_absences%ROWTYPE;
  v_coverage public.class_coverages%ROWTYPE;
  v_time text;
  v_day_number integer;
  v_day_name text;
  v_actor_role text;
  v_original_name text;
  v_cover_name text;
  v_cover_phone text;
  v_student_name text;
  v_token text;
  v_class_start timestamptz;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;

  IF p_tenant IS NULL OR p_booking_id IS NULL
     OR p_cover_teacher_id IS NULL OR p_class_date IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'parametros_invalidos');
  END IF;
  IF p_class_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
     OR p_class_date >
          (now() AT TIME ZONE 'America/Sao_Paulo')::date + 90 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'data_fora_da_janela');
  END IF;
  IF coalesce(length(btrim(p_reason)), 0) NOT BETWEEN 3 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'motivo_invalido');
  END IF;
  IF coalesce(length(btrim(p_request_id)), 0) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'request_id_invalido');
  END IF;
  v_time := left(btrim(coalesce(p_class_time, '')), 5);
  IF v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'horario_invalido');
  END IF;

  SELECT membership.role
    INTO v_actor_role
    FROM public.tenant_memberships AS membership
    JOIN public.profiles AS actor
      ON actor.id = membership.user_id
   WHERE membership.user_id = p_actor_id
     AND membership.tenant_id = p_tenant
     AND membership.status = 'ACTIVE'
     AND membership.role IN ('SCHOOL_ADMIN', 'COORDINATOR')
     AND lower(coalesce(actor.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
   LIMIT 1;
  IF v_actor_role IS NULL AND NOT private.management_group_execution_authorized(p_tenant, p_actor_id, p_request_id,
    jsonb_build_object('tipo','cobertura_aula','booking_id',p_booking_id,'cover_teacher_id',p_cover_teacher_id,'class_date',p_class_date,'class_time',p_class_time,'motivo',p_reason)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'actor_not_allowed';
  END IF;

  -- Idempotencia vem antes de criar qualquer artefato novo. A restricao UNIQUE
  -- continua como ultima barreira, mas o lock transforma chamadas simultaneas
  -- com a mesma chave em retry deterministico, sem erro 500 na perdedora.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'coverage-request:' || p_tenant || ':' ||
      left(btrim(p_request_id), 200),
      0
    )
  );
  SELECT coverage.*
    INTO v_coverage
    FROM public.class_coverages AS coverage
   WHERE coverage.tenant_id = p_tenant
     AND coverage.request_id = left(btrim(p_request_id), 200)
   FOR UPDATE;
  IF FOUND THEN
    IF v_coverage.booking_id IS DISTINCT FROM p_booking_id
       OR v_coverage.cover_teacher_id IS DISTINCT FROM p_cover_teacher_id
       OR v_coverage.class_date IS DISTINCT FROM p_class_date
       OR left(coalesce(v_coverage.class_time, ''), 5) IS DISTINCT FROM v_time THEN
      RETURN jsonb_build_object(
        'ok', false, 'error', 'request_id_em_conflito'
      );
    END IF;
    IF lower(coalesce(v_coverage.status, '')) = 'pending'
       AND now() >= coalesce(
         v_coverage.invite_expires_at,
         (
           v_coverage.class_date::text || ' ' ||
           left(v_coverage.class_time, 5) || ':00-03'
         )::timestamptz
       ) THEN
      UPDATE public.class_coverages
         SET status = 'cancelled'
       WHERE id = v_coverage.id
         AND tenant_id = p_tenant
         AND lower(status) = 'pending';
      RETURN jsonb_build_object(
        'ok', true, 'idempotent', true,
        'coverage_id', v_coverage.id, 'status', 'cancelled'
      );
    END IF;
    SELECT profile.full_name
      INTO v_original_name
      FROM public.profiles AS profile
     WHERE profile.id = v_coverage.original_teacher_id;
    SELECT profile.full_name,
           CASE
             WHEN length(regexp_replace(
               coalesce(profile.attendance_phone, ''), '[^0-9]', '', 'g'
             )) BETWEEN 10 AND 15 THEN profile.attendance_phone
             WHEN length(regexp_replace(
               coalesce(profile.phone, ''), '[^0-9]', '', 'g'
             )) BETWEEN 10 AND 15 THEN profile.phone
             ELSE NULL
           END
      INTO v_cover_name, v_cover_phone
      FROM public.profiles AS profile
     WHERE profile.id = v_coverage.cover_teacher_id;
    SELECT profile.full_name
      INTO v_student_name
      FROM public.profiles AS profile
     WHERE profile.id = v_coverage.student_id;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'coverage_id', v_coverage.id,
      'status', v_coverage.status,
      'token', v_coverage.token,
      'dispatched_at', v_coverage.dispatched_at,
      'class_date', v_coverage.class_date,
      'class_time', v_coverage.class_time,
      'student_name', btrim(coalesce(v_student_name, 'Aluno')),
      'original_teacher_name', btrim(coalesce(v_original_name, 'Professor')),
      'cover_teacher_name', btrim(coalesce(v_cover_name, 'Professor')),
      'cover_teacher_phone', v_cover_phone
    );
  END IF;

  SELECT booking.*
    INTO v_booking
    FROM public.bookings AS booking
   WHERE booking.id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND OR v_booking.tenant_id IS DISTINCT FROM p_tenant THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_nao_encontrada');
  END IF;
  IF upper(coalesce(v_booking.status, '')) <> 'SCHEDULED' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_inativa');
  END IF;
  IF v_booking.teacher_id IS NULL OR v_booking.student_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_sem_vinculos');
  END IF;
  IF v_booking.teacher_id = p_cover_teacher_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mesmo_professor');
  END IF;

  IF left(coalesce(v_booking.time_slot, ''), 5) <> v_time THEN
    RETURN jsonb_build_object('ok', false, 'error', 'horario_nao_corresponde_aula');
  END IF;
  v_class_start := (
    p_class_date::text || ' ' || v_time || ':00-03'
  )::timestamptz;
  IF v_class_start <= now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_no_passado');
  END IF;

  v_day_number := extract(dow FROM p_class_date)::integer;
  v_day_name := CASE v_day_number
    WHEN 0 THEN 'Domingo' WHEN 1 THEN 'Segunda' WHEN 2 THEN 'Terca'
    WHEN 3 THEN 'Quarta' WHEN 4 THEN 'Quinta' WHEN 5 THEN 'Sexta'
    WHEN 6 THEN 'Sabado'
  END;
  IF v_booking.date IS NOT NULL THEN
    IF v_booking.date <> p_class_date THEN
      RETURN jsonb_build_object('ok', false, 'error', 'data_nao_corresponde_aula');
    END IF;
  ELSIF public.fold_accents(v_booking.day_of_week) <> lower(v_day_name) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'dia_nao_corresponde_aula');
  END IF;
  IF v_booking.date IS NULL
     AND v_booking.start_date IS NOT NULL
     AND p_class_date < v_booking.start_date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_antes_do_inicio');
  END IF;

  SELECT profile.full_name
    INTO v_original_name
   FROM public.profiles AS profile
   WHERE profile.id = v_booking.teacher_id
     AND profile.tenant_id = p_tenant
     AND profile.role = 'TEACHER'
     AND lower(coalesce(profile.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
     AND EXISTS (
       SELECT 1
         FROM public.tenant_memberships AS membership
        WHERE membership.user_id = profile.id
          AND membership.tenant_id = p_tenant
          AND membership.role = 'TEACHER'
          AND membership.status = 'ACTIVE'
     );
  IF v_original_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'professor_ausente_invalido');
  END IF;

  SELECT profile.full_name,
         CASE
           WHEN length(regexp_replace(
             coalesce(profile.attendance_phone, ''), '[^0-9]', '', 'g'
           )) BETWEEN 10 AND 15 THEN profile.attendance_phone
           WHEN length(regexp_replace(
             coalesce(profile.phone, ''), '[^0-9]', '', 'g'
           )) BETWEEN 10 AND 15 THEN profile.phone
           ELSE NULL
         END
    INTO v_cover_name, v_cover_phone
    FROM public.profiles AS profile
   WHERE profile.id = p_cover_teacher_id
     AND profile.tenant_id = p_tenant
     AND profile.role = 'TEACHER'
     AND lower(coalesce(profile.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
     AND EXISTS (
       SELECT 1
         FROM public.tenant_memberships AS membership
        WHERE membership.user_id = profile.id
          AND membership.tenant_id = p_tenant
          AND membership.role = 'TEACHER'
          AND membership.status = 'ACTIVE'
     );
  IF v_cover_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'substituto_invalido');
  END IF;
  IF EXISTS (
    SELECT membership.user_id
      FROM public.tenant_memberships AS membership
     WHERE membership.user_id IN (v_booking.teacher_id, p_cover_teacher_id)
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     GROUP BY membership.user_id
    HAVING count(DISTINCT membership.tenant_id) <> 1
  ) THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'cobertura_multiescola_nao_suportada'
    );
  END IF;
  IF NOT private.can_access_teacher_projection(v_booking.teacher_id, to_char(
       p_class_date, 'YYYY-MM'
     ))
     OR NOT private.can_access_teacher_projection(p_cover_teacher_id, to_char(
       p_class_date, 'YYYY-MM'
     )) THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'cobertura_multiescola_nao_suportada'
    );
  END IF;
  IF coalesce(regexp_replace(v_cover_phone, '[^0-9]', '', 'g'), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'substituto_sem_whatsapp');
  END IF;

  SELECT profile.full_name
    INTO v_student_name
    FROM public.profiles AS profile
   WHERE profile.id = v_booking.student_id
     AND profile.role = 'STUDENT'
     AND lower(coalesce(profile.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
     AND EXISTS (
       SELECT 1
         FROM public.tenant_memberships AS membership
        WHERE membership.user_id = profile.id
          AND membership.tenant_id = p_tenant
          AND membership.role = 'STUDENT'
          AND membership.status = 'ACTIVE'
     );
  IF v_student_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aluno_invalido');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.teacher_availability AS availability
     WHERE availability.tenant_id = p_tenant
       AND availability.teacher_id = p_cover_teacher_id
       AND availability.day_of_week = v_day_number
       AND (
         availability.start_time = v_time::time
         OR (
           availability.end_time IS NOT NULL
           AND availability.start_time <= v_time::time
           AND availability.end_time > v_time::time
         )
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'substituto_sem_disponibilidade');
  END IF;

  -- Um lock deterministico fecha a janela entre consultar conflitos e inserir.
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'coverage:' || p_booking_id::text || ':' || p_class_date::text,
      0
    )
  );
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'coverage-teacher:' || p_cover_teacher_id::text || ':' ||
      p_class_date::text || ':' || v_time,
      0
    )
  );
  PERFORM private.lock_coverage_absence_pair(
    v_booking.teacher_id,
    p_cover_teacher_id,
    p_class_date
  );

  IF EXISTS (
    SELECT 1
      FROM public.bookings AS conflict
     WHERE conflict.tenant_id = p_tenant
       AND conflict.teacher_id = p_cover_teacher_id
       AND upper(coalesce(conflict.status, '')) <> 'CANCELLED'
       AND left(coalesce(conflict.time_slot, ''), 5) = v_time
       AND (
         conflict.date = p_class_date
         OR (
           conflict.date IS NULL
           AND public.fold_accents(conflict.day_of_week) = lower(v_day_name)
           AND (
             conflict.start_date IS NULL
             OR conflict.start_date <= p_class_date
           )
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.reschedules AS reschedule
     WHERE reschedule.tenant_id = p_tenant
       AND reschedule.teacher_id = p_cover_teacher_id
       AND public.parse_lesson_date(reschedule.date) = p_class_date
       AND left(reschedule.time::text, 5) = v_time
       AND reschedule.used_at IS NULL
  ) OR EXISTS (
    SELECT 1
      FROM public.appointments AS appointment
     WHERE appointment.tenant_id = p_tenant
       AND (
         appointment.teacher_id = p_cover_teacher_id
         OR appointment.professor_id = p_cover_teacher_id
       )
       AND lower(coalesce(appointment.status, '')) IN ('scheduled', 'confirmed')
       AND abs(extract(epoch FROM (appointment.start_time - v_class_start))) < 1800
  ) OR EXISTS (
    SELECT 1
      FROM public.teacher_absences AS substitute_absence
     WHERE substitute_absence.tenant_id = p_tenant
       AND substitute_absence.teacher_id = p_cover_teacher_id
       AND lower(coalesce(substitute_absence.status, '')) = 'active'
       AND substitute_absence.starts_at::date <= p_class_date
       AND substitute_absence.ends_at::date >= p_class_date
  ) OR EXISTS (
    SELECT 1
      FROM public.class_coverages AS teacher_coverage
     WHERE teacher_coverage.tenant_id = p_tenant
       AND teacher_coverage.cover_teacher_id = p_cover_teacher_id
       AND teacher_coverage.class_date = p_class_date
       AND left(teacher_coverage.class_time, 5) = v_time
       AND (
         lower(teacher_coverage.status) = 'confirmed'
         OR (
           lower(teacher_coverage.status) = 'pending'
           AND now() < coalesce(
             teacher_coverage.invite_expires_at,
             (
               teacher_coverage.class_date::text || ' ' ||
               left(teacher_coverage.class_time, 5) || ':00-03'
             )::timestamptz
           )
         )
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'substituto_ocupado');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.class_coverages AS coverage
     WHERE coverage.tenant_id = p_tenant
       AND coverage.booking_id = p_booking_id
       AND coverage.class_date = p_class_date
       AND (
         lower(coverage.status) = 'confirmed'
         OR (
           lower(coverage.status) = 'pending'
           AND now() < coalesce(
             coverage.invite_expires_at,
             (
               coverage.class_date::text || ' ' ||
               left(coverage.class_time, 5) || ':00-03'
             )::timestamptz
           )
         )
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cobertura_ja_existente');
  END IF;

  SELECT absence.*
    INTO v_absence
    FROM public.teacher_absences AS absence
   WHERE absence.tenant_id = p_tenant
     AND absence.teacher_id = v_booking.teacher_id
     AND lower(absence.status) = 'active'
     AND absence.starts_at::date <= p_class_date
     AND absence.ends_at::date >= p_class_date
   ORDER BY absence.created_at
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.teacher_absences (
      tenant_id, teacher_id, starts_at, ends_at, reason, status
    ) VALUES (
      p_tenant, v_booking.teacher_id, p_class_date, p_class_date,
      btrim(p_reason), 'active'
    )
    RETURNING * INTO v_absence;
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.class_coverages (
    tenant_id, original_teacher_id, cover_teacher_id, student_id,
    booking_id, absence_id, class_date, class_time, status, token,
    notes, dispatched_at, request_id, invite_expires_at
  ) VALUES (
    p_tenant, v_booking.teacher_id, p_cover_teacher_id, v_booking.student_id,
    p_booking_id, v_absence.id, p_class_date, v_time, 'pending', v_token,
    btrim(p_reason), NULL, left(btrim(p_request_id), 200),
    least(v_class_start, now() + interval '48 hours')
  )
  RETURNING * INTO v_coverage;

  INSERT INTO public.audit_logs (
    tenant_id, user_id, user_role, action, resource_type, resource_id,
    new_values
  ) VALUES (
    p_tenant, p_actor_id, v_actor_role,
    'coverage_requested_via_management_group', 'class_coverage',
    v_coverage.id::text,
    jsonb_build_object(
      'booking_id', p_booking_id,
      'student_id', v_booking.student_id,
      'original_teacher_id', v_booking.teacher_id,
      'cover_teacher_id', p_cover_teacher_id,
      'class_date', p_class_date,
      'class_time', v_time,
      'request_id', left(btrim(p_request_id), 200)
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'coverage_id', v_coverage.id,
    'absence_id', v_absence.id,
    'status', v_coverage.status,
    'token', v_token,
    'class_date', p_class_date,
    'class_time', v_time,
    'student_name', btrim(v_student_name),
    'original_teacher_name', btrim(v_original_name),
    'cover_teacher_name', btrim(v_cover_name),
    'cover_teacher_phone', v_cover_phone
  );
END;
$function$
;

-- Explicit owner request applies to this school only; other schools keep their previous policy.
update public.dre_report_settings set allow_group_member_actions = true where tenant_id = 'school-wise-wolf';
notify pgrst, 'reload schema';


create table public.teacher_training_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  trainer_id uuid not null references public.profiles(id),
  trainee_id uuid not null references public.profiles(id),
  trainer_name text not null,
  trainee_name text not null,
  trainee_phone text not null,
  meeting_link text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  agreed_rate numeric(10,2) not null default 16 check (agreed_rate = 16),
  status text not null default 'PENDING' check (status in ('PENDING','CONFIRMED','DECLINED','CANCELLED','COMPLETED')),
  appointment_id uuid unique references public.appointments(id),
  class_log_id uuid unique references public.class_logs(id),
  request_id text not null,
  created_by uuid references public.profiles(id),
  test_fixture boolean not null default false,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (trainer_id <> trainee_id),
  check (ends_at = starts_at + interval '30 minutes'),
  unique (tenant_id, request_id)
);
create index teacher_training_sessions_agenda on public.teacher_training_sessions(tenant_id, starts_at) where status in ('PENDING','CONFIRMED');
create table private.teacher_training_invite_tokens (
  token_hash text primary key,
  session_id uuid not null unique references public.teacher_training_sessions(id) on delete cascade,
  expires_at timestamptz not null
);
revoke all on private.teacher_training_invite_tokens from public,anon,authenticated,service_role;
alter table public.teacher_training_sessions enable row level security;
revoke all on public.teacher_training_sessions from public,anon,authenticated;
grant select on public.teacher_training_sessions to authenticated;
grant all on public.teacher_training_sessions to service_role;
create policy training_session_read on public.teacher_training_sessions for select to authenticated using (
  exists (select 1 from public.tenant_memberships m where m.user_id = (select auth.uid()) and m.tenant_id = teacher_training_sessions.tenant_id and m.status = 'ACTIVE' and
    (m.role in ('SCHOOL_ADMIN','COORDINATOR') or m.user_id in (trainer_id,trainee_id)))
);

create function private.training_manager(p_tenant text,p_actor uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.tenant_memberships m join public.profiles p on p.id=m.user_id where m.tenant_id=p_tenant and m.user_id=p_actor and m.status='ACTIVE' and m.role in ('SCHOOL_ADMIN','COORDINATOR') and lower(coalesce(p.lifecycle_status,'active'))='active');
$$;
revoke all on function private.training_manager(text,uuid) from public,anon,authenticated;

create function private.validate_training_slot(p_tenant text,p_trainer uuid,p_trainee uuid,p_start timestamptz,p_exclude uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_date date := (p_start at time zone 'America/Sao_Paulo')::date; v_time text := to_char(p_start at time zone 'America/Sao_Paulo','HH24:MI'); v_day text; v_teacher uuid;
begin
  if p_start is null or p_start <= now() or p_start > now()+interval '90 days' or to_char(p_start at time zone 'America/Sao_Paulo','MI:SS') not in ('00:00','30:00') then
    raise exception 'Escolha um horário futuro, em intervalos de 30 minutos, nos próximos 90 dias.';
  end if;
  v_day := (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from v_date)::int+1];
  for v_teacher in select distinct unnest(array[p_trainer,p_trainee]) order by 1 loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:teacher:'||v_teacher::text||':'||public.fold_accents(v_day)||':'||v_time,0));
    if not exists(select 1 from public.profiles p join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p_tenant and m.status='ACTIVE' and m.role='TEACHER' where p.id=v_teacher and p.tenant_id=p_tenant and p.role='TEACHER' and lower(coalesce(p.lifecycle_status,'active'))='active' and (p.id<>p_trainer or p.is_trainer=true)) then
      raise exception 'O treinador precisa estar habilitado e os dois teachers precisam estar ativos nesta escola.';
    end if;
    if exists(select 1 from public.bookings b where b.tenant_id=p_tenant and b.teacher_id=v_teacher and upper(coalesce(b.status,''))<>'CANCELLED' and left(b.time_slot,5)=v_time and (b.date=v_date or (b.date is null and public.fold_accents(b.day_of_week)=public.fold_accents(v_day) and (b.start_date is null or b.start_date<=v_date))))
      or exists(select 1 from public.reschedules r where r.tenant_id=p_tenant and r.teacher_id=v_teacher and public.parse_lesson_date(r.date)=v_date and left(r.time,5)=v_time and r.used_at is null)
      or exists(select 1 from public.appointments a where a.tenant_id=p_tenant and v_teacher in (a.teacher_id,a.professor_id) and lower(a.status) in ('scheduled','confirmed') and abs(extract(epoch from a.start_time-p_start))<1800)
      or exists(select 1 from public.class_coverages c where c.tenant_id=p_tenant and c.cover_teacher_id=v_teacher and c.class_date=v_date and left(c.class_time,5)=v_time and (c.status='confirmed' or (c.status='pending' and coalesce(c.invite_expires_at,p_start)>now())))
      or exists(select 1 from public.teacher_absences a where a.tenant_id=p_tenant and a.teacher_id=v_teacher and a.status='active' and a.starts_at::date<=v_date and a.ends_at::date>=v_date)
      or exists(select 1 from public.teacher_training_sessions t where t.tenant_id=p_tenant and v_teacher in (t.trainer_id,t.trainee_id) and t.status in ('PENDING','CONFIRMED') and t.starts_at < p_start+interval '30 minutes' and t.ends_at>p_start and t.id is distinct from p_exclude)
    then raise exception 'Um dos teachers já possui compromisso ou ausência nesse horário.'; end if;
  end loop;
end;
$$;
revoke all on function private.validate_training_slot(text,uuid,uuid,timestamptz,uuid) from public,anon,authenticated;

create function private.schedule_teacher_training(p_tenant text,p_actor uuid,p_request text,p_trainer uuid,p_trainee uuid,p_start timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.profiles%rowtype; n public.profiles%rowtype; s public.teacher_training_sessions%rowtype; v_token text; v_phone text; v_link text;
begin
  if length(coalesce(p_request,'')) not between 8 and 200 or p_trainer=p_trainee then raise exception 'Pedido inválido: selecione dois teachers diferentes.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('training-request:'||p_tenant||':'||p_request,0));
  select * into s from public.teacher_training_sessions where tenant_id=p_tenant and request_id=p_request;
  if found then
    if s.trainer_id<>p_trainer or s.trainee_id<>p_trainee or s.starts_at<>p_start then raise exception 'Este pedido já foi utilizado para outro treinamento.'; end if;
    return jsonb_build_object('ok',true,'id',s.id,'status',s.status,'idempotent',true);
  end if;
  perform private.validate_training_slot(p_tenant,p_trainer,p_trainee,p_start);
  select * into t from public.profiles where id=p_trainer;
  select * into n from public.profiles where id=p_trainee;
  v_phone := regexp_replace(coalesce(nullif(n.attendance_phone,''),n.phone,''),'[^0-9]','','g');
  if length(v_phone) in (10,11) then v_phone:='55'||v_phone; end if;
  if length(v_phone) not between 12 and 15 then raise exception 'O teacher que receberá o treinamento precisa cadastrar seu WhatsApp.'; end if;
  if coalesce(t.meeting_link,'') !~ '^https://[^[:space:]]+$' then raise exception 'Cadastre o link da sala do treinador antes de enviar o convite.'; end if;
  insert into public.teacher_training_sessions(tenant_id,trainer_id,trainee_id,trainer_name,trainee_name,trainee_phone,meeting_link,starts_at,ends_at,request_id,created_by,test_fixture)
  values(p_tenant,p_trainer,p_trainee,t.full_name,n.full_name,v_phone,t.meeting_link,p_start,p_start+interval '30 minutes',p_request,p_actor,coalesce(t.is_test_account,false) or coalesce(n.is_test_account,false)) returning * into s;
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into private.teacher_training_invite_tokens values(encode(extensions.digest(v_token,'sha256'),'hex'),s.id,p_start);
  v_link:='https://api.wisewolflanguage.com.br/functions/v1/teacher-training-invite?token='||v_token;
  if not s.test_fixture then
    insert into public.notification_queue(tenant_id,student_name,student_phone,message_body,scheduled_for,source_type,source_id,notification_kind,idempotency_key)
    values(p_tenant,n.full_name,v_phone,'Olá, '||n.full_name||'! Você recebeu um convite para treinamento com '||t.full_name||' em '||to_char(p_start at time zone 'America/Sao_Paulo','DD/MM/YYYY "às" HH24:MI')||' (Brasília), duração de 30 minutos. Confira e aceite pelo link: '||v_link,now(),'teacher_training',s.id,'TEACHER_TRAINING_INVITE','teacher-training-invite:'||s.id);
  end if;
  return jsonb_build_object('ok',true,'id',s.id,'status',s.status,'invitation_queued',not s.test_fixture);
end;
$$;
revoke all on function private.schedule_teacher_training(text,uuid,text,uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

create function public.schedule_teacher_training(p_tenant text,p_request_id text,p_trainer uuid,p_trainee uuid,p_start timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not private.training_manager(p_tenant,auth.uid()) then raise exception using errcode='42501',message='Apenas a gestão pode agendar treinamentos.'; end if;
 return private.schedule_teacher_training(p_tenant,auth.uid(),p_request_id,p_trainer,p_trainee,p_start);
end;
$$;
revoke all on function public.schedule_teacher_training(text,text,uuid,uuid,timestamptz) from public,anon;
grant execute on function public.schedule_teacher_training(text,text,uuid,uuid,timestamptz) to authenticated;

create function public.gestao_schedule_teacher_training(p_tenant text,p_actor_id uuid,p_request_id text,p_trainer uuid,p_trainee uuid,p_start timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.role(),'')<>'service_role' or not private.management_group_execution_authorized(p_tenant,p_actor_id,p_request_id,
   jsonb_build_object('tipo','agendar_treinamento','trainer_id',p_trainer,'trainee_id',p_trainee,'starts_at',to_char(p_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) then
   raise exception using errcode='42501',message='Confirmação do treinamento não encontrada.';
 end if;
 return private.schedule_teacher_training(p_tenant,p_actor_id,p_request_id,p_trainer,p_trainee,p_start);
end;
$$;
revoke all on function public.gestao_schedule_teacher_training(text,uuid,text,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.gestao_schedule_teacher_training(text,uuid,text,uuid,uuid,timestamptz) to service_role;

create function public.teacher_training_invite(p_token text,p_decision text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.teacher_training_sessions%rowtype; v_appointment uuid; v_phone text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='service_role_required'; end if;
 if p_token !~ '^[a-f0-9]{64}$' then return jsonb_build_object('ok',false,'error','Convite inválido.'); end if;
 select t.* into s from public.teacher_training_sessions t join private.teacher_training_invite_tokens k on k.session_id=t.id where k.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and k.expires_at>now() for update of t;
 if not found then return jsonb_build_object('ok',false,'error','Convite inválido ou expirado. Peça um novo agendamento à gestão.'); end if;
 if p_decision is not null and p_decision not in ('accept','decline') then return jsonb_build_object('ok',false,'error','Resposta inválida.'); end if;
 if s.status='PENDING' and p_decision is not null then
   if p_decision='accept' then
     perform private.validate_training_slot(s.tenant_id,s.trainer_id,s.trainee_id,s.starts_at,s.id);
     insert into public.appointments(tenant_id,teacher_id,professor_id,student_name,student_phone,start_time,status,type)
     values(s.tenant_id,s.trainer_id,s.trainer_id,s.trainee_name,s.trainee_phone,s.starts_at,'scheduled','training') returning id into v_appointment;
     update public.teacher_training_sessions set status='CONFIRMED',appointment_id=v_appointment,responded_at=now() where id=s.id returning * into s;
   else
     update public.teacher_training_sessions set status='DECLINED',responded_at=now() where id=s.id returning * into s;
   end if;
   select regexp_replace(coalesce(nullif(attendance_phone,''),phone,''),'[^0-9]','','g') into v_phone from public.profiles where id=s.trainer_id;
   if length(v_phone) in (10,11) then v_phone:='55'||v_phone; end if;
   if not s.test_fixture and length(v_phone) between 12 and 15 then
     insert into public.notification_queue(tenant_id,student_phone,message_body,scheduled_for,source_type,source_id,notification_kind,idempotency_key)
     values(s.tenant_id,v_phone,s.trainee_name||case when s.status='CONFIRMED' then ' aceitou' else ' recusou' end||' o treinamento de '||to_char(s.starts_at at time zone 'America/Sao_Paulo','DD/MM "às" HH24:MI')||'.'||case when s.status='CONFIRMED' then ' Após ministrar o treinamento, registre a conclusão no lançador de aulas para receber R$ 16,00.' else ' Nenhum valor foi lançado.' end,now(),'teacher_training',s.id,'TEACHER_TRAINING_RESPONSE','teacher-training-response:'||s.id);
   end if;
 end if;
 return jsonb_build_object('ok',true,'status',s.status,'trainer',s.trainer_name,'trainee',s.trainee_name,'starts_at',s.starts_at,'ends_at',s.ends_at,'meeting_link',case when s.status='CONFIRMED' then s.meeting_link else null end);
end;
$$;
revoke all on function public.teacher_training_invite(text,text) from public,anon,authenticated;
grant execute on function public.teacher_training_invite(text,text) to service_role;

create function public.cancel_teacher_training(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare s public.teacher_training_sessions%rowtype;
begin
 select * into s from public.teacher_training_sessions where id=p_id for update;
 if not found or not private.training_manager(s.tenant_id,auth.uid()) then raise exception using errcode='42501',message='Apenas a gestão pode cancelar este treinamento.'; end if;
 if s.status='COMPLETED' or s.class_log_id is not null then raise exception 'O treinamento já foi lançado no fechamento.'; end if;
 if s.status in ('CANCELLED','DECLINED') then return; end if;
 update public.teacher_training_sessions set status='CANCELLED' where id=p_id;
 update public.appointments set status='cancelled' where id=s.appointment_id;
end;
$$;
revoke all on function public.cancel_teacher_training(uuid) from public,anon;
grant execute on function public.cancel_teacher_training(uuid) to authenticated;

create function private.protect_training_class_log() returns trigger language plpgsql security definer set search_path='' as $$
declare s public.teacher_training_sessions%rowtype;
begin
 select * into s from public.teacher_training_sessions where appointment_id::text=new.appointment_id for update;
 if not found then return new; end if;
 if s.status not in ('CONFIRMED','COMPLETED') or s.trainer_id is distinct from new.teacher_id or s.tenant_id is distinct from new.tenant_id or s.ends_at>now() or new.class_date is distinct from (s.starts_at at time zone 'America/Sao_Paulo')::date or new.presence is distinct from 'COMPLETED' then
   raise exception 'O treinamento precisa ter aceite e estar concluído para entrar no fechamento.';
 end if;
 if s.class_log_id is not null and s.class_log_id<>new.id then raise exception using errcode='23505',message='Treinamento já lançado.',constraint='uq_class_logs_appointment'; end if;
 new.rate_override:=s.agreed_rate;
 new.subtype:='TREINAMENTO';
 return new;
end;
$$;
create trigger zz_protect_training_class_log before insert or update on public.class_logs for each row execute function private.protect_training_class_log();
create function private.complete_training_class_log() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.teacher_training_sessions set status='COMPLETED',class_log_id=new.id where appointment_id::text=new.appointment_id and trainer_id=new.teacher_id;
 return new;
end;
$$;
create trigger complete_training_class_log after insert on public.class_logs for each row execute function private.complete_training_class_log();
revoke all on function private.protect_training_class_log() from public,anon,authenticated;
revoke all on function private.complete_training_class_log() from public,anon,authenticated;
create function public.teacher_training_scheduler_data(p_tenant text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not private.training_manager(p_tenant,auth.uid()) then raise exception using errcode='42501',message='Acesso restrito à gestão.'; end if;
 return jsonb_build_object(
  'teachers',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name,'is_trainer',p.is_trainer) order by p.full_name),'[]'::jsonb) from public.profiles p join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p_tenant and m.status='ACTIVE' and m.role='TEACHER' where p.tenant_id=p_tenant and p.role='TEACHER' and lower(coalesce(p.lifecycle_status,'active'))='active'),
  'sessions',(select coalesce(jsonb_agg(to_jsonb(x) order by starts_at desc),'[]'::jsonb) from (
   select s.id,s.trainer_name,s.trainee_name,s.starts_at,s.status,s.agreed_rate,
    (select q.delivery_status from public.notification_queue q where q.source_id=s.id and q.notification_kind='TEACHER_TRAINING_INVITE' order by q.created_at desc limit 1) as invitation_status
   from public.teacher_training_sessions s where s.tenant_id=p_tenant and s.starts_at>now()-interval '60 days' and not s.test_fixture order by s.starts_at desc limit 100
  ) x));
end;
$$;
revoke all on function public.teacher_training_scheduler_data(text) from public,anon;
grant execute on function public.teacher_training_scheduler_data(text) to authenticated;

-- Reserve the trainee's agenda as well as the trainer's. Existing scheduling
-- paths use the same teacher/weekday/slot advisory lock.
create function private.protect_confirmed_training_slot() returns trigger language plpgsql security definer set search_path='' as $$
declare v_teacher uuid; v_teachers uuid[]; v_day text; v_time text; v_date date; v_start timestamptz; v_start_date date;
begin
 if tg_table_name='appointments' then
  if lower(coalesce(new.status,'')) not in ('scheduled','confirmed') then return new; end if;
  v_start:=new.start_time; v_date:=(v_start at time zone 'America/Sao_Paulo')::date;
  v_time:=to_char(v_start at time zone 'America/Sao_Paulo','HH24:MI');
  v_teachers:=array[new.teacher_id,new.professor_id];
 elsif tg_table_name='bookings' then
  if upper(coalesce(new.status,''))='CANCELLED' then return new; end if;
  v_date:=new.date; v_day:=new.day_of_week; v_time:=left(new.time_slot,5); v_start_date:=new.start_date; v_teachers:=array[new.teacher_id];
 else
  if new.used_at is not null then return new; end if;
  v_date:=public.parse_lesson_date(new.date); v_time:=left(new.time,5); v_teachers:=array[new.teacher_id];
 end if;
 if v_date is not null then v_day:=(array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from v_date)::int+1]; end if;
 for v_teacher in select distinct unnest(v_teachers) order by 1 loop
  if v_teacher is null then continue; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:teacher:'||v_teacher::text||':'||public.fold_accents(v_day)||':'||v_time,0));
  if exists(select 1 from public.teacher_training_sessions t where t.tenant_id=new.tenant_id and v_teacher in (t.trainer_id,t.trainee_id) and t.status='CONFIRMED' and t.ends_at>now()
    and (tg_table_name<>'appointments' or t.appointment_id is distinct from new.id)
    and ((v_start is not null and t.starts_at<v_start+interval '30 minutes' and t.ends_at>v_start)
      or (v_start is null and to_char(t.starts_at at time zone 'America/Sao_Paulo','HH24:MI')=v_time
        and ((v_date is not null and (t.starts_at at time zone 'America/Sao_Paulo')::date=v_date)
          or (v_date is null and public.fold_accents(v_day)=public.fold_accents((array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from t.starts_at at time zone 'America/Sao_Paulo')::int+1]) and (v_start_date is null or (t.starts_at at time zone 'America/Sao_Paulo')::date>=v_start_date))))))
  then raise exception 'Este teacher já tem um treinamento confirmado nesse horário.'; end if;
 end loop;
 return new;
end;
$$;
create trigger zz_protect_confirmed_training_slot before insert or update on public.appointments for each row execute function private.protect_confirmed_training_slot();
create trigger zz_protect_confirmed_training_slot before insert or update on public.bookings for each row execute function private.protect_confirmed_training_slot();
create trigger zz_protect_confirmed_training_slot before insert or update on public.reschedules for each row execute function private.protect_confirmed_training_slot();
revoke all on function private.protect_confirmed_training_slot() from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
