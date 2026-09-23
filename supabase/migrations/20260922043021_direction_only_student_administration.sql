-- Student lifecycle and teacher assignment belong exclusively to Direction.
-- Coordinators keep operational/pedagogical access but cannot perform these
-- administrative transitions.
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
    v_target_status := 'Ativo';
    v_target_lifecycle := 'active';
  elsif pg_catalog.lower(v_clean_status) in (
    'inativo', 'inactive', 'pausado', 'suspended',
    'pausa temporária', 'trancado', 'locked'
  ) then
    v_target_status := 'Inativo';
    v_target_lifecycle := 'suspended';
  else
    raise exception using errcode = '22023', message = 'invalid_student_status';
  end if;

  select profile.role, profile.tenant_id
  into v_actor
  from public.profiles as profile
  where profile.id = v_actor_id;

  if not found or v_actor.role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'student_status_requires_direction';
  end if;

  select profile.id, profile.role, profile.tenant_id,
         profile.status, profile.lifecycle_status
  into v_student
  from public.profiles as profile
  where profile.id = p_student_id
  for update;

  if not found or v_student.role <> 'STUDENT' or v_student.tenant_id is null then
    raise exception using errcode = '42501', message = 'student_not_found';
  end if;
  if v_actor.role <> 'SUPER_ADMIN'
     and (v_actor.tenant_id is null or v_actor.tenant_id <> v_student.tenant_id) then
    raise exception using errcode = '42501', message = 'student_not_available';
  end if;

  if v_target_lifecycle = 'suspended' then
    update public.bookings
    set status = 'CANCELLED'
    where student_id = p_student_id
      and tenant_id = v_student.tenant_id
      and status in ('SCHEDULED', 'scheduled')
      and start_date >= current_date;
  end if;

  update public.profiles
  set status = v_target_status,
      lifecycle_status = v_target_lifecycle
  where id = p_student_id;

  return pg_catalog.jsonb_build_object(
    'studentId', p_student_id,
    'status', v_target_status,
    'lifecycleStatus', v_target_lifecycle,
    'updatedBy', v_actor_id,
    'actorRole', v_actor.role
  );
end;
$function$;

alter function public.set_student_academic_status(uuid, text, text) owner to postgres;
revoke all on function public.set_student_academic_status(uuid, text, text) from public, anon;
grant execute on function public.set_student_academic_status(uuid, text, text) to authenticated;

create or replace function private.guard_teacher_student_administration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_role text;
begin
  if v_actor is null then
    return new;
  end if;

  select profile.role into v_role
  from public.profiles as profile
  where profile.id = v_actor;

  if coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
     and old.role = 'STUDENT'
     and old.id <> v_actor
     and (
       new.status is distinct from old.status
       or new.lifecycle_status is distinct from old.lifecycle_status
       or new.status_financial is distinct from old.status_financial
       or new.professor_id is distinct from old.professor_id
       or new.professor_id2 is distinct from old.professor_id2
       or new.role is distinct from old.role
       or new.tenant_id is distinct from old.tenant_id
     ) then
    raise exception using
      errcode = '42501',
      message = 'student_administration_requires_direction';
  end if;

  return new;
end;
$function$;

revoke all on function private.guard_teacher_student_administration()
from public, anon, authenticated, service_role;

create or replace function private.guard_teacher_booking_participants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
begin
  if auth.uid() is null then
    return new;
  end if;

  select profile.role into v_role
  from public.profiles as profile
  where profile.id = auth.uid();

  if coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
     and (
       new.tenant_id is distinct from old.tenant_id
       or new.teacher_id is distinct from old.teacher_id
       or new.student_id is distinct from old.student_id
     ) then
    raise exception using
      errcode = '42501',
      message = 'booking_participants_require_direction';
  end if;

  return new;
end;
$function$;

revoke all on function private.guard_teacher_booking_participants()
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
