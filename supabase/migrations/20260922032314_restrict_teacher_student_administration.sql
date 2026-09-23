-- Professores cuidam da pedagogia e da agenda dos próprios alunos. Pausar,
-- reativar, encerrar ou alterar o estado financeiro é decisão da gestão.

create or replace function public.set_student_academic_status(
  p_student_id uuid,
  p_status text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor record;
  v_student record;
  v_clean_status text := pg_catalog.btrim(coalesce(p_status, ''));
  v_target_status text;
  v_target_lifecycle text;
begin
  if v_actor_id is null or p_student_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if pg_catalog.lower(v_clean_status) in ('ativo', 'active') then
    v_target_status := 'Ativo'; v_target_lifecycle := 'active';
  elsif pg_catalog.lower(v_clean_status) in ('inativo', 'inactive', 'pausado', 'suspended', 'pausa temporária', 'trancado', 'locked') then
    v_target_status := 'Inativo'; v_target_lifecycle := 'suspended';
  else
    raise exception using errcode = '22023', message = 'invalid_student_status';
  end if;

  select profile.role, profile.tenant_id into v_actor
  from public.profiles profile where profile.id = v_actor_id;
  if not found or v_actor.role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') then
    raise exception using errcode = '42501', message = 'student_status_requires_management';
  end if;

  select profile.id, profile.role, profile.tenant_id, profile.status, profile.lifecycle_status
  into v_student from public.profiles profile where profile.id = p_student_id for update;
  if not found or v_student.role <> 'STUDENT' or v_student.tenant_id is null then
    raise exception using errcode = '42501', message = 'student_not_found';
  end if;
  if v_actor.role <> 'SUPER_ADMIN'
     and (v_actor.tenant_id is null or v_actor.tenant_id <> v_student.tenant_id) then
    raise exception using errcode = '42501', message = 'student_not_available';
  end if;

  if v_target_lifecycle = 'suspended' then
    update public.bookings set status = 'CANCELLED'
    where student_id = p_student_id and tenant_id = v_student.tenant_id
      and status in ('SCHEDULED', 'scheduled') and start_date >= current_date;
  end if;
  update public.profiles set status = v_target_status, lifecycle_status = v_target_lifecycle
  where id = p_student_id;

  return pg_catalog.jsonb_build_object('studentId',p_student_id,'status',v_target_status,
    'lifecycleStatus',v_target_lifecycle,'updatedBy',v_actor_id,'actorRole',v_actor.role);
end;
$function$;

alter function public.set_student_academic_status(uuid,text,text) owner to postgres;
revoke all on function public.set_student_academic_status(uuid,text,text) from public,anon;
grant execute on function public.set_student_academic_status(uuid,text,text) to authenticated;

-- Mesmo que um cliente antigo ainda envie `status` junto dos campos
-- pedagógicos, o valor é descartado para professor sem impedir o restante.
create or replace function public.update_student_pedagogical_profile(p_student_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_actor uuid := auth.uid(); v_role text := public._my_role();
  v_before public.profiles%rowtype; v_after public.profiles%rowtype;
  v_result jsonb; v_effective_data jsonb := p_data; v_fields text[] := '{}';
  v_notice uuid; v_previous_notice_guard text := current_setting('app.teacher_profile_notice_wrapped',true);
begin
  select * into v_before from public.profiles where id=p_student_id;
  if v_role='TEACHER' then v_effective_data := v_effective_data-'status'-'status_reason'; end if;
  perform set_config('app.teacher_profile_notice_wrapped','1',true);
  v_result := private.update_student_pedagogical_profile_before_teacher_notice(p_student_id,v_effective_data);
  perform set_config('app.teacher_profile_notice_wrapped',coalesce(v_previous_notice_guard,''),true);
  select * into v_after from public.profiles where id=p_student_id;
  if v_role='TEACHER' then
    if v_before.full_name is distinct from v_after.full_name then v_fields:=array_append(v_fields,'nome'); end if;
    if v_before.phone is distinct from v_after.phone then v_fields:=array_append(v_fields,'telefone'); end if;
    if v_before.attendance_phone is distinct from v_after.attendance_phone then v_fields:=array_append(v_fields,'contato de presença'); end if;
    if v_before.meeting_link is distinct from v_after.meeting_link then v_fields:=array_append(v_fields,'link da aula'); end if;
    if v_before.occupation is distinct from v_after.occupation then v_fields:=array_append(v_fields,'ocupação'); end if;
    if v_before.interests is distinct from v_after.interests then v_fields:=array_append(v_fields,'interesses'); end if;
    if v_before.private_notes is distinct from v_after.private_notes then v_fields:=array_append(v_fields,'notas pedagógicas'); end if;
    if v_before.fixed_schedule is distinct from v_after.fixed_schedule then v_fields:=array_append(v_fields,'descrição da agenda'); end if;
    if v_before.is_kids is distinct from v_after.is_kids then v_fields:=array_append(v_fields,'classificação infantil'); end if;
    if v_before.module is distinct from v_after.module then v_fields:=array_append(v_fields,'nível pedagógico'); end if;
    if coalesce(array_length(v_fields,1),0)>0 then
      v_notice:=private.enqueue_teacher_change_group_notice(v_after.tenant_id,v_actor,p_student_id,
        'Perfil pedagógico do aluno','Campos alterados: '||array_to_string(v_fields,', ')||'.');
    end if;
  end if;
  return v_result||jsonb_build_object('group_notification_id',v_notice);
end;
$function$;
alter function public.update_student_pedagogical_profile(uuid,jsonb) owner to postgres;
revoke all on function public.update_student_pedagogical_profile(uuid,jsonb) from public,anon;
grant execute on function public.update_student_pedagogical_profile(uuid,jsonb) to authenticated;

-- Defesa adicional para clientes que tentem PATCH direto em profiles.
create or replace function private.guard_teacher_student_administration()
returns trigger language plpgsql security definer set search_path='' as $function$
declare v_actor uuid:=auth.uid(); v_role text;
begin
  if v_actor is null then return new; end if;
  select role into v_role from public.profiles where id=v_actor;
  if v_role='TEACHER' and old.role='STUDENT' and old.id<>v_actor and (
    new.status is distinct from old.status
    or new.lifecycle_status is distinct from old.lifecycle_status
    or new.status_financial is distinct from old.status_financial
    or new.professor_id is distinct from old.professor_id
  ) then
    raise exception using errcode='42501',message='student_administration_requires_management';
  end if;
  return new;
end;
$function$;
alter function private.guard_teacher_student_administration() owner to postgres;
revoke all on function private.guard_teacher_student_administration() from public,anon,authenticated,service_role;
drop trigger if exists guard_teacher_student_administration on public.profiles;
create trigger guard_teacher_student_administration before update on public.profiles
for each row execute function private.guard_teacher_student_administration();

notify pgrst,'reload schema';
