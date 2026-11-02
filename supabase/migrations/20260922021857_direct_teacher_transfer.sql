-- Transferência definitiva e imediata de um aluno pela Gestão.
--
-- Este fluxo é diferente de cobertura temporária e da proposta que aguarda o
-- aceite do professor. Ele preserva os IDs dos bookings, troca somente o
-- professor responsável, registra a operação em teacher_transfers/audit_logs
-- e deixa os lançamentos históricos intactos.

-- Uma cobertura de ocorrência passada continua apontando para o booking fixo.
-- A proteção original bloqueia qualquer troca do booking enquanto houver uma
-- cobertura confirmada ainda sem class_log, inclusive de datas já passadas.
-- Abrimos somente a mudança de teacher_id comprovada por uma transferência
-- APPLIED criada pelo gestor na mesma transação; data, aluno, horário e o
-- registro da cobertura permanecem imutáveis.
create or replace function public.protect_booking_source_coverage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_audited_direct_transfer boolean := false;
begin
  if tg_op = 'UPDATE'
     and new.teacher_id is distinct from old.teacher_id
     and new.tenant_id is not distinct from old.tenant_id
     and new.student_id is not distinct from old.student_id
     and new.day_of_week is not distinct from old.day_of_week
     and new.time_slot is not distinct from old.time_slot
     and new.date is not distinct from old.date
     and new.start_date is not distinct from old.start_date
     and new.status is not distinct from old.status
  then
    v_audited_direct_transfer := exists (
      select 1
        from public.teacher_transfers as transfer
       where transfer.tenant_id = old.tenant_id
         and transfer.student_id = old.student_id
         and transfer.from_teacher_id = old.teacher_id
         and transfer.to_teacher_id = new.teacher_id
         and upper(transfer.status) = 'APPLIED'
         and transfer.created_by = auth.uid()
         and transfer.applied_at = now()
    );
  end if;

  if v_audited_direct_transfer then
    return new;
  end if;

  if tg_op = 'UPDATE' and not (
    new.tenant_id is distinct from old.tenant_id
    or new.teacher_id is distinct from old.teacher_id
    or new.student_id is distinct from old.student_id
    or new.day_of_week is distinct from old.day_of_week
    or new.time_slot is distinct from old.time_slot
    or new.date is distinct from old.date
    or new.start_date is distinct from old.start_date
    or new.status is distinct from old.status
  ) then
    return new;
  end if;

  if exists (
    select 1
      from public.class_coverages as coverage
     where coverage.booking_id = old.id
       and coverage.tenant_id = old.tenant_id
       and (
         (lower(coverage.status) = 'confirmed' and coverage.class_log_id is null)
         or (
           lower(coverage.status) = 'pending'
           and now() < coalesce(
             coverage.invite_expires_at,
             (coverage.class_date::text || ' ' || left(coverage.class_time, 5) || ':00-03')::timestamptz
           )
         )
       )
  ) then
    raise exception using errcode = '23P01', message = 'booking_has_active_coverage';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

alter function public.protect_booking_source_coverage() owner to postgres;
revoke all on function public.protect_booking_source_coverage()
  from public, anon, authenticated, service_role;

