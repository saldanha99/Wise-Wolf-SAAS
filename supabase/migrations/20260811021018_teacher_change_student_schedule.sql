-- Troca permanente de dia/horário de uma aula recorrente.
--
-- A alteração passa por uma única função para que autorização, choque de
-- agenda, auditoria e aviso operacional aconteçam na mesma transação. O
-- professor só pode alterar booking próprio; direção/coordenação pode alterar
-- qualquer booking do tenant. Nenhum dos dois consegue trocar professor,
-- aluno, tenant ou outros campos por este fluxo.

create or replace function public.change_booking_schedule(
  p_booking_id uuid,
  p_day_of_week text,
  p_time_slot text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_actor_tenant text;
  v_actor_name text;
  v_booking public.bookings%rowtype;
  v_teacher_name text;
  v_student_name text;
  v_day text;
  v_day_number integer;
  v_time text;
  v_group_jid text;
  v_message text;
  v_notification_id uuid;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'Sessão expirada. Entre novamente.';
  end if;

  select p.role, p.tenant_id, p.full_name
    into v_actor_role, v_actor_tenant, v_actor_name
    from public.profiles as p
   where p.id = v_actor_id;

  if v_actor_role is null
     or v_actor_role not in ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode alterar agendas.';
  end if;

  select b.*
    into v_booking
    from public.bookings as b
   where b.id = p_booking_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Aula não encontrada.';
  end if;

  if v_booking.tenant_id is distinct from v_actor_tenant then
    raise exception using errcode = '42501', message = 'Aula fora da sua escola.';
  end if;

  if v_actor_role = 'TEACHER' and v_booking.teacher_id is distinct from v_actor_id then
    raise exception using errcode = '42501', message = 'Você só pode alterar alunos da sua própria agenda.';
  end if;

  if v_booking.status is distinct from 'SCHEDULED' then
    raise exception using errcode = '22023', message = 'Somente aulas ativas podem ter o horário alterado.';
  end if;

  v_day := case lower(trim(coalesce(p_day_of_week, '')))
    when 'segunda' then 'Segunda'
    when 'terça' then 'Terça'
    when 'terca' then 'Terça'
    when 'quarta' then 'Quarta'
    when 'quinta' then 'Quinta'
    when 'sexta' then 'Sexta'
    when 'sábado' then 'Sábado'
    when 'sabado' then 'Sábado'
    else null
  end;

  v_day_number := case v_day
    when 'Segunda' then 1
    when 'Terça' then 2
    when 'Quarta' then 3
    when 'Quinta' then 4
    when 'Sexta' then 5
    when 'Sábado' then 6
    else null
  end;

  v_time := left(trim(coalesce(p_time_slot, '')), 5);
  if v_day is null then
    raise exception using errcode = '22023', message = 'Escolha um dia válido de segunda a sábado.';
  end if;
  if v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' then
    raise exception using errcode = '22023', message = 'Escolha um horário em intervalos de 30 minutos.';
  end if;

  if v_booking.day_of_week in (v_day, case when v_day = 'Terça' then 'Terca' else v_day end)
     and left(v_booking.time_slot, 5) = v_time then
    return jsonb_build_object(
      'ok', true,
      'changed', false,
      'booking_id', v_booking.id,
      'day_of_week', v_day,
      'time_slot', v_time,
      'notification_queued', false
    );
  end if;

  -- Serializa tentativas para o mesmo professor/aluno e fecha a janela entre
  -- o teste de conflito e o update (o índice legado não cobre esses dois casos).
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'schedule:teacher:' || v_booking.teacher_id::text || ':' || v_day || ':' || v_time,
      0
    )
  );
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'schedule:student:' || v_booking.student_id::text || ':' || v_day || ':' || v_time,
      0
    )
  );

  if not exists (
    select 1
      from public.teacher_availability as availability
     where availability.teacher_id = v_booking.teacher_id
       and availability.tenant_id = v_booking.tenant_id
       and availability.day_of_week = v_day_number
       and availability.start_time = v_time::time
  ) then
    raise exception using errcode = '23514', message = 'O novo horário não está na disponibilidade cadastrada do professor.';
  end if;

  if exists (
    select 1
      from public.bookings as conflict
     where conflict.id <> v_booking.id
       and conflict.tenant_id = v_booking.tenant_id
       and conflict.teacher_id = v_booking.teacher_id
       and conflict.status = 'SCHEDULED'
       and conflict.day_of_week in (v_day, case when v_day = 'Terça' then 'Terca' else v_day end)
       and left(conflict.time_slot, 5) = v_time
  ) then
    raise exception using errcode = '23P01', message = 'O professor já possui uma aula nesse dia e horário.';
  end if;

  if exists (
    select 1
      from public.bookings as conflict
     where conflict.id <> v_booking.id
       and conflict.tenant_id = v_booking.tenant_id
       and conflict.student_id = v_booking.student_id
       and conflict.status = 'SCHEDULED'
       and conflict.day_of_week in (v_day, case when v_day = 'Terça' then 'Terca' else v_day end)
       and left(conflict.time_slot, 5) = v_time
  ) then
    raise exception using errcode = '23P01', message = 'O aluno já possui uma aula nesse dia e horário.';
  end if;

  select p.full_name into v_teacher_name
    from public.profiles as p where p.id = v_booking.teacher_id;
  select p.full_name into v_student_name
    from public.profiles as p where p.id = v_booking.student_id;

  update public.bookings
     set day_of_week = v_day,
         time_slot = v_time
   where id = v_booking.id;

  insert into public.audit_logs (
    tenant_id,
    user_id,
    user_role,
    action,
    resource_type,
    resource_id,
    old_values,
    new_values,
    diff
  ) values (
    v_booking.tenant_id,
    v_actor_id,
    v_actor_role,
    'booking_schedule_changed',
    'booking',
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
      'student_id', v_booking.student_id
    ),
    jsonb_build_object(
      'day_of_week', jsonb_build_array(v_booking.day_of_week, v_day),
      'time_slot', jsonb_build_array(left(v_booking.time_slot, 5), v_time)
    )
  );

  select nullif(trim(p.teachers_group_id), '')
    into v_group_jid
    from public.profiles as p
   where p.tenant_id = v_booking.tenant_id
     and p.role in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
     and nullif(trim(p.teachers_group_id), '') is not null
   order by case when p.role = 'SCHOOL_ADMIN' then 0 else 1 end, p.created_at
   limit 1;

  -- Grupo operacional legado da Wise Wolf. Um grupo configurado no perfil da
  -- direção sempre tem precedência sobre este fallback.
  v_group_jid := coalesce(v_group_jid, '120363403699904869@g.us');
  v_message := format(
    E'🔄 *ALTERAÇÃO DE AGENDA*\n\n👨‍🏫 Professor: *%s*\n👤 Aluno: *%s*\n\nAntes: %s às %s\nAgora: *%s às %s*\n\nAlterado por: %s\n_Ajuste combinado entre professor e aluno._',
    coalesce(v_teacher_name, 'Professor'),
    coalesce(v_student_name, 'Aluno'),
    v_booking.day_of_week,
    left(v_booking.time_slot, 5),
    v_day,
    v_time,
    coalesce(v_actor_name, v_actor_role)
  );

  insert into public.notification_queue (
    tenant_id,
    teacher_id,
    student_id,
    student_name,
    student_phone,
    message_body,
    scheduled_for,
    status,
    source_id,
    source_type,
    notification_kind
  ) values (
    v_booking.tenant_id,
    v_booking.teacher_id,
    v_booking.student_id,
    v_student_name,
    v_group_jid,
    v_message,
    now(),
    'pending',
    v_booking.id,
    'BOOKING_SCHEDULE',
    'SCHEDULE_CHANGE_GROUP'
  )
  returning id into v_notification_id;

  return jsonb_build_object(
    'ok', true,
    'changed', true,
    'booking_id', v_booking.id,
    'day_of_week', v_day,
    'time_slot', v_time,
    'notification_queued', true,
    'notification_id', v_notification_id
  );
end;
$function$;

revoke all on function public.change_booking_schedule(uuid, text, text) from public;
revoke all on function public.change_booking_schedule(uuid, text, text) from anon;
grant execute on function public.change_booking_schedule(uuid, text, text) to authenticated;

comment on function public.change_booking_schedule(uuid, text, text) is
  'Altera somente dia/horário de booking próprio (professor) ou do tenant (gestão), audita e enfileira aviso ao grupo operacional.';
