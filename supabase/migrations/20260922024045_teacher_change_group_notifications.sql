-- Toda mudança operacional feita pelo professor em aluno/agenda precisa deixar
-- trilha e avisar um grupo da escola. O canal é Coordenação; se ele não estiver
-- configurado, private.tenant_notice_destination cai no grupo da Gestão.

create or replace function private.enqueue_teacher_change_group_notice(
  p_tenant text,
  p_teacher uuid,
  p_student uuid,
  p_change_label text,
  p_details text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_teacher_name text;
  v_student_name text;
  v_group text;
  v_event_id uuid := extensions.gen_random_uuid();
  v_notification_id uuid;
  v_message text;
begin
  if auth.uid() is null or auth.uid() is distinct from p_teacher then
    raise exception using errcode = '42501', message = 'teacher_change_actor_required';
  end if;
  if coalesce(length(btrim(p_change_label)), 0) not between 3 and 120
     or coalesce(length(btrim(p_details)), 0) not between 3 and 1000 then
    raise exception using errcode = '22023', message = 'teacher_change_notice_invalid';
  end if;

  select teacher.full_name
    into v_teacher_name
    from public.profiles as teacher
    join public.tenant_memberships as membership
      on membership.user_id = teacher.id
     and membership.tenant_id = teacher.tenant_id
     and membership.role = 'TEACHER'
     and membership.status = 'ACTIVE'
   where teacher.id = p_teacher
     and teacher.tenant_id = p_tenant
     and teacher.role = 'TEACHER'
     and lower(coalesce(teacher.lifecycle_status, 'active')) = 'active';
  if not found then
    raise exception using errcode = '42501', message = 'teacher_change_actor_required';
  end if;

  if p_student is not null then
    select student.full_name
      into v_student_name
      from public.profiles as student
     where student.id = p_student
       and student.tenant_id = p_tenant
       and student.role = 'STUDENT';
    if not found then
      raise exception using errcode = '42501', message = 'teacher_change_student_required';
    end if;
  end if;

  v_group := private.tenant_notice_destination(p_tenant, 'coordenacao');
  if v_group is null then
    raise exception using errcode = '55000',
      message = 'Configure o grupo de Coordenação ou Gestão antes de salvar esta mudança.';
  end if;

  v_message := format(
    E'📣 *ALTERAÇÃO FEITA POR PROFESSOR*\n\n👨‍🏫 Professor(a): *%s*%s\n🔁 Tipo: *%s*\n📝 %s\n\n_Registrado automaticamente pela plataforma._',
    v_teacher_name,
    case when v_student_name is null then '' else E'\n👤 Aluno(a): *' || v_student_name || '*' end,
    btrim(p_change_label),
    btrim(p_details)
  );

  insert into public.notification_queue(
    tenant_id, teacher_id, student_id, student_name, student_phone,
    message_body, scheduled_for, status, source_id, source_type,
    notification_kind, idempotency_key
  ) values (
    p_tenant, p_teacher, p_student, v_student_name, v_group,
    v_message, now(), 'pending', v_event_id, 'TEACHER_CHANGE',
    'TEACHER_CHANGE_GROUP', 'teacher-change-group:' || v_event_id::text
  ) returning id into v_notification_id;

  return v_notification_id;
end;
$function$;

alter function private.enqueue_teacher_change_group_notice(text, uuid, uuid, text, text)
  owner to postgres;
revoke all on function private.enqueue_teacher_change_group_notice(text, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.enqueue_teacher_change_group_notice(text, uuid, uuid, text, text)
  to postgres;

-- Preserva a implementação consolidada e coloca um envelope que compara o
-- antes/depois. O WhatsApp recebe somente nomes de campos; notas pedagógicas,
-- telefone e demais valores privados nunca saem do banco.
do $preserve_student_profile_update$
declare
  v_definition text;
begin
  if to_regprocedure('private.update_student_pedagogical_profile_before_teacher_notice(uuid,jsonb)') is null then
    select pg_get_functiondef('public.update_student_pedagogical_profile(uuid,jsonb)'::regprocedure)
      into v_definition;
    v_definition := replace(
      v_definition,
      'FUNCTION public.update_student_pedagogical_profile(',
      'FUNCTION private.update_student_pedagogical_profile_before_teacher_notice('
    );
    execute v_definition;
  end if;
end;
$preserve_student_profile_update$;

alter function private.update_student_pedagogical_profile_before_teacher_notice(uuid, jsonb)
  owner to postgres;
revoke all on function private.update_student_pedagogical_profile_before_teacher_notice(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.update_student_pedagogical_profile_before_teacher_notice(uuid, jsonb)
  to postgres;

create or replace function public.update_student_pedagogical_profile(
  p_student_id uuid,
  p_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_role text := public._my_role();
  v_before public.profiles%rowtype;
  v_after public.profiles%rowtype;
  v_result jsonb;
  v_effective_data jsonb := p_data;
  v_fields text[] := '{}';
  v_notice uuid;
  v_previous_notice_guard text := current_setting('app.teacher_profile_notice_wrapped', true);
begin
  select * into v_before from public.profiles where id = p_student_id;
  if v_role = 'TEACHER' then
    v_effective_data := v_effective_data - 'status' - 'status_reason';
  end if;
  perform set_config('app.teacher_profile_notice_wrapped', '1', true);
  v_result := private.update_student_pedagogical_profile_before_teacher_notice(p_student_id, v_effective_data);
  perform set_config('app.teacher_profile_notice_wrapped', coalesce(v_previous_notice_guard, ''), true);
  select * into v_after from public.profiles where id = p_student_id;

  if v_role = 'TEACHER' then
    if v_before.full_name is distinct from v_after.full_name then v_fields := array_append(v_fields, 'nome'); end if;
    if v_before.phone is distinct from v_after.phone then v_fields := array_append(v_fields, 'telefone'); end if;
    if v_before.attendance_phone is distinct from v_after.attendance_phone then v_fields := array_append(v_fields, 'contato de presença'); end if;
    if v_before.meeting_link is distinct from v_after.meeting_link then v_fields := array_append(v_fields, 'link da aula'); end if;
    if v_before.occupation is distinct from v_after.occupation then v_fields := array_append(v_fields, 'ocupação'); end if;
    if v_before.interests is distinct from v_after.interests then v_fields := array_append(v_fields, 'interesses'); end if;
    if v_before.private_notes is distinct from v_after.private_notes then v_fields := array_append(v_fields, 'notas pedagógicas'); end if;
    if v_before.fixed_schedule is distinct from v_after.fixed_schedule then v_fields := array_append(v_fields, 'descrição da agenda'); end if;
    if v_before.is_kids is distinct from v_after.is_kids then v_fields := array_append(v_fields, 'classificação infantil'); end if;
    if v_before.status is distinct from v_after.status
       or v_before.lifecycle_status is distinct from v_after.lifecycle_status then
      v_fields := array_append(v_fields, 'status acadêmico');
    end if;
    if v_before.module is distinct from v_after.module then v_fields := array_append(v_fields, 'nível pedagógico'); end if;

    if coalesce(array_length(v_fields, 1), 0) > 0 then
      v_notice := private.enqueue_teacher_change_group_notice(
        v_after.tenant_id, v_actor, p_student_id, 'Perfil pedagógico do aluno',
        'Campos alterados: ' || array_to_string(v_fields, ', ') || '.'
      );
    end if;
  end if;

  return v_result || jsonb_build_object('group_notification_id', v_notice);
end;
$function$;

alter function public.update_student_pedagogical_profile(uuid, jsonb) owner to postgres;
revoke all on function public.update_student_pedagogical_profile(uuid, jsonb)
  from public, anon;
grant execute on function public.update_student_pedagogical_profile(uuid, jsonb)
  to authenticated;

-- Alguns editores pedagógicos legados ainda gravam diretamente em profiles ou
-- chamam as RPCs específicas de nível/status. O gatilho cobre esses caminhos.
-- O envelope acima liga uma guarda temporária para consolidar suas possíveis
-- três atualizações em um único aviso.
create or replace function private.notify_teacher_student_profile_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_keys text[] := array[
    'full_name', 'phone', 'attendance_phone', 'meeting_link', 'occupation',
    'interests', 'private_notes', 'fixed_schedule', 'is_kids', 'status',
    'lifecycle_status', 'module', 'english_for', 'student_category',
    'learning_objective', 'personality', 'preferred_topics', 'avoided_topics',
    'short_term_goal', 'long_term_goal', 'current_book_part',
    'evaluation_unlocked', 'unlocked_tests'
  ];
  v_labels text[] := array[
    'nome', 'telefone', 'contato de presença', 'link da aula', 'ocupação',
    'interesses', 'notas pedagógicas', 'descrição da agenda',
    'classificação infantil', 'status acadêmico', 'situação acadêmica',
    'nível pedagógico', 'objetivo de inglês', 'categoria do aluno',
    'objetivo de aprendizagem', 'perfil de aprendizagem', 'temas preferidos',
    'temas evitados', 'meta de curto prazo', 'meta de longo prazo',
    'etapa do material', 'liberação de avaliação', 'avaliações liberadas'
  ];
  v_before jsonb := to_jsonb(old);
  v_after jsonb := to_jsonb(new);
  v_fields text[] := '{}';
  v_index integer;
begin
  if new.role <> 'STUDENT'
     or auth.uid() is null
     or public._my_role() <> 'TEACHER'
     or coalesce(current_setting('app.teacher_profile_notice_wrapped', true), '') = '1' then
    return new;
  end if;

  for v_index in 1..array_length(v_keys, 1) loop
    if v_before -> v_keys[v_index] is distinct from v_after -> v_keys[v_index] then
      v_fields := array_append(v_fields, v_labels[v_index]);
    end if;
  end loop;

  if coalesce(array_length(v_fields, 1), 0) > 0 then
    perform private.enqueue_teacher_change_group_notice(
      new.tenant_id, auth.uid(), new.id, 'Perfil pedagógico do aluno',
      'Campos alterados: ' || array_to_string(v_fields, ', ') || '.'
    );
  end if;
  return new;
end;
$function$;

alter function private.notify_teacher_student_profile_update() owner to postgres;
revoke all on function private.notify_teacher_student_profile_update()
  from public, anon, authenticated, service_role;

drop trigger if exists notify_teacher_student_profile_update on public.profiles;
create trigger notify_teacher_student_profile_update
after update on public.profiles
for each row execute function private.notify_teacher_student_profile_update();

-- Solicitação avulsa ainda depende de família/escola, mas a Coordenação deve
-- saber imediatamente que o professor a iniciou.
create or replace function private.notify_teacher_schedule_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
begin
  select role into v_role from public.profiles where id = new.requested_by;
  if new.status = 'PENDING_FAMILY' and v_role = 'TEACHER' then
    perform private.enqueue_teacher_change_group_notice(
      new.tenant_id,
      new.requested_by,
      new.student_id,
      case when new.scope = 'ONE_OFF' then 'Solicitação de troca de uma aula' else 'Solicitação de troca de horário' end,
      format(
        'De %s %s para %s %s; vigência/data original: %s. Motivo registrado na plataforma.',
        new.old_day, left(new.old_time, 5), new.new_day, left(new.new_time, 5),
        to_char(coalesce(new.original_date, new.effective_from), 'DD/MM/YYYY')
      )
    );
  end if;
  return new;
end;
$function$;

alter function private.notify_teacher_schedule_request() owner to postgres;
revoke all on function private.notify_teacher_schedule_request()
  from public, anon, authenticated, service_role;

drop trigger if exists notify_teacher_schedule_request on public.schedule_change_requests;
create trigger notify_teacher_schedule_request
after insert on public.schedule_change_requests
for each row execute function private.notify_teacher_schedule_request();

-- Publicação da própria disponibilidade também é uma mudança operacional do
-- professor. A função passa a validar autorização explicitamente antes de
-- operar como definidora, mantendo o fluxo de gestão e o service_role.
create or replace function public.replace_teacher_availability(
  p_teacher_id uuid,
  p_slots jsonb default '[]'::jsonb
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
  v_before jsonb;
  v_after jsonb;
  v_inserted integer := 0;
  v_notice uuid;
  v_service boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
begin
  if p_teacher_id is null then
    raise exception 'Professor é obrigatório.' using errcode = '22023';
  end if;
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' then
    raise exception 'A disponibilidade deve ser uma lista.' using errcode = '22023';
  end if;

  select profile.tenant_id into v_tenant
    from public.profiles as profile
    join public.tenant_memberships as membership
      on membership.user_id = profile.id
     and membership.tenant_id = profile.tenant_id
     and membership.role = 'TEACHER'
     and membership.status = 'ACTIVE'
   where profile.id = p_teacher_id
     and profile.role = 'TEACHER'
     and lower(coalesce(profile.lifecycle_status, 'active')) = 'active';
  if not found then
    raise exception 'Professor não encontrado.' using errcode = 'P0002';
  end if;
  if not v_service and not (
    (v_actor_role = 'TEACHER' and v_actor = p_teacher_id and public._my_tenant_id() = v_tenant)
    or private.quality_school_manager(v_tenant)
  ) then
    raise exception using errcode = '42501', message = 'Sem permissão para alterar esta disponibilidade.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_slots) as slot(value)
     where jsonb_typeof(slot.value) <> 'object'
        or not (slot.value ? 'day_of_week') or not (slot.value ? 'start_time')
        or coalesce(slot.value ->> 'day_of_week', '') !~ '^[0-6]$'
        or coalesce(slot.value ->> 'start_time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or (slot.value ? 'end_time' and nullif(slot.value ->> 'end_time', '') is not null
          and (slot.value ->> 'end_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  ) then
    raise exception 'Há um horário inválido na disponibilidade.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('day_of_week', day_of_week, 'start_time', start_time, 'end_time', end_time)
    order by day_of_week, start_time), '[]'::jsonb)
    into v_before from public.teacher_availability where teacher_id = p_teacher_id;

  delete from public.teacher_availability where teacher_id = p_teacher_id;
  insert into public.teacher_availability(teacher_id, tenant_id, day_of_week, start_time, end_time)
  select p_teacher_id, v_tenant, parsed.day_of_week, parsed.start_time, parsed.end_time
    from (
      select distinct (slot.value ->> 'day_of_week')::integer as day_of_week,
        (slot.value ->> 'start_time')::time as start_time,
        nullif(slot.value ->> 'end_time', '')::time as end_time
      from jsonb_array_elements(p_slots) as slot(value)
    ) as parsed;
  get diagnostics v_inserted = row_count;

  select coalesce(jsonb_agg(jsonb_build_object('day_of_week', day_of_week, 'start_time', start_time, 'end_time', end_time)
    order by day_of_week, start_time), '[]'::jsonb)
    into v_after from public.teacher_availability where teacher_id = p_teacher_id;

  if v_actor_role = 'TEACHER' and v_before is distinct from v_after then
    v_notice := private.enqueue_teacher_change_group_notice(
      v_tenant, v_actor, null, 'Disponibilidade semanal',
      format('Nova grade publicada com %s horário(s).', v_inserted)
    );
  end if;

  return jsonb_build_object('ok', true, 'teacherId', p_teacher_id,
    'publishedSlots', v_inserted, 'group_notification_id', v_notice);
end;
$function$;

alter function public.replace_teacher_availability(uuid, jsonb) owner to postgres;
revoke all on function public.replace_teacher_availability(uuid, jsonb)
  from public, anon;
grant execute on function public.replace_teacher_availability(uuid, jsonb)
  to authenticated, service_role;

notify pgrst, 'reload schema';
