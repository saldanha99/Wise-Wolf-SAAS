-- Only management may alter the student/teacher relationship. Teachers retain
-- the ability to edit pedagogical data and the time/day of their own lessons.
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

  if v_role = 'TEACHER'
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
      message = 'student_administration_requires_management';
  end if;

  return new;
end;
$function$;

revoke all on function private.guard_teacher_student_administration()
from public, anon, authenticated, service_role;

-- The legacy opportunity board used to execute a definitive transfer in the
-- teacher's session. Keep the function available only to trusted server code.
revoke execute on function public.claim_student_opportunity(uuid)
from public, anon, authenticated;

drop policy if exists bookings_write on public.bookings;
create policy bookings_write
on public.bookings
for all
to authenticated
using (
  tenant_id = public._my_tenant_id()
  and (
    public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR')
    or (
      public._my_role() = 'TEACHER'
      and teacher_id = (select auth.uid())
      and public._teacher_can_access_student(student_id, tenant_id)
    )
  )
)
with check (
  tenant_id = public._my_tenant_id()
  and (
    public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR')
    or (
      public._my_role() = 'TEACHER'
      and teacher_id = (select auth.uid())
      and public._teacher_can_access_student(student_id, tenant_id)
    )
  )
);

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

  if v_role = 'TEACHER'
     and (
       new.tenant_id is distinct from old.tenant_id
       or new.teacher_id is distinct from old.teacher_id
       or new.student_id is distinct from old.student_id
     ) then
    raise exception using
      errcode = '42501',
      message = 'booking_participants_require_management';
  end if;

  return new;
end;
$function$;

revoke all on function private.guard_teacher_booking_participants()
from public, anon, authenticated, service_role;

drop trigger if exists guard_teacher_booking_participants on public.bookings;
create trigger guard_teacher_booking_participants
before update of tenant_id, teacher_id, student_id
on public.bookings
for each row
execute function private.guard_teacher_booking_participants();

notify pgrst, 'reload schema';