create or replace function public.admin_transfer_student_teacher(
  p_student_id uuid,
  p_to_teacher uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_actor_role text := public._my_role();
  v_tenant text;
  v_from_teacher uuid;
  v_student_name text;
  v_from_name text;
  v_to_name text;
  v_slots jsonb;
  v_booking_ids uuid[];
  v_booking_id uuid;
  v_transfer_id uuid;
  v_changed integer;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'Sessão expirada. Entre novamente.';
  end if;
  if coalesce(length(btrim(p_reason)), 0) not between 8 and 1000 then
    raise exception using errcode = '22023',
      message = 'Informe o motivo da transferência (mínimo de 8 caracteres).';
  end if;

  select student.tenant_id, student.professor_id, student.full_name
    into v_tenant, v_from_teacher, v_student_name
    from public.profiles as student
   where student.id = p_student_id
     and student.role = 'STUDENT'
     and lower(coalesce(student.lifecycle_status, 'active')) = 'active'
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Aluno ativo não encontrado.';
  end if;
  if not private.quality_school_manager(v_tenant) then
    raise exception using errcode = '42501',
      message = 'Somente a Gestão pode transferir definitivamente um aluno.';
  end if;
  if v_from_teacher is null then
    raise exception using errcode = '22023', message = 'O aluno não possui professor principal.';
  end if;
  if p_to_teacher is null or p_to_teacher = v_from_teacher then
    raise exception using errcode = '22023', message = 'Escolha um professor diferente do atual.';
  end if;

  select teacher.full_name
    into v_to_name
    from public.profiles as teacher
    join public.tenant_memberships as membership
      on membership.user_id = teacher.id
     and membership.tenant_id = teacher.tenant_id
     and membership.role = 'TEACHER'
     and membership.status = 'ACTIVE'
   where teacher.id = p_to_teacher
     and teacher.tenant_id = v_tenant
     and teacher.role = 'TEACHER'
     and lower(coalesce(teacher.lifecycle_status, 'active')) = 'active';
  if not found then
    raise exception using errcode = '42501',
      message = 'O professor de destino não está ativo nesta escola.';
  end if;
  select full_name into v_from_name from public.profiles where id = v_from_teacher;

  -- O lock por aluno serializa transferência, alteração de perfil e reenvio.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-teacher-transfer:' || v_tenant || ':' || p_student_id::text, 0)
  );

  select array_agg(booking.id order by booking.id),
         jsonb_agg(
           jsonb_build_object(
             'day_of_week', public.canonical_weekday_name(booking.day_of_week),
             'time_slot', left(booking.time_slot, 5)
           ) order by public.dow_name_to_int(booking.day_of_week), left(booking.time_slot, 5)
         )
    into v_booking_ids, v_slots
    from public.bookings as booking
   where booking.tenant_id = v_tenant
     and booking.student_id = p_student_id
     and booking.teacher_id = v_from_teacher
     and upper(coalesce(booking.status, '')) = 'SCHEDULED'
     and booking.date is null;

  if coalesce(array_length(v_booking_ids, 1), 0) = 0 then
    raise exception using errcode = '22023',
      message = 'O aluno não possui aulas fixas ativas com o professor atual.';
  end if;

  -- Bookings materializados por uma oferta têm uma reserva autoritativa ligada
  -- ao professor original. Exigimos regularização desse vínculo em vez de
  -- quebrar silenciosamente a reserva da matrícula.
  if exists (
    select 1 from public.bookings as booking
     where booking.id = any(v_booking_ids)
       and (booking.enrollment_offer_id is not null or booking.enrollment_offer_slot_id is not null)
  ) then
    raise exception using errcode = '23P01',
      message = 'A matrícula possui uma reserva de horário vinculada. Regularize a oferta antes da transferência.';
  end if;

  -- Locks determinísticos fecham a janela entre a checagem e a troca.
  for v_booking_id in
    select booking.id
      from public.bookings as booking
     where booking.id = any(v_booking_ids)
     order by public.dow_name_to_int(booking.day_of_week), left(booking.time_slot, 5), booking.id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'schedule:teacher:' || p_to_teacher::text || ':' ||
        public.fold_accents((select b.day_of_week from public.bookings b where b.id = v_booking_id)) || ':' ||
        left((select b.time_slot from public.bookings b where b.id = v_booking_id), 5),
        0
      )
    );
  end loop;

  if exists (
    select 1
      from public.bookings as source
     where source.id = any(v_booking_ids)
       and not exists (
         select 1
           from public.teacher_availability as availability
          where availability.tenant_id = v_tenant
            and availability.teacher_id = p_to_teacher
            and availability.day_of_week = public.dow_name_to_int(source.day_of_week)
            and availability.start_time = left(source.time_slot, 5)::time
       )
  ) then
    raise exception using errcode = '23514',
      message = 'O professor de destino não está disponível em todos os horários atuais do aluno.';
  end if;

  if exists (
    select 1
      from public.bookings as source
      join public.bookings as conflict
        on conflict.tenant_id = source.tenant_id
       and conflict.teacher_id = p_to_teacher
       and conflict.id <> source.id
       and upper(coalesce(conflict.status, '')) = 'SCHEDULED'
       and public.dow_name_to_int(conflict.day_of_week) = public.dow_name_to_int(source.day_of_week)
       and left(conflict.time_slot, 5) = left(source.time_slot, 5)
     where source.id = any(v_booking_ids)
  ) then
    raise exception using errcode = '23P01',
      message = 'O professor de destino já possui aula em um dos horários do aluno.';
  end if;

  -- Propostas antigas não podem continuar aplicáveis depois da troca direta.
  update public.teacher_transfers
     set status = 'CANCELLED', decided_at = now(),
         decline_reason = 'Substituída por transferência definitiva da Gestão.'
   where tenant_id = v_tenant
     and student_id = p_student_id
     and upper(status) in ('PENDING', 'ACCEPTED');

  insert into public.teacher_transfers(
    tenant_id, student_id, from_teacher_id, to_teacher_id, proposed_slots,
    cutover_date, reason, status, created_by, decided_at, applied_at
  ) values (
    v_tenant, p_student_id, v_from_teacher, p_to_teacher, v_slots,
    (now() at time zone 'America/Sao_Paulo')::date, btrim(p_reason), 'APPLIED',
    v_actor, now(), now()
  ) returning id into v_transfer_id;

  update public.bookings as booking
     set teacher_id = p_to_teacher
   where booking.id = any(v_booking_ids);
  get diagnostics v_changed = row_count;

  update public.profiles as student
     set professor_id = p_to_teacher,
         professor_id2 = case
           when student.professor_id2 in (v_from_teacher, p_to_teacher) then null
           else student.professor_id2
         end
   where student.id = p_student_id
     and student.tenant_id = v_tenant
     and student.professor_id = v_from_teacher;
  if not found then
    raise exception using errcode = '40001',
      message = 'O professor do aluno mudou durante a transferência. Atualize a página e tente novamente.';
  end if;

  insert into public.audit_logs(
    tenant_id, user_id, user_role, action, resource_type, resource_id,
    old_values, new_values, diff
  ) values (
    v_tenant, v_actor, v_actor_role, 'student_teacher_transferred', 'student', p_student_id::text,
    jsonb_build_object('professor_id', v_from_teacher, 'professor_name', v_from_name),
    jsonb_build_object('professor_id', p_to_teacher, 'professor_name', v_to_name,
      'transfer_id', v_transfer_id, 'bookings_changed', v_changed, 'reason', btrim(p_reason)),
    jsonb_build_object('professor_id', jsonb_build_array(v_from_teacher, p_to_teacher))
  );

  return jsonb_build_object(
    'ok', true,
    'student_id', p_student_id,
    'student_name', v_student_name,
    'from_teacher_id', v_from_teacher,
    'from_teacher_name', v_from_name,
    'to_teacher_id', p_to_teacher,
    'to_teacher_name', v_to_name,
    'bookings_changed', v_changed,
    'transfer_id', v_transfer_id,
    'slots', v_slots
  );
end;
$function$;

alter function public.admin_transfer_student_teacher(uuid, uuid, text) owner to postgres;
revoke all on function public.admin_transfer_student_teacher(uuid, uuid, text)
  from public, anon, service_role;
grant execute on function public.admin_transfer_student_teacher(uuid, uuid, text)
  to authenticated;

comment on function public.admin_transfer_student_teacher(uuid, uuid, text) is
  'Gestão transfere imediatamente o professor principal e todos os bookings fixos ativos do aluno, com validação de disponibilidade, conflitos e auditoria.';
